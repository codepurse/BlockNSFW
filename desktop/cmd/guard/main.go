// Command guard is the BlockNSFW desktop enforcement tool.
//
//   - milestone 1: apply / verify / remove the browser force-install policy.
//   - milestone 2: run as a Windows service that re-applies the policy on tamper.
//   - milestone 3: watchdog that resurrects the service if it is stopped/killed.
//   - milestone 4: password-gated uninstall (set-password / install-service /
//     uninstall-service involve the uninstall password).
//
// The status UI and signed installer build on these commands.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kardianos/service"
	"golang.org/x/term"

	"github.com/codepurse/BlockNSFW/desktop/internal/auth"
	"github.com/codepurse/BlockNSFW/desktop/internal/guardsvc"
	"github.com/codepurse/BlockNSFW/desktop/internal/policy"
	"github.com/codepurse/BlockNSFW/desktop/internal/scm"
)

func main() {
	cfgPath := flag.String("config", defaultConfigPath(), "path to extension-ids.json")
	password := flag.String("password", "", "uninstall password (install-service / uninstall-service / set-password)")
	flag.Usage = usage
	flag.Parse()

	cmd := flag.Arg(0)
	if cmd == "" || cmd == "help" {
		usage()
		if cmd == "" {
			os.Exit(2)
		}
		return
	}

	cfg, err := policy.LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		fmt.Fprintf(os.Stderr, "(looked for config at %s - pass -config to override)\n", *cfgPath)
		os.Exit(1)
	}

	switch cmd {
	case "apply":
		must(policy.Apply(cfg))
		fmt.Println("force-install policy applied")
		printStatus(cfg)
	case "verify", "status":
		printStatus(cfg)
	case "remove":
		must(policy.Remove(cfg))
		fmt.Println("force-install policy removed")
	case "detect":
		detected := policy.DetectBrowsers()
		for _, k := range []policy.Kind{policy.Chrome, policy.Edge, policy.Brave, policy.Firefox} {
			fmt.Printf("  %-8s %v\n", k, detected[k])
		}
	case "set-password":
		setPassword(*password)
	case "run", "watchdog", "install-service", "uninstall-service", "start", "stop", "disable", "enable":
		runService(cmd, cfg, *cfgPath, *password)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func runService(cmd string, cfg policy.Config, cfgPath, password string) {
	absCfg, err := filepath.Abs(cfgPath)
	if err != nil {
		absCfg = cfgPath
	}
	svc, err := guardsvc.New(cfg, absCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cmd {
	case "run":
		if err := svc.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "service run error: %v\n", err)
			os.Exit(1)
		}
	case "watchdog":
		if err := guardsvc.RunWatchdog(cfg, absCfg); err != nil {
			fmt.Fprintf(os.Stderr, "watchdog error: %v\n", err)
			os.Exit(1)
		}
	case "install-service":
		ensurePasswordSet(password)
		mustService(guardsvc.Install(cfg, absCfg), "install")
		fmt.Println("service installed, hardened, and started")
	case "uninstall-service":
		requirePassword(password)
		mustService(guardsvc.Uninstall(cfg, absCfg), "uninstall")
		_ = scm.ClearPasswordHash()
		fmt.Println("service uninstalled")
	case "disable":
		requirePassword(password)
		mustService(guardsvc.Disable(cfg, absCfg), "disable")
		fmt.Println("protection disabled")
	case "enable":
		requirePassword(password)
		mustService(guardsvc.Enable(cfg, absCfg), "enable")
		fmt.Println("protection enabled")
	case "start":
		mustService(service.Control(svc, "start"), "start")
		fmt.Println("service started")
	case "stop":
		mustService(service.Control(svc, "stop"), "stop")
		fmt.Println("service stopped")
	}
}

// ensurePasswordSet makes sure an uninstall password exists before install. A
// password already stored (e.g. a watchdog re-install) is kept; otherwise it is
// taken from -password or prompted, validated, hashed, and stored.
func ensurePasswordSet(flagPW string) {
	if _, ok := scm.GetPasswordHash(); ok {
		return
	}
	pw := flagPW
	if pw == "" {
		pw = prompt("Set uninstall password: ")
	}
	if len(pw) < auth.MinLength {
		fmt.Fprintf(os.Stderr, "error: password must be at least %d characters\n", auth.MinLength)
		os.Exit(1)
	}
	hash, err := auth.Hash(pw)
	must(err)
	mustService(scm.SetPasswordHash(hash), "store password")
}

// requirePassword aborts unless the supplied password matches the stored hash.
// If no password is set, the action is allowed.
func requirePassword(flagPW string) {
	hash, ok := scm.GetPasswordHash()
	if !ok {
		return
	}
	pw := flagPW
	if pw == "" {
		pw = prompt("Enter uninstall password: ")
	}
	if !auth.Verify(hash, pw) {
		fmt.Fprintln(os.Stderr, "error: incorrect password")
		os.Exit(1)
	}
}

// setPassword sets or changes the uninstall password; changing requires the
// current password.
func setPassword(flagPW string) {
	if hash, ok := scm.GetPasswordHash(); ok {
		if !auth.Verify(hash, prompt("Current password: ")) {
			fmt.Fprintln(os.Stderr, "error: incorrect current password")
			os.Exit(1)
		}
	}
	pw := flagPW
	if pw == "" {
		pw = prompt("New password: ")
	}
	if len(pw) < auth.MinLength {
		fmt.Fprintf(os.Stderr, "error: password must be at least %d characters\n", auth.MinLength)
		os.Exit(1)
	}
	hash, err := auth.Hash(pw)
	must(err)
	mustService(scm.SetPasswordHash(hash), "store password")
	fmt.Println("password updated")
}

// prompt reads one line from the terminal without echoing it.
func prompt(label string) string {
	fmt.Print(label)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading password: %v\n", err)
		os.Exit(1)
	}
	return strings.TrimSpace(string(b))
}

func printStatus(cfg policy.Config) {
	fmt.Printf("  %-8s %-10s %-7s %s\n", "browser", "installed", "locked", "detail")
	for _, s := range policy.Verify(cfg) {
		fmt.Printf("  %-8s %-10v %-7v %s\n", s.Kind, s.Installed, s.Locked, s.Detail)
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		fmt.Fprintln(os.Stderr, "(writing/removing policy requires an elevated Administrator shell)")
		os.Exit(1)
	}
}

func mustService(err error, action string) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: service %s failed: %v\n", action, err)
		fmt.Fprintln(os.Stderr, "(service install/uninstall requires an elevated Administrator shell)")
		os.Exit(1)
	}
}

// defaultConfigPath finds shared/extension-ids.json: first next to the binary
// (where the installer will place a copy), then by walking up from the working
// directory (so `go run ./cmd/guard` works from anywhere in the repo).
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

func usage() {
	fmt.Println(`BlockNSFW guard

usage: guard [flags] <command>

policy commands (admin):
  apply              write the force-install policy now
  verify             show the lock status of each browser (alias: status)
  remove             delete the force-install policy
  detect             list which supported browsers are installed

service commands (admin):
  install-service    install + harden + start the guard service (sets password)
  uninstall-service  remove the service (requires the password)
  disable            temporarily turn protection off (requires the password)
  enable             turn protection back on after a disable (requires the password)
  set-password       set or change the uninstall password
  start              start the service
  stop               stop the service
  run                run in the foreground (also used by the service manager)
  watchdog           run the watchdog loop (internal; spawned by the service)

  help               show this help

flags:`)
	flag.PrintDefaults()
}
