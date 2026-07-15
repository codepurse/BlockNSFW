# Changelog

All notable project changes should be documented here going forward.

## [1.7.1] - 2026-07-14

### Added
- Path-scoped whitelisting. A whitelist entry can now target a single section
  of a site instead of the whole domain — e.g. `reddit.com/r/NoFap` allows that
  subreddit while the rest of reddit.com stays blocked. Entries with no path
  behave exactly as before (whole domain), so existing entries are unaffected.
  Matching is path-segment-boundary safe (`/r/NoFap` never allows
  `/r/NoFapVille`) and case-insensitive. The popup and options inputs accept a
  bare domain or a domain+path, and scoped entries are labelled "Page only" in
  the list. Enforced in all three gates (background navigation, content-script
  block, content-script page scan) via a shared `whitelistPathMatches` helper in
  `shared/validate-domain.js`. Known limitation: path scope is re-evaluated on
  navigation and full page loads, so on SPA navigation (e.g. new reddit.com
  switching subreddits without a reload) the page-scan gate keeps the value from
  initial load; full-reload sites like old.reddit.com are unaffected.

### Fixed
- Major browsing slowdown on content-heavy and dynamic pages (streaming chat
  apps, SPAs, infinite scroll), present even with all AI/smart features off. The
  `content.js` MutationObserver ran heavy work synchronously on every DOM
  mutation — reading each added node's `textContent` and running three
  subtree `querySelectorAll` sweeps — which becomes O(n²) as a re-rendering
  container grows. Media (img/video/iframe) discovery for container nodes is now
  deferred to a coalesced `requestIdleCallback` batch (directly-added media is
  still checked instantly), the per-node `textContent` read is removed, and
  page-text scanning is only scheduled when a text feature is actually enabled.
- `debounce()` used a single shared module-level timer, so the page-text,
  search-result and social-post debouncers cancelled each other and only the
  last-scheduled one ran. Each debounced function now owns its timer, making
  dynamic-content filtering reliable.

### Changed
- The MutationObserver now honors the site whitelist (via a cached flag) and
  bails immediately when the page is blocked or the extension is disabled, so a
  whitelisted site does no per-mutation work at all.

## [1.7.0] - 2026-07-07

### Added
- First-run onboarding wizard (`onboarding.html` / `onboarding.js`). Opens
  once on fresh install only (`onInstalled` `reason === 'install'`, guarded by
  `pblocker_onboarding_completed`). Four steps: welcome / on-device explainer,
  enable AI image + text protection with a strictness preset, optional PIN /
  commitment lock, and Desktop Guard uninstall-proofing. Writes the same
  storage keys the rest of the extension reads (`pblocker_settings`,
  `pblocker_pin`). A "Re-run setup wizard" link was added to the options
  Welcome section.

### Fixed
- Chrome content script ran at `document_idle`, which fired after the page had
  largely painted and defeated the `instantBlockEarly()` anti-flash early
  block. Chrome `manifest.json` now uses `run_at: document_start`, matching
  `manifest.firefox.json` and the content-script design, so blocklisted pages
  are redirected before they render.

### Removed
- Bundled desktop guard source (Windows/Linux native companion app). It is now
  maintained in the standalone `codepurse/extension-guard` repository.

## [1.6.1] - 2026-06-06

Non-English adult-site blocking improvements. No algorithm-breaking changes;
all existing English blocking still works.

### Fixed
- `isLikelyDomain()` regex silently dropped IDN / punycode hostnames
  (`xn--` prefixed labels). The 93 punycode entries already present in
  `data/HOSTS.txt` are now retained at runtime.

### Added
- Browser-safe punycode / IDN helpers in `shared/hostname.js`. Decodes
  `xn--...` labels per RFC 3492 without relying on Node-only APIs.
- Shared smart-blocking module in `shared/host-keywords.js`. Single
  source of truth for adult host keywords and the safe-host bypass
  (`SAFE_HOST_TOKENS`). Loaded by both `background.js` and `content.js`
  so the service-worker early block and the on-page decision agree.
- Hostname smart filter now scans both the ASCII / punycode form AND
  the decoded Unicode form of a hostname.
- Multilingual host-keyword curation in `STRONG_HOST_KEYWORDS`:
  Chinese (`色情`), Korean (`야동`), Russian (`порно`), Arabic (`سكس`),
  Thai (`หนังโป๊`), plus transliterated Latin (`bokep`, `yadong`,
  `seks`, `sikis`).
- `AMBIGUOUS_HOST_KEYWORDS` documentation list of rejected tokens
  (`sex`, `jav`, `cam`, `tube`, `video`, `live`, etc.) with reasons,
  so future curation stays conservative.
- Curation policy header in `data/HOSTS.txt` and `data/SOURCE_NOTES.txt`
  documenting the missed-site reporting flow and the parent-domain
  rules.
- 27 new focused tests (62 total, all passing) covering punycode /
  IDN, multilingual positive coverage (CN / JP / KR / Cyrillic / AR /
  TH), strict whole-label vs substring matching, and false-positive
  guards for benign contexts.

### Changed
- `data/blocklist.json` regenerated from the curated `data/HOSTS.txt`
  using the same parser rules as the runtime. Deduplicated, validity-
  filtered, 58,075 entries. Same exact-domain coverage as the runtime
  load path; older JSON was 32,793 entries larger because it included
  duplicates and 4 invalid hostnames that the runtime would have
  silently rejected.

## [1.6.0]

Current open-source baseline at time of public-repo preparation.

Highlights already present in codebase:

- Manifest V3 Chrome and Firefox manifests
- Remote blocklist and whitelist caching
- Expanded SafeSearch enforcement across multiple search engines
- Optional DNS Protection through Cloudflare for Families
- Reddit NSFW checks
- Facebook Reels and Instagram Reels controls
- Local audit pages, stats pages, and whitelist tools
- Manual community report flow

## Older Notes

Historical release notes still exist in:

- `VERSION_NOTES.md`
- `UPGRADE_NOTES.md`
