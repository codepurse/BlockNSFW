//go:build !windows

package watcher

// Watcher is a no-op on non-Windows platforms; it exists so the service package
// compiles for development and CI on Linux/macOS.
type Watcher struct{}

// New returns an inert Watcher.
func New() (*Watcher, error) { return &Watcher{}, nil }

// Stop is a no-op.
func (w *Watcher) Stop() {}

// Run returns immediately; the periodic backstop handles re-apply elsewhere.
func (w *Watcher) Run(onChange func()) error { return nil }
