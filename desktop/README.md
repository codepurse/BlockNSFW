# BlockNSFW desktop guard (PC version)

A small native companion to the BlockNSFW browser extension. Its only job is to
**lock the extension in place** so it can't be removed from the browser UI. It
resists tampering (watchdog), requires a password to uninstall, and ships a
small status window.

It does **no** content blocking itself — that all stays in the extension. This
app just plants and guards the browser "force-install" enterprise policy.

It runs on **Windows** (registry + Service Control Manager) and **Linux**
(managed policy files + systemd). The OS-specific code is selected automatically
at build time by Go build tags (`*_windows.go` / `*_linux.go`), so it's one app,
not two — see the **Linux** section below.

> Why this works: a browser extension can't prevent its own uninstall, but a
> privileged process *above* the browser can force-install it via policy, which
> greys out the Remove/Disable buttons. See `../docs/pc-version.md` for the full
> picture.

## Status — milestone roadmap

| # | Milestone | State |
|---|-----------|-------|
| 1 | Force-install **policy writer** (apply / verify / remove) | ✅ done |
| 2 | Run as a **Windows service** + tamper watcher (re-apply on delete) | ✅ done |
| 3 | **Watchdog** (survive being killed) | ✅ done |
| 4a | **Password-gated** uninstall (set-password, gated install/uninstall) | ✅ done |
| 4b | **Installer** (Inno Setup wizard + consent + password page) | ✅ done (unsigned until cert) |
| 5 | Status **UI** window (Wails, day-to-day screen from the mockup) | ✅ done |
| 6 | **Temporary disable/enable** toggle + polish (fixed window, app icon) | ✅ done |
| 7 | **Linux** port (managed-policy files + systemd) | 🟡 code-complete; engine compile-verified, UI/scripts need a Linux box |

## Prerequisites — Windows build (via winget)

- **Go 1.23+** — `winget install GoLang.Go`
- **Node.js LTS** — `winget install OpenJS.NodeJS.LTS` (Wails uses it for the status UI)
- **Wails CLI** — `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **Inno Setup 6** — `winget install JRSoftware.InnoSetup` (builds the installer)
- WebView2 runtime (already on Windows 11)

## Build everything — Windows (release artifacts)

```powershell
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

Runs the tests, then builds all three artifacts into `desktop\release\`:

| Artifact | What it is |
|----------|-----------|
| `guard.exe` | CLI + Windows service + watchdog |
| `blocknsfw-status.exe` | the status window (Wails) |
| `BlockNSFW-Guard-Setup.exe` | installer that bundles both + creates shortcuts |

Go core only: `go -C desktop test ./...` then `go -C desktop build ./cmd/guard`.

## Install the app (end users — Windows)

Run `desktop\release\BlockNSFW-Guard-Setup.exe`. It shows a consent page, asks
you to **set an uninstall password** (give it to the parent / accountability
partner, *not* the person being filtered), installs + starts the guard service,
locks the browsers, and creates a **BlockNSFW Protection** shortcut.

To **update** an installed copy: uninstall first (Settings → Apps → *BlockNSFW
Guard* → Uninstall → enter the password), then run the new setup. Installing
over a running install fails because the service holds `guard.exe` open.

### Status window (day-to-day)

`blocknsfw-status.exe` shows whether protection is **Active / Paused / Inactive**,
how many browsers are locked, and the service state. To pause or resume, type the
password and click **Disable protection** / **Enable protection** — each pops a
Windows **UAC** prompt, and the guard re-verifies the password itself, so the
button can't be bypassed from the UI. The window is read-only otherwise.

## Try it (Windows, Administrator shell required)

`apply`, `remove` write to `HKLM`, so run them from an **elevated** terminal.

```sh
guard detect       # which browsers are installed
guard apply        # write the force-install policy
guard verify       # show lock status per browser
guard remove       # remove the policy (authorized uninstall)
```

### Run it as a service (milestone 2)

The service applies the policy on start, then re-applies it within milliseconds
whenever anything under `HKLM\SOFTWARE\Policies` changes (the tamper case), plus
a 30s backstop timer. Install/start/stop need an elevated shell.

```sh
guard -config <abs> -password <pw> install-service  # set password + install + harden + start
guard set-password                                   # set/change the password (prompts, hidden)
guard -password <pw> uninstall-service               # remove the service (password required)
guard start                                          # start it
guard stop                                           # stop it (the watchdog will fight this)
guard run                                            # run in the foreground (Ctrl+C to stop)
```

The uninstall password is stored only as a bcrypt hash in `HKLM\SOFTWARE\BlockNSFW`.
`uninstall-service` refuses to proceed without it - that's the gate that makes
removal require the parent/accountability-partner, not just admin rights. (A
determined admin who knows the internals can still wipe the registry state; see
the honest ceiling in `../docs/pc-version.md`.)

Flags go **before** the command (`guard -config X run`), because Go's flag
parser stops at the first non-flag argument. The installed service is given the
absolute config path automatically, since a service's working directory is
`System32`.

### Watchdog & self-healing (milestone 3)

`install-service` also **hardens** the service so stopping it doesn't stick:

- **SCM recovery** — Windows auto-restarts the process if it's killed/crashes.
- **Watchdog process** — spawned by the service; if the service is stopped,
  disabled, or its entry deleted, the watchdog re-enables Automatic start,
  restarts it, or re-installs it. A `Local\` named mutex keeps a single watchdog
  instance running.
- **Disabled sentinel** — `uninstall-service` sets `HKLM\SOFTWARE\BlockNSFW`
  `GuardDisabled=1` so the watchdog stops resurrecting during an authorized
  teardown; `install-service` clears it.

This defeats casual/impulsive removal. It does **not** stop a determined admin
(Safe Mode, killing both processes at once) - see `../docs/pc-version.md` for
the honest ceiling. The two-process respawn pattern is also what antivirus flags
as malware, so this layer makes code signing mandatory before distribution.

Config comes from `../shared/extension-ids.json` (found automatically by walking
up from the working directory). Override with `guard -config <path> apply`.

## Linux

The same app builds for Linux. The engine swaps the Windows registry + Service
Control Manager for **managed policy files + systemd**, selected automatically by
Go build tags. The `guard` engine is compile-verified; the Wails status UI and
the packaging scripts still need to be built and run **on a Linux machine** —
Wails links gtk/webkit, so it can't be cross-compiled from Windows.

**Prerequisites (Debian/Ubuntu):**

```sh
sudo apt install build-essential libgtk-3-dev libwebkit2gtk-4.1-dev
# plus Go 1.25+ and the Wails CLI:
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

