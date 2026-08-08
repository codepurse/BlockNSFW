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
      blocking, clear PIN, weaken the code) ask for it — routine edits do not

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
- [ ] Publish release notes
- [ ] Tag release in git if desired
- [ ] Upload packaged zips to GitHub Release if using GitHub Releases
