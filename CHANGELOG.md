# Changelog

All notable project changes should be documented here going forward.

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
