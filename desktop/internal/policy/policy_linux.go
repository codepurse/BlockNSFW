//go:build linux

package policy

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// chromiumManagedDir maps each Chromium browser to its "managed" policy
// directory. Chromium reads every JSON file dropped there and merges them, so we
// own a single file (policyFileName) and never disturb other policy files.
var chromiumManagedDir = map[Kind]string{
	Chrome: "/etc/opt/chrome/policies/managed",
	Edge:   "/etc/opt/edge/policies/managed",
	Brave:  "/etc/brave/policies/managed",
}

const (
	policyFileName = "blocknsfw.json"
	forcelistKey   = "ExtensionInstallForcelist"

	// Firefox reads a single policies.json; we merge our ExtensionSettings entry
	// into it so any pre-existing Firefox policies survive.
	firefoxPoliciesDir  = "/etc/firefox/policies"
	firefoxPoliciesFile = "policies.json"
)

// linuxBrowserBins maps each browser to the executables that indicate it is
// installed (looked up on PATH; snap/flatpak browsers expose these names too).
var linuxBrowserBins = map[Kind][]string{
	Chrome:  {"google-chrome", "google-chrome-stable"},
	Edge:    {"microsoft-edge", "microsoft-edge-stable"},
	Brave:   {"brave-browser", "brave"},
	Firefox: {"firefox", "firefox-esr"},
}

// Apply writes the force-install policy for every configured browser. Writing
// for a browser that isn't installed is harmless. Requires root.
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
	dir := chromiumManagedDir[k]
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	doc := map[string]any{forcelistKey: []string{val}}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, policyFileName), data, 0o644)
}

func applyFirefox(t Target) error {
	if !firefoxConfigured(t) {
		return nil // not configured - skip quietly
	}
	if err := os.MkdirAll(firefoxPoliciesDir, 0o755); err != nil {
		return err
	}
	doc := readFirefoxDoc()
	extSettings := childMap(childMap(doc, "policies"), "ExtensionSettings")
	extSettings[t.AddonID] = map[string]any{
		"installation_mode": "force_installed",
		"install_url":       t.InstallURL,
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(firefoxPoliciesPath(), data, 0o644)
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
	data, err := os.ReadFile(filepath.Join(chromiumManagedDir[k], policyFileName))
	if err != nil {
		return s // file absent -> not locked
	}
	var doc struct {
		Forcelist []string `json:"ExtensionInstallForcelist"`
	}
	if json.Unmarshal(data, &doc) != nil {
		s.Detail = "tampered"
		return s
	}
	for _, v := range doc.Forcelist {
		if v == want {
			s.Locked, s.Detail = true, "ok"
			return s
		}
	}
	s.Detail = "tampered"
	return s
}

func verifyFirefox(t Target, installed bool) Status {
	s := Status{Kind: Firefox, Installed: installed, Detail: "missing"}
	if !firefoxConfigured(t) {
		s.Detail = "not configured"
		return s
	}
	data, err := os.ReadFile(firefoxPoliciesPath())
	if err != nil {
		return s
	}
	var doc struct {
		Policies struct {
			ExtensionSettings map[string]struct {
				InstallationMode string `json:"installation_mode"`
				InstallURL       string `json:"install_url"`
			} `json:"ExtensionSettings"`
		} `json:"policies"`
	}
	if json.Unmarshal(data, &doc) != nil {
		s.Detail = "tampered"
		return s
	}
	if e, ok := doc.Policies.ExtensionSettings[t.AddonID]; ok &&
		e.InstallationMode == "force_installed" && e.InstallURL == t.InstallURL {
		s.Locked, s.Detail = true, "ok"
	} else {
		s.Detail = "tampered"
	}
	return s
}

// Remove deletes the force-install policy for the configured extension.
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
	if err := os.Remove(filepath.Join(chromiumManagedDir[k], policyFileName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func removeFirefox(t Target) error {
	if t.AddonID == "" {
		return nil
	}
	data, err := os.ReadFile(firefoxPoliciesPath())
	if err != nil {
		return nil // nothing to remove
	}
	var doc map[string]any
	if json.Unmarshal(data, &doc) != nil {
		return nil
	}
	policies, _ := doc["policies"].(map[string]any)
	if policies == nil {
		return nil
	}
	ext, _ := policies["ExtensionSettings"].(map[string]any)
	if ext == nil {
		return nil
	}
	delete(ext, t.AddonID)
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(firefoxPoliciesPath(), out, 0o644)
}

// DetectBrowsers reports which supported browsers are installed (via PATH).
func DetectBrowsers() map[Kind]bool {
	out := make(map[Kind]bool, len(linuxBrowserBins))
	for _, k := range []Kind{Chrome, Edge, Brave, Firefox} {
		out[k] = false
		for _, bin := range linuxBrowserBins[k] {
			if _, err := exec.LookPath(bin); err == nil {
				out[k] = true
				break
			}
		}
	}
	return out
}

func firefoxPoliciesPath() string { return filepath.Join(firefoxPoliciesDir, firefoxPoliciesFile) }

// readFirefoxDoc loads the existing policies.json as a generic document, or
// returns an empty one so Apply can merge into it without clobbering other keys.
func readFirefoxDoc() map[string]any {
	data, err := os.ReadFile(firefoxPoliciesPath())
	if err != nil {
		return map[string]any{}
	}
	var doc map[string]any
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return map[string]any{}
	}
	return doc
}

// childMap returns parent[key] as a map, creating it if absent or the wrong type.
func childMap(parent map[string]any, key string) map[string]any {
	if m, ok := parent[key].(map[string]any); ok {
		return m
	}
	m := map[string]any{}
	parent[key] = m
	return m
}
