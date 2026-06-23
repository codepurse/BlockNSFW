//go:build !windows && !linux

package policy

import "errors"

// errWindowsOnly is returned by the enforcement entry points on platforms with
// no real implementation (currently macOS). Windows and Linux have their own
// files; this stub keeps the package compiling everywhere else.
var errWindowsOnly = errors.New("policy enforcement is not supported on this platform")

// Apply is a no-op stub on non-Windows platforms.
func Apply(cfg Config) error { return errWindowsOnly }

// Remove is a no-op stub on non-Windows platforms.
func Remove(cfg Config) error { return errWindowsOnly }

// Verify returns no statuses on non-Windows platforms.
func Verify(cfg Config) []Status { return nil }

// DetectBrowsers returns an empty map on non-Windows platforms.
func DetectBrowsers() map[Kind]bool { return map[Kind]bool{} }
