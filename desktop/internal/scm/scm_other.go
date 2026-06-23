//go:build !windows && !linux

package scm

import "errors"

// These stubs let the service package compile on platforms with no real
// implementation (currently macOS). Windows and Linux have their own files.
var errWindowsOnly = errors.New("service control is not supported on this platform")

// Harden is a no-op stub on non-Windows platforms.
func Harden(name string) error { return errWindowsOnly }

// EnsureRunning is a no-op stub on non-Windows platforms.
func EnsureRunning(name string) (string, error) { return "", errWindowsOnly }

// Exists reports false on non-Windows platforms.
func Exists(name string) bool { return false }

// IsRunning reports false on non-Windows platforms.
func IsRunning(name string) bool { return false }

// SetDisabled is a no-op stub on non-Windows platforms.
func SetDisabled(v bool) error { return errWindowsOnly }

// IsDisabled reports false on non-Windows platforms.
func IsDisabled() bool { return false }

// AcquireSingleton always succeeds on non-Windows platforms.
func AcquireSingleton(name string) bool { return true }

// SetPasswordHash is a no-op stub on non-Windows platforms.
func SetPasswordHash(hash string) error { return errWindowsOnly }

// GetPasswordHash reports no stored hash on non-Windows platforms.
func GetPasswordHash() (string, bool) { return "", false }

// ClearPasswordHash is a no-op stub on non-Windows platforms.
func ClearPasswordHash() error { return errWindowsOnly }
