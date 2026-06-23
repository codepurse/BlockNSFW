# BlockNSFW Guard installer (Inno Setup)

Builds `BlockNSFW-Guard-Setup.exe` - the double-click installer for the PC
version. It shows a consent page, collects the uninstall password, installs +
hardens + starts the guard service, and gates uninstall on that password.

## Prerequisites

- Build `guard.exe` first: `go -C .. build -o guard.exe ./cmd/guard`
- **Inno Setup 6** (`winget install JRSoftware.InnoSetup`) - provides `ISCC.exe`.

## Build

```sh
ISCC.exe BlockNSFW-Guard.iss
```

(If `ISCC.exe` isn't on PATH it's usually at
`C:\Program Files (x86)\Inno Setup 6\ISCC.exe`.)

Output: `output\BlockNSFW-Guard-Setup.exe`.

## What the installer does

1. Consent page (`consent.txt`) - must be accepted.
2. Password page - sets the uninstall password (masked, confirmed, min 6 chars).
3. Copies `guard.exe` + `extension-ids.json` to `C:\Program Files\BlockNSFW Guard`.
4. Runs `guard install-service` (install + harden + start) with that password.
5. Uninstall prompts for the password and runs `guard uninstall-service`; a wrong
   password aborts removal.

## ⚠️ Not signed yet

This produces an **unsigned** installer, so Windows SmartScreen will warn
("unknown publisher") and some antivirus may flag the self-restarting service.
That's expected for local testing. Before distributing, sign `guard.exe` **and**
the setup `.exe` with a code-signing certificate (free for open source via the
SignPath Foundation - see `../../docs/pc-version.md`).

## Note

Running the produced setup actually installs the protective service. With the
placeholder `extension-ids.json` it touches no browser policy, but it does
install a self-healing service - remove it via Programs & Features (you'll need
the password) or `guard -password <pw> uninstall-service`.
