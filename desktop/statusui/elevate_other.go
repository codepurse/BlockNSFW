//go:build !windows && !linux

package main

import "errors"

// errElevationCancelled keeps the build compiling on platforms with no real
// elevation path (currently macOS). Windows and Linux have their own files.
var errElevationCancelled = errors.New("elevation cancelled")

// runElevatedAndWait is a stub where elevation isn't implemented yet.
func runElevatedAndWait(exe string, args []string) (int, error) {
	return 0, errors.New("elevation is not supported on this platform")
}
