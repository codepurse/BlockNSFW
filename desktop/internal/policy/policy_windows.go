//go:build windows

package policy

import (
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// chromiumPolicyRoot maps each Chromium browser to its policy registry path
// under HKLM. The force-install list lives in the ExtensionInstallForcelist
// subkey beneath it.
var chromiumPolicyRoot = map[Kind]string{
	Chrome: `SOFTWARE\Policies\Google\Chrome`,
	Edge:   `SOFTWARE\Policies\Microsoft\Edge`,
	Brave:  `SOFTWARE\Policies\BraveSoftware\Brave`,
}

const (
	forcelistSubkey   = `ExtensionInstallForcelist`
	firefoxPolicyRoot = `SOFTWARE\Policies\Mozilla\Firefox`
)

// appPathExe is the executable name used to detect each browser via the
// Windows "App Paths" registry.
var appPathExe = map[Kind]string{
	Chrome:  "chrome.exe",
	Edge:    "msedge.exe",
	Brave:   "brave.exe",
	Firefox: "firefox.exe",
}

// Apply writes the force-install policy for every browser with a complete
// target in cfg. Browsers that aren't configured (placeholders) are skipped.
// Writing keys for a browser that isn't installed yet is harmless - the lock
// simply takes effect if/when that browser appears. Requires Administrator.
func Apply(cfg Config) error {
	var errs []string
	for _, k := range ChromiumKinds {
		if err := applyChromium(k, cfg.Target(k)); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", k, err))
		}
	}
	if err := applyFirefox(cfg.Firefox); err != nil {
		errs = append(errs, fmt.Sprintf("firefox: %v", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func applyChromium(k Kind, t Target) error {
	val, err := chromiumForcelistValue(t)
	if err != nil {
		return nil // not configured - skip quietly
	}
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, chromiumPolicyRoot[k]+`\`+forcelistSubkey, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer key.Close()
	name, err := forcelistSlot(key, t.ExtensionID)
	if err != nil {
		return err
	}
	return key.SetStringValue(name, val)
}

// forcelistSlot returns the value name to write under ExtensionInstallForcelist:
// the existing slot if our extension is already listed, otherwise the next free
// numeric index (the policy uses "1", "2", ... value names).
func forcelistSlot(key registry.Key, extID string) (string, error) {
	names, err := key.ReadValueNames(-1)
	if err != nil {
		return "", err
	}
	maxIdx := 0
	for _, n := range names {
		if v, _, err := key.GetStringValue(n); err == nil && strings.HasPrefix(v, extID+";") {
			return n, nil
		}
		if i, err := strconv.Atoi(n); err == nil && i > maxIdx {
			maxIdx = i
		}
	}
	return strconv.Itoa(maxIdx + 1), nil
}

func applyFirefox(t Target) error {
	if !firefoxConfigured(t) {
		return nil // not configured - skip quietly
	}
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, firefoxPolicyRoot+`\ExtensionSettings\`+t.AddonID, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer key.Close()
	if err := key.SetStringValue("installation_mode", "force_installed"); err != nil {
		return err
	}
	return key.SetStringValue("install_url", t.InstallURL)
}

// Verify reports the lock status of each configured browser.
func Verify(cfg Config) []Status {
	installed := DetectBrowsers()
	out := make([]Status, 0, len(ChromiumKinds)+1)
	for _, k := range ChromiumKinds {
		out = append(out, verifyChromium(k, cfg.Target(k), installed[k]))
	}
	out = append(out, verifyFirefox(cfg.Firefox, installed[Firefox]))
	return out
}

func verifyChromium(k Kind, t Target, installed bool) Status {
	s := Status{Kind: k, Installed: installed, Detail: "missing"}
	want, err := chromiumForcelistValue(t)
	if err != nil {
		s.Detail = "not configured"
		return s
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, chromiumPolicyRoot[k]+`\`+forcelistSubkey, registry.QUERY_VALUE)
	if err != nil {
		return s
	}
	defer key.Close()
	names, _ := key.ReadValueNames(-1)
	for _, n := range names {
		if v, _, err := key.GetStringValue(n); err == nil && v == want {
			s.Locked, s.Detail = true, "ok"
			break
		}
	}
	return s
}

func verifyFirefox(t Target, installed bool) Status {
	s := Status{Kind: Firefox, Installed: installed, Detail: "missing"}
	if !firefoxConfigured(t) {
		s.Detail = "not configured"
		return s
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, firefoxPolicyRoot+`\ExtensionSettings\`+t.AddonID, registry.QUERY_VALUE)
	if err != nil {
		return s
	}
	defer key.Close()
	mode, _, _ := key.GetStringValue("installation_mode")
	url, _, _ := key.GetStringValue("install_url")
	if mode == "force_installed" && url == t.InstallURL {
		s.Locked, s.Detail = true, "ok"
	} else {
		s.Detail = "tampered"
	}
	return s
}

// Remove deletes the force-install policy for the configured extension. It is
// used only on an authorized (password-verified) uninstall.
func Remove(cfg Config) error {
	var errs []string
	for _, k := range ChromiumKinds {
		if err := removeChromium(k, cfg.Target(k)); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", k, err))
		}
	}
	if err := removeFirefox(cfg.Firefox); err != nil {
		errs = append(errs, fmt.Sprintf("firefox: %v", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func removeChromium(k Kind, t Target) error {
	if t.ExtensionID == "" {
		return nil
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, chromiumPolicyRoot[k]+`\`+forcelistSubkey, registry.ALL_ACCESS)
	if err != nil {
		return nil // nothing to remove
	}
	defer key.Close()
	names, _ := key.ReadValueNames(-1)
	for _, n := range names {
		if v, _, err := key.GetStringValue(n); err == nil && strings.HasPrefix(v, t.ExtensionID+";") {
			if err := key.DeleteValue(n); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeFirefox(t Target) error {
	if t.AddonID == "" {
		return nil
	}
	// DeleteKey removes the leaf key (installation_mode / install_url values
	// live directly under it). Absence is treated as success.
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, firefoxPolicyRoot+`\ExtensionSettings\`+t.AddonID)
	return nil
}

// DetectBrowsers reports which supported browsers are installed, using the
// Windows "App Paths" registry (checked in both HKLM and HKCU).
func DetectBrowsers() map[Kind]bool {
	out := make(map[Kind]bool, len(appPathExe))
	for k, exe := range appPathExe {
		out[k] = appPathExists(exe)
	}
	return out
}

func appPathExists(exe string) bool {
	const base = `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		if key, err := registry.OpenKey(root, base+exe, registry.QUERY_VALUE); err == nil {
			key.Close()
			return true
		}
	}
	return false
}
