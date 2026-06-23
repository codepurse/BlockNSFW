// Package policy manages the browser "force-install" enterprise policies that
// lock the BlockNSFW extension in place so it cannot be removed from the
// browser UI. This file holds the platform-independent data model and helpers;
// the actual registry reads/writes live in policy_windows.go.
package policy

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Kind identifies a supported browser.
type Kind string

const (
	Chrome  Kind = "chrome"
	Edge    Kind = "edge"
	Brave   Kind = "brave"
	Firefox Kind = "firefox"
)

// ChromiumKinds are the Chromium-based browsers that share the
// ExtensionInstallForcelist policy mechanism.
var ChromiumKinds = []Kind{Chrome, Edge, Brave}

// Target describes what to force-install for one browser. Chromium browsers
// use ExtensionID + UpdateURL; Firefox uses AddonID + InstallURL.
type Target struct {
	ExtensionID string `json:"extensionId,omitempty"`
	UpdateURL   string `json:"updateUrl,omitempty"`
	AddonID     string `json:"addonId,omitempty"`
	InstallURL  string `json:"installUrl,omitempty"`
}

// Config is the parsed shared/extension-ids.json.
type Config struct {
	Chrome  Target `json:"chrome"`
	Edge    Target `json:"edge"`
	Brave   Target `json:"brave"`
	Firefox Target `json:"firefox"`
}

// Target returns the configured target for a browser kind.
func (c Config) Target(k Kind) Target {
	switch k {
	case Chrome:
		return c.Chrome
	case Edge:
		return c.Edge
	case Brave:
		return c.Brave
	case Firefox:
		return c.Firefox
	}
	return Target{}
}

// LoadConfig reads and parses the shared extension-ids.json file.
func LoadConfig(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("read config: %w", err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("parse config: %w", err)
	}
	return c, nil
}

// isPlaceholder reports whether a value is still an unfilled REPLACE_* token.
func isPlaceholder(s string) bool {
	return strings.Contains(s, "REPLACE_")
}

// chromiumForcelistValue builds the "<id>;<update_url>" entry that the
// ExtensionInstallForcelist policy expects. It returns an error when the target
// is incomplete or still contains a placeholder, so callers can skip it.
func chromiumForcelistValue(t Target) (string, error) {
	if t.ExtensionID == "" || t.UpdateURL == "" {
		return "", fmt.Errorf("missing extensionId or updateUrl")
	}
	if isPlaceholder(t.ExtensionID) || isPlaceholder(t.UpdateURL) {
		return "", fmt.Errorf("extensionId/updateUrl is still a placeholder")
	}
	return t.ExtensionID + ";" + t.UpdateURL, nil
}

// firefoxConfigured reports whether the Firefox target is ready to apply.
func firefoxConfigured(t Target) bool {
	return t.AddonID != "" && t.InstallURL != "" && !isPlaceholder(t.InstallURL)
}

// Status reports whether a browser's force-install policy is correctly applied.
type Status struct {
	Kind      Kind   // which browser
	Installed bool   // browser detected on this machine
	Locked    bool   // force-install policy present and correct
	Detail    string // human-readable note: "ok", "missing", "tampered", "not configured"
}
