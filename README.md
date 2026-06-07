# BlockNSFW

Open-source browser extension for blocking adult websites and reducing unsafe content exposure across browsing, search, and selected social surfaces.

Project status:
- Published as Chrome and Firefox extension
- Already used by thousands of users
- Source-first repo with Chrome and Firefox build scripts

Current version: `1.6.1`

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/blocknsfw-%E2%80%93-porn-adult-co/fiecjgpoilkhmoieaboolkfmgbnhlhop)
- [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/blocknsfw-porn-adult-content/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/blocknsfw-%E2%80%93-porn-adult-/imccbmfplknoadpaoopicfdpnnimgdab)

## Badges

- Chrome Web Store: <https://chromewebstore.google.com/detail/blocknsfw-%E2%80%93-porn-adult-co/fiecjgpoilkhmoieaboolkfmgbnhlhop>
- Firefox Add-ons: <https://addons.mozilla.org/en-US/firefox/addon/blocknsfw-porn-adult-content/>
- Microsoft Edge Add-ons: <https://microsoftedge.microsoft.com/addons/detail/blocknsfw-%E2%80%93-porn-adult-/imccbmfplknoadpaoopicfdpnnimgdab>
- License: [MIT](LICENSE)
- CI status: <https://github.com/codepurse/BlockNSFW/actions/workflows/build.yml>
  (the `build.yml` workflow runs the focused test suite and `web-ext lint`
  on every push)

## What It Does

BlockNSFW combines several protection layers:

- Domain blocking with local fallback rules plus cached remote blocklist updates. IDN / punycode hostnames (e.g. `xn--porn-tqa.net`) are retained at runtime, not silently dropped.
- Hostname smart filter that scans both the ASCII / punycode form and the decoded Unicode form of a hostname, with multilingual adult-hostword coverage (Chinese, Korean, Russian, Arabic, Thai, plus transliterated Latin).
- Page and visible-content filtering through a Manifest V3 content script
- Search SafeSearch enforcement on Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Qwant, AOL Search, and Presearch
- Optional DNS-based blocking through Cloudflare for Families
- Reddit NSFW subreddit checks for Reddit-specific filtering paths
- Optional Facebook Reels and Instagram Reels blocking toggles
- Local stats, streak tracking, whitelist management, and audit views
- Manual community reports for blocked / missed sites

## Architecture

Main files:

- `manifest.json` - Chrome/Chromium MV3 manifest
- `manifest.firefox.json` - Firefox MV3 manifest
- `background.js` - blocklist loading, DNS checks, dynamic rules, stats, audit storage
- `content.js` - page filtering, SafeSearch enforcement, Reddit checks, DOM scanning
- `shared/hostname.js` - browser-safe punycode / IDN helpers (RFC 3492)
- `shared/host-keywords.js` - shared smart-blocking keyword list and strict host matcher
- `popup.html` / `popup.js` - quick toggle, stats, shortcuts
- `options.html` / `options.js` - full settings UI, whitelist tools, audit/stats access
- `blocked.html` / `blocked.js` - blocked page
- `audit.html` / `audit.js` - audit view
- `stats.html` / `stats.js` - statistics view
- `data/HOSTS.txt` - curated source blocklist (self-hosted in `data/` under MIT)
- `data/WHITELIST.txt` - curated global whitelist
- `data/SOURCE_NOTES.txt` - data-file provenance, curation policy, missed-site flow
- `blocklist.json` - bundled fallback blocklist (regenerated from `data/HOSTS.txt`)
- `build-chrome.ps1` / `build-firefox.ps1` - release bundle scripts

Tech stack:

- Manifest V3
- Vanilla JavaScript / HTML
- No Node build step required

Additional maintainer docs:

- `ARCHITECTURE.md`
- `RELEASE_CHECKLIST.md`
- `THIRD_PARTY_NOTICES.md`

## Privacy and Network Behavior

Most filtering decisions happen locally in the browser, but this project is **not fully offline**.

Network requests may occur for these features:

- Remote blocklist and whitelist updates from GitHub-hosted text files
- Optional DNS filtering through `family.cloudflare-dns.com`
- Reddit subreddit NSFW checks through Reddit endpoints
- Optional manual community reports through Appwrite-hosted backend

Privacy details live in `PRIVACY_POLICY.md`. Public docs should stay aligned with real code behavior.

## Browser Support

Supported:

- Chrome 88+
- Firefox 109+
- Chromium-based browsers that support MV3 and required permissions

More detail: `BROWSER_COMPATIBILITY.md`

## Local Development

### Load unpacked in Chromium browsers

1. Open `chrome://extensions/` or equivalent browser extensions page.
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select repo root containing `manifest.json`.

### Load temporary add-on in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select `dist\firefox\manifest.json` after running Firefox build script.

## Build Release Bundles

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

Build output:

- `dist\chrome\`
- `dist\firefox\`

## Manual Smoke Test

Before release:

1. Load Chrome build and Firefox build.
2. Confirm popup opens and main toggle works.
3. Confirm options page opens and settings persist.
4. Confirm blocked page, audit page, and stats page open correctly.
5. Confirm SafeSearch rules apply on at least one supported engine.
6. Confirm whitelist add/remove flow works.
7. Confirm no obvious console errors after fresh install.

## Contributing

See `.github/CONTRIBUTING.md`.

If you want to report:

- blocking misses or false positives
- browser-specific regressions
- privacy/security concerns
- UX issues in popup/options flows

open an issue with steps, URLs/domains involved, browser version, and feature flags used.

## Roadmap

Near-term priorities:

- tighten open-source launch polish
- add focused regression coverage for high-risk blocking logic
- improve release automation and browser-specific validation

## License

MIT. See `LICENSE`.

## Notes Before Public Launch

- Add store listing links once public repo announcement is ready
- Keep generated `dist/` output out of version control
- Keep docs consistent with actual network behavior and permissions
- Remote blocklist source is self-hosted in `data/` under MIT (see
  `THIRD_PARTY_NOTICES.md`); `background.js` `REMOTE_BLOCKLIST_URL` and
  `REMOTE_WHITELIST_URL` point at the public `codepurse/BlockNSFW` raw URLs
- Appwrite manual-report backend is maintained out-of-tree; its
  public-launch status and the data it receives are documented in
  `THIRD_PARTY_NOTICES.md` and `PRIVACY_POLICY.md`