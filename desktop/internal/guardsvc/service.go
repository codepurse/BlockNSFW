// Package guardsvc hosts the BlockNSFW guard as a long-running service and its
// watchdog companion. The service applies the force-install policy on start,
// re-applies it on registry tamper (via the watcher) and on a backstop timer,
// and spawns a watchdog process. The watchdog re-asserts service recovery,
// restarts the service if it is stopped or disabled, and re-installs it if the
// service entry is deleted - so stopping or killing the guard does not stick.
package guardsvc

import (
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/kardianos/service"

	"github.com/codepurse/BlockNSFW/desktop/internal/policy"
	"github.com/codepurse/BlockNSFW/desktop/internal/scm"
	"github.com/codepurse/BlockNSFW/desktop/internal/watcher"
)

const (
	// ServiceName is the SCM service name; the watchdog references it too.
	ServiceName = "BlockNSFWGuard"

	backstop         = 30 * time.Second
	watchdogInterval = 5 * time.Second
	watchdogRespawn  = 2 * time.Second
	watchdogMutex    = `Local\BlockNSFWGuardWatchdog`
)

type program struct {
	cfg         policy.Config
	configPath  string
	logger      service.Logger
	quit        chan struct{}
	interactive bool

	w   *watcher.Watcher
	mu  sync.Mutex
	dog *exec.Cmd
}

// New builds the service. configPath is embedded into the service's launch
// arguments so the Service Control Manager passes it back to `guard run` - a
// service's working directory is System32, so the config can't be located by
// walking up the tree. Flags precede the subcommand because Go's flag parser
// stops at the first non-flag argument.
func New(cfg policy.Config, configPath string) (service.Service, error) {
	prg := &program{cfg: cfg, configPath: configPath, quit: make(chan struct{})}
	conf := &service.Config{
		Name:        ServiceName,
		DisplayName: "BlockNSFW Guard",
		Description: "Keeps the BlockNSFW extension force-installed and re-applies the policy if it is tampered with.",
		Arguments:   []string{"-config", configPath, "run"},
		// systemd: auto-restart the daemon if it dies. Ignored on Windows, where
		// SCM recovery actions are configured separately by scm.Harden.
		Option: service.KeyValue{"Restart": "always"},
	}
	s, err := service.New(prg, conf)
	if err != nil {
		return nil, err
	}
	logger, err := s.Logger(nil)
	if err != nil {
		return nil, err
	}
	prg.logger = logger
	prg.interactive = service.Interactive()
	return s, nil
}

// Install registers the service, hardens it (recovery + Automatic start),
// clears the disabled sentinel, and starts it.
func Install(cfg policy.Config, configPath string) error {
	if err := scm.SetDisabled(false); err != nil {
		return err
	}
	return install(cfg, configPath)
}

// install (re)registers + hardens + starts. Shared by Install and the watchdog.
func install(cfg policy.Config, configPath string) error {
	s, err := New(cfg, configPath)
	if err != nil {
		return err
	}
	if err := service.Control(s, "install"); err != nil {
		return err
	}
	if err := scm.Harden(ServiceName); err != nil {
		return err
	}
	return service.Control(s, "start")
}

// Uninstall sets the disabled sentinel (so the watchdog stops resurrecting),
// waits long enough for the watchdog to observe it and exit, then stops and
// removes the service. The wait closes a race where the watchdog could
// re-install the service mid-teardown.
func Uninstall(cfg policy.Config, configPath string) error {
	_ = scm.SetDisabled(true)
	time.Sleep(watchdogInterval + 2*time.Second)
	s, err := New(cfg, configPath)
	if err != nil {
		return err
	}
	_ = service.Control(s, "stop")
	if err := service.Control(s, "uninstall"); err != nil {
		return err
	}
	// Lift the browser force-install lock too, so an authorized uninstall fully
	// restores the browsers - otherwise the extension stays locked with no
	// service left to manage it.
	return policy.Remove(cfg)
}

// Disable temporarily turns protection off. It performs the same teardown as an
// uninstall - stop and remove the service and lift the browser lock so browsing
// is unfiltered - but the caller deliberately keeps the stored uninstall
// password so Enable can restore protection later. The disabled sentinel it
// sets also stops the watchdog from resurrecting anything, and because the
// service entry is removed nothing auto-starts on reboot.
func Disable(cfg policy.Config, configPath string) error {
	return Uninstall(cfg, configPath)
}

