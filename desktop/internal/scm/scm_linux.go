//go:build linux

// Package scm's Linux implementation replaces the Windows Service Control
// Manager + registry with systemd (via systemctl) and a root-owned JSON state
// file. The guard's persistent state - the "disabled" teardown sentinel and the
// uninstall password hash - lives in that file instead of the registry.
package scm

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	stateDir  = "/etc/blocknsfw"
	stateFile = "state.json"
	unitDir   = "/etc/systemd/system"
)

type state struct {
	GuardDisabled bool   `json:"guardDisabled"`
	PasswordHash  string `json:"passwordHash"`
}

func statePath() string { return filepath.Join(stateDir, stateFile) }

func loadState() state {
	var s state
	if data, err := os.ReadFile(statePath()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func saveState(s state) error {
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(statePath(), data, 0o600)
}

func unitPath(name string) string { return filepath.Join(unitDir, name+".service") }

// Harden ensures the service starts at boot. Auto-restart on failure is set in
// the unit at install time (Restart=always, via the guardsvc service options);
// enabling here covers boot start. Safe to call repeatedly.
func Harden(name string) error {
	return exec.Command("systemctl", "enable", name+".service").Run()
}

// EnsureRunning enables the service and starts it if it is not already active.
// It returns "restarted" if it had to start it, otherwise "ok".
func EnsureRunning(name string) (string, error) {
	_ = exec.Command("systemctl", "enable", name+".service").Run()
	if IsRunning(name) {
		return "ok", nil
	}
	if err := exec.Command("systemctl", "start", name+".service").Run(); err != nil {
		return "", err
	}
	return "restarted", nil
}

// IsRunning reports whether the systemd unit is currently active. It works for
// an unprivileged caller, so the status UI can use it.
func IsRunning(name string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", name+".service").Run() == nil
}

// Exists reports whether the systemd unit file is installed.
func Exists(name string) bool {
	_, err := os.Stat(unitPath(name))
	return err == nil
}

// SetDisabled writes the teardown sentinel; IsDisabled reads it.
func SetDisabled(v bool) error {
	s := loadState()
	s.GuardDisabled = v
	return saveState(s)
}

// IsDisabled reports whether the disabled sentinel is set.
func IsDisabled() bool { return loadState().GuardDisabled }

// SetPasswordHash stores the bcrypt hash of the uninstall password.
func SetPasswordHash(hash string) error {
	s := loadState()
	s.PasswordHash = hash
	return saveState(s)
}

// GetPasswordHash returns the stored hash and whether one is set.
func GetPasswordHash() (string, bool) {
	if h := loadState().PasswordHash; h != "" {
		return h, true
	}
	return "", false
}

// ClearPasswordHash removes the stored hash (after a verified uninstall).
func ClearPasswordHash() error {
	s := loadState()
	s.PasswordHash = ""
	return saveState(s)
}

// AcquireSingleton takes an advisory file lock so only one watchdog runs at a
// time. The file handle is intentionally leaked for the process lifetime; the OS
// releases the lock on exit.
func AcquireSingleton(name string) bool {
	safe := strings.NewReplacer(`\`, "-", "/", "-").Replace(name)
	path := filepath.Join(os.TempDir(), "blocknsfw-"+safe+".lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return false
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return false
	}
	return true // f intentionally leaked to hold the lock
}
