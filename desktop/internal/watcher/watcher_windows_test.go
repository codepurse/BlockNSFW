//go:build windows

package watcher

import (
	"testing"
	"time"
)

// TestStopUnblocksRun exercises the real Windows syscalls (CreateEvent,
// RegNotifyChangeKeyValue, WaitForMultipleObjects, SetEvent) and verifies that
// Stop cleanly unblocks Run. It only reads HKLM\SOFTWARE\Policies, so it needs
// no administrator rights.
func TestStopUnblocksRun(t *testing.T) {
	w, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- w.Run(func() {}) }()

	time.Sleep(150 * time.Millisecond) // let Run arm the notification
	w.Stop()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned error after Stop: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return within 3s of Stop")
	}
}