// Enable restores protection after a Disable: it clears the disabled sentinel
// and reinstalls, hardens, and starts the service, which re-applies the browser
// lock. It assumes an uninstall password is already stored (set at install).
func Enable(cfg policy.Config, configPath string) error {
	return Install(cfg, configPath)
}

// RunWatchdog is the watchdog companion loop. A single instance runs at a time;
// it exits when the disabled sentinel is set.
func RunWatchdog(cfg policy.Config, configPath string) error {
	log.SetPrefix("watchdog: ")
	if !scm.AcquireSingleton(watchdogMutex) {
		log.Println("another watchdog is already running; exiting")
		return nil
	}
	for {
		if scm.IsDisabled() {
			log.Println("guard disabled by an authorized uninstall; watchdog exiting")
			return nil
		}
		if scm.Exists(ServiceName) {
			if err := scm.Harden(ServiceName); err != nil {
				log.Printf("re-harden: %v", err)
			}
			if action, err := scm.EnsureRunning(ServiceName); err != nil {
				log.Printf("ensure running: %v", err)
			} else if action != "ok" {
				log.Printf("service %s", action)
			}
		} else {
			log.Println("service entry missing; re-installing")
			if err := install(cfg, configPath); err != nil {
				log.Printf("re-install: %v", err)
			}
		}
		time.Sleep(watchdogInterval)
	}
}

func (p *program) Start(s service.Service) error {
	p.logger.Info("BlockNSFW Guard starting")
	go p.loop()
	return nil
}

func (p *program) Stop(s service.Service) error {
	p.logger.Info("BlockNSFW Guard stopping")
	close(p.quit)
	if p.w != nil {
		p.w.Stop()
	}
	// In an interactive debug session, kill the watchdog so it doesn't outlive
	// the console. Under the real service manager we deliberately leave it
	// running so it can resurrect the service after a graceful stop.
	if p.interactive {
		p.mu.Lock()
		if p.dog != nil && p.dog.Process != nil {
			_ = p.dog.Process.Kill()
		}
		p.mu.Unlock()
	}
	return nil
}

func (p *program) loop() {
	p.reapply("startup")

	if w, err := watcher.New(); err != nil {
		p.logger.Errorf("watcher init failed, relying on periodic re-apply: %v", err)
	} else {
		p.w = w
		go func() {
			if err := w.Run(func() { p.reapply("registry change") }); err != nil {
				p.logger.Errorf("watcher stopped: %v", err)
			}
		}()
	}

	if !scm.IsDisabled() {
		p.spawnWatchdog()
	}

	ticker := time.NewTicker(backstop)
	defer ticker.Stop()
	for {
		select {
		case <-p.quit:
			return
		case <-ticker.C:
			p.reapply("periodic")
		}
	}
}

// spawnWatchdog launches the watchdog child and respawns it if it exits while
// the service is still running and not disabled.
func (p *program) spawnWatchdog() {
	exe, err := os.Executable()
	if err != nil {
		p.logger.Errorf("locate executable for watchdog: %v", err)
		return
	}
	cmd := exec.Command(exe, "-config", p.configPath, "watchdog")
	if err := cmd.Start(); err != nil {
		p.logger.Errorf("start watchdog: %v", err)
		return
	}
	p.mu.Lock()
	p.dog = cmd
	p.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		select {
		case <-p.quit:
			return // service stopping; do not respawn
		default:
		}
		if scm.IsDisabled() {
			return
		}
		time.Sleep(watchdogRespawn)
		p.spawnWatchdog()
	}()
}

// reapply writes the policy and logs only when it actually fixed something (the
// locked-browser count changed), keeping the log quiet in steady state.
func (p *program) reapply(reason string) {
	before := lockedCount(policy.Verify(p.cfg))
	if err := policy.Apply(p.cfg); err != nil {
		p.logger.Errorf("apply (%s): %v", reason, err)
		return
	}
	if after := lockedCount(policy.Verify(p.cfg)); after != before {
		p.logger.Infof("re-applied policy after %s: locked browsers %d -> %d", reason, before, after)
	}
}

func lockedCount(st []policy.Status) int {
	n := 0
	for _, s := range st {
		if s.Locked {
			n++
		}
	}
	return n
}
