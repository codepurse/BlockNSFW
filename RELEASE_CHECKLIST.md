# Release Checklist

Use this before publishing Chrome Web Store or Firefox Add-ons update.

## 1. Prepare

- [ ] Confirm target version number
- [ ] Update `manifest.json`
- [ ] Update `manifest.firefox.json`
- [ ] Update `package.json` (keep it in step with the manifests)
- [ ] Update `CHANGELOG.md` or release notes
- [ ] Update the "What's New" card in `options.html` — it is user-facing and
      goes stale silently
- [ ] Re-read any UI text describing behavior that changed this release
      (feature descriptions, toggle hints) so the UI does not describe the old
      behavior
- [ ] Review `README.md` if user-visible behavior changed
- [ ] Review `PRIVACY_POLICY.md` if privacy/network behavior changed

## 2. Build

Always build with `-Zip`. The zip is the artifact the stores actually receive,
and the plain build only refreshes `dist\chrome\` and `dist\firefox\` — it
leaves any existing zip untouched. Uploading a stale zip is how a release goes
out with the previous version number (AMO rejects it with "Version X already
exists", which reads like the bump failed when it did not).

- [ ] Run `powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1 -Zip`
- [ ] Run `powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1 -Zip`
- [ ] Confirm `dist\chrome\manifest.json` exists
- [ ] Confirm `dist\firefox\manifest.json` exists
- [ ] **Verify the version inside each zip, not the folder** — the folder can be
      current while the zip is old:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($z in @('blocknsfw-chrome.zip','blocknsfw-firefox.zip')) {
  $a = [System.IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) "dist\$z"))
  $r = New-Object System.IO.StreamReader(($a.Entries | Where-Object { $_.FullName -eq 'manifest.json' }).Open())
  Write-Output "$z -> $(($r.ReadToEnd() | ConvertFrom-Json).version)"
  $r.Close(); $a.Dispose()
}
```

- [ ] Run `npm test` — all green
- [ ] Run `npm run lint:firefox` — 0 errors (warnings from `vendor/tfjs` and the
      pre-existing `innerHTML`/inline-script notices are expected)

## 3. Smoke Test

- [ ] Popup opens
- [ ] Main toggle works
- [ ] Options page opens
- [ ] Settings persist after reload
- [ ] Blocked page opens for blocked target
- [ ] Stats page opens
- [ ] Audit page opens
- [ ] SafeSearch works on at least one supported engine
- [ ] Whitelist add/remove works
- [ ] No new console errors on fresh install

### Network-level blocking and frame coverage (1.8.0 and after)

The static ruleset and `all_frames` change how blocking works, and **no
automated test in this repo can prove either of them**. The suite checks the
ruleset's shape, its size against the platform limits, and the frame gate's
logic — but nothing here loads the extension into a browser, so nothing here
proves the browser accepts the ruleset or applies it. Load the unpacked build
and check by hand, every release that touches `rules/`, the manifests, or
`content.js`'s frame handling.

- [ ] **The ruleset is accepted at install.** Load `dist\chrome\` unpacked.
      `chrome://extensions` must show **no** "Rules file … is invalid" or
      "Ruleset failed to load" warning. A rejected ruleset is silent at
      runtime: blocking simply falls back to the content script and nothing
      says so.
- [ ] **Confirm the rules are live, not merely accepted.** In the service
      worker console:
      `chrome.declarativeNetRequest.getEnabledRulesets()` returns
      `['blocklist']`, and
      `chrome.declarativeNetRequest.getAvailableStaticRuleCount()` returns a
      number well above zero.
- [ ] **A blocked host's images are refused at the network layer.** On any
      ordinary page, open DevTools → Network and load an image URL from a
      listed host directly. It must fail as `net::ERR_BLOCKED_BY_CLIENT`, not
      merely be hidden after loading. Hidden-but-loaded means the ruleset is
      not working and only the content script is.
- [ ] **Navigation still reaches the blocked page**, not the browser's error
      page. This is the deliberate boundary: `main_frame` is not in the
      ruleset. Seeing `ERR_BLOCKED_BY_CLIENT` on a navigation means
      `RESOURCE_TYPES` in `scripts/build-dnr-ruleset.mjs` has gained
      `main_frame`, and the blocked page, its reason and its audit entry are
      all gone with it.
- [ ] **A whitelisted site loads completely.** Whitelist a normally-blocked
      host, reload, and confirm its images and frames appear. Half-loading —
      page renders, images blocked — means the dynamic allow rules are not
      outranking the static blocks.
- [ ] **Removing a whitelist entry restores the block** without a browser
      restart.

### Frame coverage

