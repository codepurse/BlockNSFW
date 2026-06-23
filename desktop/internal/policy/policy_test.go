package policy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChromiumForcelistValue(t *testing.T) {
	got, err := chromiumForcelistValue(Target{ExtensionID: "abc123", UpdateURL: "https://u/crx"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := "abc123;https://u/crx"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestChromiumForcelistValueRejectsPlaceholder(t *testing.T) {
	if _, err := chromiumForcelistValue(Target{ExtensionID: "REPLACE_WITH_ID", UpdateURL: "https://u/crx"}); err == nil {
		t.Fatal("expected error for placeholder extension id")
	}
}

func TestChromiumForcelistValueRejectsIncomplete(t *testing.T) {
	if _, err := chromiumForcelistValue(Target{ExtensionID: "abc123"}); err == nil {
		t.Fatal("expected error for missing update url")
	}
}

func TestFirefoxConfigured(t *testing.T) {
	cases := []struct {
		name string
		t    Target
		want bool
	}{
		{"complete", Target{AddonID: "a@b", InstallURL: "https://x.xpi"}, true},
		{"placeholder url", Target{AddonID: "a@b", InstallURL: "REPLACE_WITH_SIGNED_XPI_URL"}, false},
		{"missing url", Target{AddonID: "a@b"}, false},
		{"missing id", Target{InstallURL: "https://x.xpi"}, false},
	}
	for _, c := range cases {
		if got := firefoxConfigured(c.t); got != c.want {
			t.Errorf("%s: firefoxConfigured = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "ids.json")
	content := `{
	  "chrome":  {"extensionId": "cid", "updateUrl": "curl"},
	  "firefox": {"addonId": "fid", "installUrl": "furl"}
	}`
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(p)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got := cfg.Target(Chrome).ExtensionID; got != "cid" {
		t.Errorf("chrome extensionId = %q, want %q", got, "cid")
	}
	if got := cfg.Target(Firefox).InstallURL; got != "furl" {
		t.Errorf("firefox installUrl = %q, want %q", got, "furl")
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("expected error for missing config file")
	}
}
