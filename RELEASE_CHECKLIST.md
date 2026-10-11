# Release Checklist

Use this before publishing Chrome Web Store or Firefox Add-ons update.

## 0. Do first: Supporter goes live

**Stop here until every box is ticked.** Until then `shared/supporter.js` is in
Polar's sandbox (test) mode: "Become a supporter" opens a test checkout that
takes no real money, and Lifetime is hidden. A zip built in sandbox mode is for
testing on your own browser only. **Never upload one to a store.** (The zips
built on 2026-10-10 are sandbox builds.)

The build backs this up: `-Zip` refuses to make a store package while
anything below in `shared/supporter.js` is left, and lists what
(`node scripts/check-store-mode.js` gives the same list at any time). A test
package needs `-Zip -Sandbox`, and says "TEST PACKAGE" when it's done.

In Polar, live organization (polar.sh, not sandbox.polar.sh):

- [ ] Three products exist, each with the **License key** benefit: Monthly
      $2.99, Yearly $24.99, Lifetime $49.99. Open each checkout link and check
      it shows the BlockNSFW product and price (the first sandbox Lifetime
      link opened "Warden Pro Lifetime" instead)
- [ ] Organization Settings → Subscriptions → "Allow multiple subscriptions"
      is on. The monolab organization also sells Warden, and with it off, a
      Warden subscriber can't subscribe to BlockNSFW (Polar says "You already
      have an active subscription")
- [ ] Each checkout link's Success URL is the thank-you page
- [ ] Each product's **License key** benefit has **Activation limit: 3**, and
      lets customers deactivate their own activations. One code then works on
      three browsers at once, and a code posted online stops at the third.
      Settings › Supporter tells buyers "up to three", so if you choose
      another number, change that line in `options.html` too. (The extension
      reads the limit from Polar; with none set, a code works everywhere)
- [ ] Do the same on the sandbox products, then test it with a sandbox
      purchase: unlock on three browser profiles, see the fourth refused,
      "Remove it from this browser" on one, and the fourth then unlocks

In `shared/supporter.js`:

- [ ] `STORE.mode` is `'live'`
- [ ] `STORE.organizationId` is the live organization's ID
- [ ] Each plan's `url` is its live checkout link, and Lifetime's `url` is
      filled in (a plan without a link stays hidden)
- [ ] The prices in `PLANS` match Polar's, and `OFFER` is null or has the
      right end date
- [ ] `grep -n "sandbox" shared/supporter.js` shows only three lines: the
      comment about `mode`, and the `api:` and `portal:` lines. Any `mode:`
      or `url:` line in the result means a sandbox setting is still there

Then:

- [ ] `npm test` passes
- [ ] The private Supporter extras are checked out at `extras-private/`, up
      to date (`git -C extras-private pull`), and `npm run test:extras` passes
- [ ] Both repositories have everything that ships committed: a store `-Zip`
      refuses otherwise and lists the files (`node scripts/check-package.js
      tree` gives the same list at any time)
- [ ] A gift code (`BN1-`) seen shared online: add its number to `REVOKED`
      in `shared/supporter.js` (your note of who got which number says whose
      it was), and make that person a new one
- [ ] Recommended: buy the cheapest plan once with your own card in the live
      store, unlock it in a build from this release, then refund it in Polar
- [ ] Only now build the store zips (section 2)

## 1. Prepare

- [ ] Confirm target version number
- [ ] Update `manifest.json`
- [ ] Update `manifest.firefox.json`
- [ ] Update `package.json` (keep it in step with the manifests)
- [ ] Update `CHANGELOG.md` or release notes
- [ ] Update the "What's New" card in `options.html` — it is user-facing and
      goes stale silently. Readers who folded it see it in full again on the
      new version, stale or not
- [ ] Re-read any UI text describing behavior that changed this release
      (feature descriptions, toggle hints) so the UI does not describe the old
      behavior
- [ ] Review `README.md` if user-visible behavior changed
- [ ] Review `PRIVACY_POLICY.md` if privacy/network behavior changed
- [ ] Supporter is live: every box in section 0 is ticked
- [ ] The path: any day still without its `mine` lines simply leaves them
      out in a store build; check that this is what you want, or write them
      in `shared/path-days.js` (days 1 to 7) or
      `extras-private/extras/path-days.js` (days 8 to 30) first

## 2. Build

Always build with `-Zip`. The zip is the artifact the stores actually receive,
and the plain build only refreshes `dist\chrome\` and `dist\firefox\` — it
leaves any existing zip untouched. Uploading a stale zip is how a release goes
out with the previous version number (AMO rejects it with "Version X already
exists", which reads like the bump failed when it did not).

- [ ] Run `powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1 -Zip`
- [ ] Run `powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1 -Zip`
- [ ] Both builds end with `Supporter extras: included` and no "TEST
      PACKAGE" line (`-Zip` refuses to run without `extras-private/` or in
      sandbox mode; never add `-OpenSource` or `-Sandbox` to a store build)
- [ ] Both builds say `Package checked`. Every zip is read back by
      `scripts/check-package.js`: each extra whole and exactly as in
      `extras-private/`, no tests, tools, notes, keys or `_metadata`, and live
      Supporter settings. A zip that fails is deleted, so a store never gets it
- [ ] Keep `dist\blocknsfw-chrome.build.txt` and `dist\blocknsfw-firefox.build.txt`
      with the release (in its GitHub release notes, or a folder of your own).
      Each says the version, the zip's SHA-256 and the commit of both
      repositories, so you can always tell which code a store version carries.
      Neither may say `NOT COMMITTED` or `not pushed yet`: push both
      repositories first
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
- [ ] If using GitHub Releases, upload **open-source** zips only: build them
      with `-Zip -OpenSource` (the store zips carry the private Supporter
      extras, and a public release would publish them). Rebuild the store
      zips afterwards if you still need them

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
