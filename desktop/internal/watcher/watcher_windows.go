//go:build windows

// Package watcher blocks until a relevant registry change occurs and then
// invokes a callback, so the guard can re-apply the force-install policy the
// moment someone tampers with it.
package watcher

import (
	"fmt"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// policiesRoot is the hive we watch. HKLM\SOFTWARE\Policies always exists, so
// our notify handle never goes stale even when a browser's policy subkey is
// deleted - which is exactly the tamper case we must catch. Any change beneath
// it triggers an (idempotent) re-apply.
const policiesRoot = `SOFTWARE\Policies`

const (
	regNotifyChangeName    = 0x00000001
	regNotifyChangeLastSet = 0x00000004
	notifyFilter           = regNotifyChangeName | regNotifyChangeLastSet
)

var procRegNotifyChangeKeyValue = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegNotifyChangeKeyValue")

// Watcher waits for registry changes and supports clean cancellation.
type Watcher struct {
	stopEvt windows.Handle
}

// New creates a Watcher with a manual-reset stop event.
func New() (*Watcher, error) {
	evt, err := windows.CreateEvent(nil, 1, 0, nil) // manual-reset, initially unset
	if err != nil {
		return nil, fmt.Errorf("create stop event: %w", err)
	}
	return &Watcher{stopEvt: evt}, nil
}

// Stop unblocks Run so it returns nil.
func (w *Watcher) Stop() {
	if w.stopEvt != 0 {
		windows.SetEvent(w.stopEvt)
	}
}

// Run watches the policy hive and calls onChange for every change until Stop is
// called. It returns nil on a clean stop or an error on failure.
func (w *Watcher) Run(onChange func()) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, policiesRoot, registry.NOTIFY)
	if err != nil {
		return fmt.Errorf("open policies key: %w", err)
	}
	defer key.Close()

	changeEvt, err := windows.CreateEvent(nil, 0, 0, nil) // auto-reset
	if err != nil {
		return fmt.Errorf("create change event: %w", err)
	}
	defer windows.CloseHandle(changeEvt)

	for {
		if err := regNotify(windows.Handle(key), changeEvt); err != nil {
			return fmt.Errorf("register notify: %w", err)
		}
		ev, err := windows.WaitForMultipleObjects([]windows.Handle{changeEvt, w.stopEvt}, false, windows.INFINITE)
		if err != nil {
			return fmt.Errorf("wait: %w", err)
		}
		switch ev {
		case windows.WAIT_OBJECT_0: // change
			onChange()
		case windows.WAIT_OBJECT_0 + 1: // stop
			return nil
		default:
			return fmt.Errorf("unexpected wait result %d", ev)
		}
	}
}

func regNotify(key, event windows.Handle) error {
	r, _, _ := procRegNotifyChangeKeyValue.Call(
		uintptr(key),
		1, // bWatchSubtree = TRUE
		uintptr(notifyFilter),
		uintptr(event),
		1, // fAsynchronous = TRUE
	)
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}
