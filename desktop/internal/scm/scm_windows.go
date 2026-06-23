//go:build windows

// Package scm wraps the Windows Service Control Manager operations the watchdog
// needs: hardening a service (auto-restart recovery + Automatic start),
// ensuring it is running, checking existence, a single-instance guard, and a
// "disabled" sentinel that lets an authorized teardown stop the resurrection
// loop. All write operations require administrator rights.
package scm

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	stateKeyPath  = `SOFTWARE\BlockNSFW`
	disabledValue = "GuardDisabled"
	passwordValue = "PasswordHash"
	resetPeriod   = uint32(24 * 60 * 60) // recovery failure-count reset window (seconds)
)

// Harden configures the service to auto-restart on failure and to start
// Automatically at boot. Safe to call repeatedly (the watchdog re-asserts it).
func Harden(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	restart := mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: 5 * time.Second}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{restart, restart, restart}, resetPeriod); err != nil {
		return fmt.Errorf("set recovery actions: %w", err)
	}
	return ensureAutomatic(s)
}

func ensureAutomatic(s *mgr.Service) error {
	cfg, err := s.Config()
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	if cfg.StartType != mgr.StartAutomatic {
		cfg.StartType = mgr.StartAutomatic
		if err := s.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("re-enable automatic start: %w", err)
		}
	}
	return nil
}

// EnsureRunning re-asserts Automatic start and starts the service if it is
// stopped. It returns the action taken ("ok" or "restarted").
func EnsureRunning(name string) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return "", fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	if err := ensureAutomatic(s); err != nil {
		return "", err
	}
	st, err := s.Query()
	if err != nil {
		return "", fmt.Errorf("query: %w", err)
	}
	if st.State == svc.Stopped {
		if err := s.Start(); err != nil {
			return "", fmt.Errorf("start: %w", err)
		}
		return "restarted", nil
	}
	return "ok", nil
}

// IsRunning reports whether the named service is currently running. It uses
// query-only access (SC_MANAGER_CONNECT + SERVICE_QUERY_STATUS), so it works
// without administrator rights - the status UI runs as a normal user.
func IsRunning(name string) bool {
	scmh, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return false
	}
	defer windows.CloseServiceHandle(scmh)
	np, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	svch, err := windows.OpenService(scmh, np, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return false
	}
	defer windows.CloseServiceHandle(svch)
	var st windows.SERVICE_STATUS_PROCESS
	var needed uint32
	if err := windows.QueryServiceStatusEx(svch, windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&st)), uint32(unsafe.Sizeof(st)), &needed); err != nil {
		return false
	}
	return st.CurrentState == windows.SERVICE_RUNNING
}

// Exists reports whether the named service is registered.
func Exists(name string) bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

// SetDisabled writes the sentinel that tells the watchdog to stop resurrecting
// the service (used by an authorized uninstall). IsDisabled reads it.
func SetDisabled(v bool) error { return setDisabledIn(registry.LOCAL_MACHINE, v) }

// IsDisabled reports whether the disabled sentinel is set.
func IsDisabled() bool { return isDisabledIn(registry.LOCAL_MACHINE) }

func setDisabledIn(root registry.Key, v bool) error {
	key, _, err := registry.CreateKey(root, stateKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	var d uint32
	if v {
		d = 1
	}
	return key.SetDWordValue(disabledValue, d)
}

func isDisabledIn(root registry.Key) bool {
	key, err := registry.OpenKey(root, stateKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	d, _, err := key.GetIntegerValue(disabledValue)
	return err == nil && d != 0
}

// SetPasswordHash stores the bcrypt hash of the uninstall password. GetPasswordHash
// reads it (ok=false when none is set); ClearPasswordHash removes it.
func SetPasswordHash(hash string) error { return setStringIn(registry.LOCAL_MACHINE, passwordValue, hash) }

// GetPasswordHash returns the stored hash and whether one is set.
func GetPasswordHash() (string, bool) { return getStringIn(registry.LOCAL_MACHINE, passwordValue) }

// ClearPasswordHash removes the stored hash (called after a verified uninstall).
func ClearPasswordHash() error { return deleteValueIn(registry.LOCAL_MACHINE, passwordValue) }

func setStringIn(root registry.Key, name, val string) error {
	key, _, err := registry.CreateKey(root, stateKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue(name, val)
}

func getStringIn(root registry.Key, name string) (string, bool) {
	key, err := registry.OpenKey(root, stateKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer key.Close()
	v, _, err := key.GetStringValue(name)
	if err != nil || v == "" {
		return "", false
	}
	return v, true
}

func deleteValueIn(root registry.Key, name string) error {
	key, err := registry.OpenKey(root, stateKeyPath, registry.SET_VALUE)
	if err != nil {
		return nil // key absent -> nothing to clear
	}
	defer key.Close()
	return key.DeleteValue(name)
}

var procCreateMutexW = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreateMutexW")

// AcquireSingleton creates a named mutex and reports whether this process is the
// first to hold it. It returns false if another instance already holds the name
// (so duplicate watchdogs exit). The handle is intentionally leaked for the
// process lifetime; the OS releases it on exit.
func AcquireSingleton(name string) bool {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	h, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(p)))
	if h == 0 {
		return false // creation failed; treat as "not acquired"
	}
	return callErr != syscall.Errno(windows.ERROR_ALREADY_EXISTS)
}
