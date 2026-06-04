# BlockNSFW Browser Compatibility

BlockNSFW ships as Manifest V3 extension for Chromium browsers and Firefox.

## Supported Browsers

### Primary targets

- Chrome 88+
- Firefox 109+

### Expected to work

- Microsoft Edge
- Brave
- Opera
- Vivaldi
- Chromium
- Other Chromium-based browsers with MV3 support

### Not supported

- Safari

## Repo Layout by Browser

- `manifest.json` - Chrome / Chromium build
- `manifest.firefox.json` - Firefox build
- `build-chrome.ps1` - packages `dist\chrome\`
- `build-firefox.ps1` - packages `dist\firefox\`

Firefox is not separate MV2 port. It uses dedicated MV3 manifest plus same runtime files.

## Key Compatibility Notes

- Runtime code uses `const browserAPI = typeof browser !== 'undefined' ? browser : chrome;` to bridge Chrome / Firefox APIs.
- Chrome build uses `declarativeNetRequestWithHostAccess`.
- Firefox build uses `declarativeNetRequest`.
- Firefox build uses `background.scripts`, while Chrome build uses service-worker entry in `manifest.json`.
- Extension pages are referenced through `runtime.getURL(...)`, which keeps popup/options/audit/stats pages portable across browsers.

## Build Commands

Chrome:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1
powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1 -Zip
```

Firefox:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1
powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1 -Zip
```

## Firefox Notes

- Dev manifest currently uses placeholder Gecko ID `blocknsfw@extension.local`.
- For AMO release builds, replace with final signed-distribution ID if required by release workflow.
- Temporary install path for testing: `about:debugging#/runtime/this-firefox`

## Manual Verification Checklist

### Chromium

- [ ] Load root folder with `manifest.json`
- [ ] Popup opens
- [ ] Options page opens
- [ ] Main toggle persists after reload
- [ ] Blocked page loads when blocked domain is hit
- [ ] Stats and audit pages open from popup/options flows
- [ ] SafeSearch works on at least one supported engine

### Firefox

- [ ] Build with `build-firefox.ps1`
- [ ] Load `dist\firefox\manifest.json` as temporary add-on
- [ ] Background script starts without validation errors
- [ ] Popup opens
- [ ] Options page opens via UI and `runtime.openOptionsPage`
- [ ] Stats and audit pages open
- [ ] Storage reads/writes persist
- [ ] No Firefox-specific console errors from Promise / callback mismatches

## Known Release Tasks

- Confirm final Firefox extension ID before AMO release
- Keep docs aligned with actual browser support status
- Re-test after any permission, DNR, or SafeSearch rule changes
