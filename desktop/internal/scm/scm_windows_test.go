//go:build windows

package scm

import (
	"testing"

	"golang.org/x/sys/windows/registry"
)

// TestDisabledSentinelRoundTrip exercises the real registry read/write path
// against HKCU (writable without admin) rather than the production HKLM root.
func TestDisabledSentinelRoundTrip(t *testing.T) {
	root := registry.CURRENT_USER
	t.Cleanup(func() { registry.DeleteKey(root, stateKeyPath) })

	if isDisabledIn(root) {
		t.Fatal("expected sentinel unset initially")
	}
	if err := setDisabledIn(root, true); err != nil {
		t.Fatalf("set true: %v", err)
	}
	if !isDisabledIn(root) {
		t.Fatal("expected disabled after set true")
	}
	if err := setDisabledIn(root, false); err != nil {
		t.Fatalf("set false: %v", err)
	}
	if isDisabledIn(root) {
		t.Fatal("expected not disabled after set false")
	}
}

// TestAcquireSingleton verifies a second acquire of the same name fails while
// the first handle is held.
func TestAcquireSingleton(t *testing.T) {
	const name = `Local\BlockNSFWGuardWatchdogTest`
	if !AcquireSingleton(name) {
		t.Fatal("first acquire should succeed")
	}
	if AcquireSingleton(name) {
		t.Fatal("second acquire should fail while the first is held")
	}
}

// TestPasswordHashStorage exercises the real registry string read/write/delete
// path against HKCU (writable without admin) rather than the production HKLM.
func TestPasswordHashStorage(t *testing.T) {
	root := registry.CURRENT_USER
	t.Cleanup(func() { registry.DeleteKey(root, stateKeyPath) })

	if _, ok := getStringIn(root, passwordValue); ok {
		t.Fatal("expected no hash initially")
	}
	if err := setStringIn(root, passwordValue, "bcrypt$hash$value"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, ok := getStringIn(root, passwordValue)
	if !ok || got != "bcrypt$hash$value" {
		t.Fatalf("get = %q, %v", got, ok)
	}
	if err := deleteValueIn(root, passwordValue); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := getStringIn(root, passwordValue); ok {
		t.Fatal("expected no hash after delete")
	}
}