**Build, install, uninstall:**

```sh
bash desktop/build-linux.sh               # -> desktop/release-linux/{guard, blocknsfw-status, extension-ids.json}
sudo desktop/installer/linux/install.sh   # copy to /opt/blocknsfw + register the systemd service (sets the password)
sudo desktop/installer/linux/uninstall.sh # password-gated removal
```

The CLI is identical to Windows (`guard apply|verify|remove|install-service|
disable|enable|start|stop|run`), just run with `sudo` instead of an elevated
shell. The status UI elevates via **pkexec** (PolicyKit) instead of UAC.

**Where things live on Linux:**

| Thing | Location |
|-------|----------|
| Binaries | `/opt/blocknsfw/` |
| Chromium force-install | `/etc/opt/chrome/policies/managed/blocknsfw.json` (also `/etc/opt/edge/...`, `/etc/brave/...`) |
| Firefox force-install | `/etc/firefox/policies/policies.json` |
| Guard state (disabled flag + password hash) | `/etc/blocknsfw/state.json` |
| Service | systemd unit `BlockNSFWGuard.service` |

**Linux caveats:**

- **snap / flatpak browsers** (e.g. Ubuntu's default Firefox) are sandboxed and
  ignore `/etc/.../policies/managed` — the lock only takes effect on natively
  installed (`.deb` / `.rpm`) browsers.
- Tamper-resistance is weaker than on Windows: `root` can stop the service and
  delete the policy files. It's effective against a **standard (non-admin) user**
  — the real target — but not against someone with `sudo`.
- Real-time tamper watching isn't wired up on Linux yet; the 30s backstop
  re-apply covers it. macOS is not started (needs an Apple Developer account +
  notarization).

## Per-browser setup (extension-ids.json)

Each browser force-installs only from **its own store**, so each entry needs that
browser's ID + update URL. A browser left as a `REPLACE_*` placeholder is skipped
(`not configured` in `verify`). Current state:

| Browser | Entry | Status |
|---------|-------|--------|
| Edge | `imccb…` + Edge Add-ons URL | ✅ real (published) |
| Firefox | `blocknsfw@extension.local` + AMO `latest.xpi` | ✅ real (published) |
| Chrome | placeholder | ⬜ needs Chrome Web Store ID |
| Brave | placeholder | ⬜ reuses the Chrome Web Store ID once available |

See `../docs/pc-version.md` for the full per-browser publishing rules — including
Edge's "unmanaged devices can only force-install from the Edge Add-ons store"
restriction, which is why Edge needs its own store listing.
