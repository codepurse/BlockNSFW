# Changelog

All notable project changes should be documented here going forward.

## [Unreleased]

### Added
- **Images from sites you blocked yourself are now blocked too.** Adding a site
  to your custom blocklist stopped you visiting it, but its pictures still came
  through everywhere else — most visibly in image search, where a blocked site's
  results sat in the grid untouched. The two halves of the extension were never
  introduced: navigation checked your list, while the image and search-result
  filters only ever consulted the built-in blocklist. They now share the same
  answer, so a site you block is blocked as a *source* — its results are hidden
  in image search, and its images are hidden wherever they are embedded or
  hotlinked. Blocking a site by hand also now outranks the built-in trusted-CDN
  allowlist, on the grounds that typing a domain in yourself is about as
  explicit as an instruction gets.
- Alongside that, requests for images and video from sites on your custom
  blocklist are now refused at the network level rather than hidden after they
  arrive. This catches what page-level filtering structurally cannot: the
  full-size image behind a search result, and pictures hotlinked into forums and
  feeds. Page navigation is deliberately left alone so you still get the usual
  blocked page instead of a browser error. Entries scoped to a path
  (`example.com/gallery`) keep their old page-level handling, since blocking a
  whole host's images would be broader than what you asked for.

  One honest limit: search engines serve result thumbnails from their own
  servers, not from the site the picture came from, so those are matched by
  reading the source attributed to each result. That works, but it depends on
  page structure the engines change without notice. Requested in
  [#23](https://github.com/codepurse/BlockNSFW/issues/23).

## [1.7.3] - 2026-08-08

### Added
- Optional access code, a second layer on top of the PIN. When enabled, a
  freshly generated random code (32, 64 or 128 characters) must be retyped by
  hand before the change goes through. By default it guards only the decisive
  actions — turning blocking off, clearing the PIN, or weakening the code
  itself — so routine edits are unaffected; a switch extends it to every
  weakening change. The default is deliberately narrow: a code demanded on
  every small edit trains people to resent the feature and switch it off, which
  protects nobody. The code is not a
  secret — it is displayed in full above the input. The deterrent is the
  deliberate effort of typing it, so copy and paste are blocked (paste, drag,
  drop and Ctrl/Cmd+V on the input; selection, copy and cut on the displayed
  code), and a wrong answer issues a brand new code rather than letting the
  same one be retried. Off by default; turning it off or shortening it requires
  passing the challenge. Characters that look alike (`0`/`O`, `1`/`l`/`I`) are
  excluded so retyping is effort, not guesswork.
- Custom blocklist, blocked words and trusted domains lists are now
  de-duplicated and sorted A-Z when saved, and the tidied list is shown back in
  the box immediately. Duplicate detection is case-insensitive, matching how the
  lists are actually used, so `Apricot` and `apricot` count as one entry.

### Fixed
- **Settings could be weakened without the PIN.** Several changes that reduce
  protection were not covered by the PIN gate, so a blocked word could be
  deleted in seconds and put back later. All of these now require the PIN:
  removing custom blocked words (both the main save and the dedicated save
  button), adding a trusted image domain, lowering image filtering or either AI
  strictness level, turning off DNS Protection, switching the blocked page to a
  custom URL or changing that URL, and uploading custom HTML for the blocked
  page. Clearing the PIN now also has to pass the access code when one is set.
  Reported by a user who found they could edit their own blocked word list
  during a moment of temptation.
- **AI text detector blocked ordinary sites**, most visibly `m.youtube.com` at
  99% confidence. The v3 model's vocabulary is inverted: measured in isolation
  it scores `videos` (+8.27) as a stronger adult signal than `nude` (+0.27),
  `naked` (-0.44) or `erotic` (-0.60), and `youtube` (+3.74) inherits weight
  from `tube` purely through character n-grams. The cause is the training data —
  adult phrases average 1.7 words per line against 8.0 for the benign ones, so
  short generic media words absorbed the positive signal. No threshold separates
  that, so text blocking has been restricted rather than retuned (see Changed).
  A retrained model is planned.

### Changed
- **The AI text blocker no longer blocks a page on text alone.** Until the model
  is retrained, a high text score only blocks when the AI image scanner has
  independently flagged an image on the same page. This makes the text detector
  weaker and it will miss adult pages it would previously have caught; the other
  layers (blocklist, keywords, URL matching and the image scanner) are
  unaffected. The trade is deliberate while the model cannot be trusted alone.
- Changes that *tighten* protection remain free of any prompt. Adding a blocked
  word or domain, raising strictness, and turning protections on never ask for
  the PIN or access code — only weakening does. This is intentional: making it
  harder to strengthen your own protection would work against the point of the
  extension.

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
