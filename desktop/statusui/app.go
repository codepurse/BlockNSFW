package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/codepurse/BlockNSFW/desktop/internal/auth"
	"github.com/codepurse/BlockNSFW/desktop/internal/guardsvc"
	"github.com/codepurse/BlockNSFW/desktop/internal/policy"
	"github.com/codepurse/BlockNSFW/desktop/internal/scm"
)

// App is the Wails-bound backend. Its exported methods are callable from the
// frontend as window.go.main.App.<Method>().
type App struct {
	ctx     context.Context
	cfg     policy.Config
	cfgPath string
}

// Status is the snapshot the frontend renders.
type Status struct {
	ServiceRunning bool         `json:"serviceRunning"`
	Disabled       bool         `json:"disabled"`
	LockedCount    int          `json:"lockedCount"`
	HasPassword    bool         `json:"hasPassword"`
	Browsers       []BrowserRow `json:"browsers"`
}

// ActionResult is what the disable/enable methods report back to the frontend.
type ActionResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// BrowserRow is one row in the status list.
type BrowserRow struct {
	Kind      string `json:"kind"`
	Installed bool   `json:"installed"`
	Locked    bool   `json:"locked"`
	Detail    string `json:"detail"`
}

// NewApp loads the shared config so status reflects the configured extension.
// The resolved path is kept so disable/enable can hand it to the elevated guard.
func NewApp() *App {
	p := defaultConfigPath()
	cfg, _ := policy.LoadConfig(p)
	return &App{cfg: cfg, cfgPath: p}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// GetStatus returns the current protection status. Read-only and admin-free.
func (a *App) GetStatus() Status {
	verified := policy.Verify(a.cfg)
	rows := make([]BrowserRow, 0, len(verified))
	locked := 0
	for _, s := range verified {
		if s.Locked {
			locked++
		}
		rows = append(rows, BrowserRow{
			Kind:      string(s.Kind),
			Installed: s.Installed,
			Locked:    s.Locked,
			Detail:    s.Detail,
		})
	}
	_, hasPw := scm.GetPasswordHash()
	return Status{
		ServiceRunning: scm.IsRunning(guardsvc.ServiceName),
		Disabled:       scm.IsDisabled(),
		LockedCount:    locked,
		HasPassword:    hasPw,
		Browsers:       rows,
	}
}

// Disable temporarily turns protection off. Enable turns it back on. Both verify
// the password locally for instant feedback, then hand the actual work to an
// elevated guard.exe (a UAC prompt) - the binary re-verifies the password so the
// gate can't be bypassed from the renderer.
func (a *App) Disable(password string) ActionResult { return a.runGuard("disable", password) }
func (a *App) Enable(password string) ActionResult  { return a.runGuard("enable", password) }

func (a *App) runGuard(action, password string) ActionResult {
	hash, ok := scm.GetPasswordHash()
	if !ok {
		return ActionResult{Message: "No uninstall password is set. Install protection with the installer (or `guard install-service`) first."}
	}
	if !auth.Verify(hash, password) {
		return ActionResult{Message: "Incorrect password."}
	}
	guardExe, err := a.guardPath()
	if err != nil {
		return ActionResult{Message: err.Error()}
	}
	code, err := runElevatedAndWait(guardExe, []string{"-config", a.cfgPath, "-password", password, action})
	if err != nil {
		if errors.Is(err, errElevationCancelled) {
			return ActionResult{Message: "Cancelled at the Windows permission prompt."}
		}
		return ActionResult{Message: "Could not run the guard: " + err.Error()}
	}
	if code != 0 {
		return ActionResult{Message: fmt.Sprintf("The guard reported an error (exit code %d).", code)}
	}
	if action == "disable" {
		return ActionResult{OK: true, Message: "Protection disabled."}
	}
	return ActionResult{OK: true, Message: "Protection enabled."}
}

// guardPath locates guard.exe next to this status binary, where the installer
// places both.
func (a *App) guardPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	name := "guard"
	if runtime.GOOS == "windows" {
		name = "guard.exe"
	}
	p := filepath.Join(filepath.Dir(exe), name)
	if !fileExists(p) {
		return "", fmt.Errorf("%s was not found next to this app", name)
	}
	return p, nil
}

// defaultConfigPath finds shared/extension-ids.json next to the binary (where
// the installer places a copy) or by walking up from the working directory.
func defaultConfigPath() string {
	if exe, err := os.Executable(); err == nil {
		if p := filepath.Join(filepath.Dir(exe), "extension-ids.json"); fileExists(p) {
			return p
		}
	}
	if dir, err := os.Getwd(); err == nil {
		for i := 0; i < 6; i++ {
			if p := filepath.Join(dir, "shared", "extension-ids.json"); fileExists(p) {
				return p
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "extension-ids.json"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
