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
- **`importScripts()` does not exist on Firefox.** Chrome's background is a
  service worker; Firefox's `background.scripts` is an event *page*. Anything
  `background.js` loads with `self.importScripts(...)` therefore has to be listed
  in `manifest.firefox.json` under `background.scripts` as well, or Firefox
  silently runs the guarded fallback path instead. `tests/firefox-ai-runtime.test.js`
  asserts the two stay in sync for the `shared/*` helpers.
- **AI image classifier runtime.** Chrome imports `vendor/tfjs/tf.es2017.js` +
  `vendor/nsfwjs/nsfwjs.runtime.js` eagerly with `importScripts` (a service
  worker may only call it during initial evaluation) and classifies inside an
  offscreen document on WebGL. Firefox has no `chrome.offscreen`, so it loads the
  same two bundles lazily as `<script>` tags on the event page and classifies
  there. Keep both bundles in the build; `build-firefox.ps1` verifies they exist.

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
- [ ] Settings > enable the AI image blocker, load an adult page, confirm images
      blur and the background console logs `AI Image Blocker ready`
- [ ] Path-scoped whitelist entry allows its path and nothing else on that host

## Known Release Tasks

- Confirm final Firefox extension ID before AMO release
- Keep docs aligned with actual browser support status
- Re-test after any permission, DNR, or SafeSearch rule changes
