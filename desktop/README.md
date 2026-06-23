# BlockNSFW desktop guard (PC version)

A small native companion to the BlockNSFW browser extension. Its only job is to
**lock the extension in place** so it can't be removed from the browser UI. It
resists tampering (watchdog), requires a password to uninstall, and ships a
small status window.

It does **no** content blocking itself — that all stays in the extension. This
app just plants and guards the browser "force-install" enterprise policy.

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

## Prerequisites (all via winget)

- **Go 1.23+** — `winget install GoLang.Go`
- **Node.js LTS** — `winget install OpenJS.NodeJS.LTS` (Wails uses it for the status UI)
- **Wails CLI** — `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **Inno Setup 6** — `winget install JRSoftware.InnoSetup` (builds the installer)
- WebView2 runtime (already on Windows 11)

## Build everything (release artifacts)

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