- [ ] **An adult site inside an iframe is filtered.** Make a local page with
      `<iframe src="…" width="800" height="600">` pointing at a blocked host,
      and separately at a host that is *not* on the list but trips the keyword
      filter. Both must be handled: the first by the ruleset, the second by
      the content script running inside the frame.
- [ ] **Ordinary pages have not slowed down.** Open a news site heavy with ad
      frames, with DevTools → Performance recording. Compare against 1.7.7.
      This is the regression `all_frames` most plausibly causes and the one
      the test suite cannot see. `.verify/frames.html` (see below) confirms
      the *gate* is correct; it says nothing about the cost on a real page.
- [ ] **No pill or blocked-results line appears inside a frame.** One counter,
      on the page.

### Blocked-page detail

- [ ] **The address bar on the blocked page shows only `?k=…`** — no `url=`,
      no `matched=`. Then check `chrome://history`: the entry must not contain
      the blocked site's address.
- [ ] The blocked page still names the site, the reason, and the matched
      terms. If it reads "Unknown URL", the stash did not survive the
      navigation.

> A local harness for the two pieces that *can* be checked without installing
> the extension lives in `.verify/` (gitignored, generated — see the scripts
> referenced in the 1.8.0 changelog). It renders the real `blocked.html` and
> `blocked.js` against a stubbed `chrome.*`, and runs the real frame gate in
> real iframes. Both were used to verify 1.8.0; neither substitutes for the
> checks above.

### Settings lock (no automated test can cover these)

The PIN and access code prompts are DOM flows, so the test suite only covers the
decision logic behind them. A silent failure here means a user believes they are
protected when they are not — check by hand every release.

- [ ] With **no PIN set**, saving settings never prompts (a false prompt locks
      users out of their own settings)
- [ ] With a PIN set: **removing** a blocked word prompts; **adding** one does not
- [ ] Refusing the PIN leaves the change undone — re-open settings and confirm
      the word is still there
- [ ] Lowering AI strictness or turning DNS Protection off prompts, and refusing
      snaps the control back to its stored value
- [ ] Access code: paste is refused by every route — Ctrl/Cmd+V, right-click
      paste, middle-click paste on Linux, and dragging the displayed code into
      the box. If any route works the feature is decorative
- [ ] Access code: a wrong answer issues a **new** code rather than re-showing
      the same one
- [ ] Access code with the default scope: only the master switches (disable
      blocking, whitelist a whole site, import a whitelist, clear PIN, weaken
      the code) ask for it — routine edits do not
- [ ] Access code **from the popup**: with a code set, the *unblock this site*
      toggle asks for it after the PIN, and refusing leaves the site blocked.
      This is issue #29 — the popup once had its own PIN-only gate, so check
      the popup separately from the options page every release
- [ ] Popup: whitelisting a single *page* (`example.com/r/Name`) does not
      demand the code in the default scope, and re-blocking a whitelisted site
      never does — tightening stays free

## 4. Asset Check

- [ ] Confirm manifest icon files exist and load correctly
- [ ] Confirm any screenshots or store assets match current UI

## 5. Chrome Web Store Notes

- Uses root `manifest.json`
- Uses `background.service_worker`
- Uses `declarativeNetRequestWithHostAccess`
- Review any new permission text shown to users

## 6. Firefox Add-ons Notes

- Uses `manifest.firefox.json` copied to `dist\firefox\manifest.json`
- Uses `background.scripts`
- Uses `declarativeNetRequest`
- Confirm final Gecko ID before AMO release
- Re-test DNR and options-page flows after Firefox-specific changes

## 7. Publish

- [ ] Upload correct browser-specific package
- [ ] Publish release notes (`RELEASE_NOTES_<version>.md`)
- [ ] Tag release in git if desired
- [ ] Upload packaged zips to GitHub Release if using GitHub Releases

### After the stores accept the upload

- [ ] **Bump `latest` in `data/version.json` to the version now live, and push
      it to `main`.** This is the file `checkForUpdate()` fetches, and it is
      the only thing that makes the in-product "update available" banner
      appear. It must move *after* publishing, not before — the extension
      compares it against the installed version, so naming a build the stores
      have not accepted yet tells users to fetch something that does not
      exist.

      It went unbumped from 1.6.1 through the whole 1.7.x line, which meant
      the banner never appeared for anyone for three months. Nothing catches
      that automatically: only the store knows what is published, and during
      release prep the manifest is *supposed* to be ahead. The test suite only
      guards the other direction — `tests/update-manifest-consistency.test.js`
      fails if `version.json` ever gets ahead of the manifest, or names a
      version with no changelog entry.

- [ ] Update `updatedAt` and `notes` in the same edit — `notes` is shown in
      the banner
- [ ] Confirm the per-store URLs still resolve (`chromeUrl`, `firefoxUrl`,
      `edgeUrl`); each browser is routed to its own listing
