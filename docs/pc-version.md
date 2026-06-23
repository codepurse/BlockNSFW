# BlockNSFW PC version — how uninstall protection works

## The core idea

A browser extension **cannot** prevent its own uninstall — both Chrome and
Firefox guarantee the user can always remove extensions, and any extension that
tries to block this gets pulled from the stores. So self-protection has to live
*above* the browser.

The PC version is a small native app installed with admin rights. It uses the
browsers' **enterprise "force-install" policy** to lock the extension:

- **Chromium** (Chrome, Edge, Brave): `ExtensionInstallForcelist` under
  `HKLM\SOFTWARE\Policies\<vendor>\<browser>`.
- **Firefox**: `ExtensionSettings` with `installation_mode = force_installed`
  under `HKLM\SOFTWARE\Policies\Mozilla\Firefox`.

A force-installed extension shows **no Remove or Disable button** in the browser.

## Why a registry key alone isn't enough

Anyone with admin can delete that key in seconds. The protection is the
**running guard** that owns the key:

1. **Policy writer** — writes the keys. *(milestone 1, done)*
2. **Tamper watcher** — re-applies them instantly if changed/deleted.
3. **Windows service (LocalSystem)** — so a standard user can't stop it.
4. **Watchdog** — restarts the service if it's killed.
5. **Password gate** — uninstall requires a password held by the parent /
   accountability partner, not the person being blocked.

Registry = the lock. The guard = what stops someone picking the lock.

## Consent & legitimacy

This must be installed by the device owner or with clear consent (a parent on a
child's device, or someone binding themselves). The setup screen requires an
explicit consent checkbox. Software that prevents its own removal *without*
consent is what antivirus flags as stalkerware — transparency is what keeps this
a legitimate accountability tool.

## Distribution prerequisites

- Stable Chrome/Edge store IDs (publish the extension).
- A Mozilla-signed Firefox `.xpi` hosted at a reachable URL.
- A **code-signing certificate** for the guard `.exe` (free for open source via
  the [SignPath Foundation](https://about.signpath.io/product/open-source));
  an unsigned tamper-resistant service will be quarantined by antivirus.

## Per-browser publishing requirements

Force-install only works for an extension hosted in **that browser's own store**,
so each browser is published and configured separately in `shared/extension-ids.json`.

| Browser | Where to publish | Update URL | Cost | Notes |
|---------|------------------|-----------|------|-------|
| Chrome | Chrome Web Store | `clients2.google.com/service/update2/crx` | $5 once | |
| Brave | (uses Chrome Web Store) | same as Chrome | — | reuses the Chrome listing/ID |
| Edge | Microsoft Edge Add-ons | `edge.microsoft.com/extensionwebstorebase/v1/crx` | free | **separate ID** from Chrome |
| Firefox | AMO (addons.mozilla.org) | the signed `.xpi` URL | free | must be Mozilla-signed |

### Edge gotcha — unmanaged devices
On a device that **isn't enrolled in org management (MDM)**, Edge will only
force-install extensions hosted in the **Microsoft Edge Add-ons** store. Pointing
Edge's policy at a Chrome Web Store URL is rejected (`[BLOCKED]` / "invalid
extension ID" in `edge://policy`). So Edge support **requires publishing to the
Edge Add-ons store** and using the `edge.microsoft.com` update URL. Chrome and
Brave have no equivalent restriction because the Chrome Web Store is their native
store. (On managed/enterprise devices Edge lifts this — that's how corporate IT
pushes Chrome extensions to Edge.)

### Firefox specifics
- The add-on must be **signed by Mozilla** (free via AMO — listed, or unlisted
  self-distribution which gives you a signed `.xpi` to host).
- `install_url` is only used for the **first install**; AMO-listed add-ons then
  auto-update through Firefox's normal channel.
- Use the version-independent URL so the config never needs editing on a version
  bump: `https://addons.mozilla.org/firefox/downloads/latest/<slug>/latest.xpi`.

### Version upgrades
All the update URLs above are "latest" endpoints, so existing installs
auto-update and new installs get the current version — the guard config never
changes on a version bump (only if an extension's **ID** changes).
