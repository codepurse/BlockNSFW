
## What's New (Unreleased)
- IDN / punycode exact-domain coverage: the runtime `isLikelyDomain()`
  regex no longer silently drops `xn--` prefixed hostnames, so all
  93 punycode entries already in `data/HOSTS.txt` are now retained
  and used for blocking.
- Multilingual hostname smart filter: added high-confidence adult
  tokens in Chinese (`色情`), Korean (`야동`), Russian (`порно`),
  Arabic (`سكس`), and Thai (`หนังโป๊`) script, plus transliterated
  Latin (`bokep`, `yadong`, `seks`, `sikis`). The filter now scans
  the decoded Unicode form of an IDN hostname, not just the ASCII
  / punycode form.
- Shared smart-blocking module in `shared/host-keywords.js`: the
  service-worker early block and the on-page content-script decision
  now use the same keyword list and the same safe-host bypass logic.
- Curation policy documented in `data/HOSTS.txt` and
  `data/SOURCE_NOTES.txt`. Each new non-English adult domain is
  vetted individually and added on a per-report basis.
- 27 new focused tests (62 total, all passing) covering punycode /
  IDN, multilingual positive coverage, strict whole-label vs
  substring matching, and false-positive guards.

## What's New
- Expanded Safe Search support to AOL Search, Presearch, and Qwant.
- Added stricter YouTube 18+ and adult-content filtering with enforced Restricted Mode.
- Added Facebook Reels blocking to hide reel pages and reel entry points.
- Added Instagram Reels blocking (off by default) with the same redirect and DOM filtering behavior.