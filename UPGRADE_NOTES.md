# Chrome Extension Upgrade Notes

## Future Work

These items are intentionally on hold. Captured here so they are not
forgotten, but not part of the current release.

### P2 - Page-Level Fallback (on hold)
Higher false-positive risk than domain-level work. Needs design review
before implementation. Sub-tasks:
- Keep the hostname filter as the primary defense. Page-level scan is a
  fallback for clean-domain doorway pages.
- Look at more page signals: `<title>`, `<meta>`, first body lines, image
  `alt` / `aria-label`.
- Phrase-first matching for CJK / Arabic / Thai (no whitespace in those
  scripts).
- Conservative thresholds: one strong explicit phrase = block; one weak
  word alone = don't block, but 3+ weak signals co-occurring = block.
- Keep the safe-context bypass for recovery / education / support pages.

### Manual QA Checklist (needs a real browser)
- IDN / punycode exact-domain block works on a known `xn--` adult site.
- Host-keyword block works on a non-English hostname not in the blocklist.
- Sparse / image-heavy pages still block on hostname alone.
- Support / recovery / education pages are NOT blocked.
- No English regression: known English adult sites still block.
- `dnsFilterEnabled` stays optional.

### Non-Goals (project boundaries)
- Do not add generic page language detection.
- Do not block on broad Unicode substring matches alone.
- Do not trust DNS filtering as the only protection layer for
  non-English sites.

## What's New (Unreleased)

### 🌐 Non-English Blocking Improvements

**IDN / Punycode exact-domain coverage**
- Fixed `isLikelyDomain()` regex that was silently dropping `xn--`
  prefixed hostnames. All 93 punycode entries already present in
  `data/HOSTS.txt` are now retained and used at runtime.
- Added a browser-safe punycode / IDN decoder in `shared/hostname.js`
  (RFC 3492) so the smart filter can scan the decoded Unicode form
  of a hostname, not just the ASCII / punycode form.

**Multilingual hostname smart filter**
- Curation now splits keywords into two classes:
  - `STRONG_HOST_KEYWORDS` (used by the filter)
  - `AMBIGUOUS_HOST_KEYWORDS` (documentation-only reject list with
    reasons - prevents future accidental additions of `sex`, `jav`,
    `cam`, `tube`, `video`, `live`, etc.)
- New non-Latin adult tokens: `色情` (Chinese), `야동` (Korean),
  `порно` (Russian), `سكس` (Arabic), `หนังโป๊` (Thai).
- Plus transliterated Latin tokens: `bokep` (Indonesian), `yadong`
  (Korean), `seks` (Polish / Turkish), `sikis` (Turkish).
- Strict matching rules: whole-label match, hyphen-bounded match, no
  broad substring match for adult tokens. `essex.com` still does NOT
  match `sex` (sex is not even a strong token); `pornreports.com`
  does NOT match `porn`; `my-porn-tube.com` does NOT match because
  `porn` is mid-label, not at a boundary.
- Safe-host bypass (`SAFE_HOST_TOKENS`) preserved and now shared
  between the service worker and the content script, so a
  `porn-recovery.org` is correctly NOT blocked.

**Data pipeline**
- `data/HOSTS.txt` gained a 27-line curation policy header.
- `data/SOURCE_NOTES.txt` gained "Curation rules", "Missed-site
  reporting flow", and "Packaged fallback" sections.
- `blocklist.json` regenerated from the curated source. Deduplicated
  and validity-filtered - 58,075 entries that exactly match what the
  runtime parser would load.

**Test coverage**
- 27 new focused tests added. Total 62, all passing.
- New file `tests/host-keywords.test.js` covers punycode / IDN,
  multilingual positive coverage (CN / JP / KR / Cyrillic / AR /
  TH), strict whole-label vs substring matching, and false-positive
  guards.
- `tests/utilities.test.js` extended for `isLikelyDomain()` punycode
  cases.
- `tests/parse-hosts.test.js` extended for punycode host survival and
  malformed IDN-like garbage rejection.

**No regressions**
- All existing English-domain blocking still works.
- `dnsFilterEnabled` remains an optional fallback, not required.

## What's New

### 🎯 Improved Blocking Accuracy

**Context-Aware Keyword Detection**
- No longer blocks recovery/support articles about overcoming addiction
- Distinguishes "how to quit porn" from "watch free porn" using contextual analysis
- Safe context keywords: help, recovery, quit, overcome, support, therapy, education, etc.
- Risk context keywords: free, watch, stream, download, live, cam, etc.

**Enhanced Domain Blocking**
- Now uses the massive [Anti-Porn HOSTS File](https://github.com/4skinSkywalker/Anti-Porn-HOSTS-File) (100k+ domains)
- Auto-updates weekly from GitHub (cached locally for 7 days)
- Chunked storage (5000 domains per chunk) to avoid browser limits
- Fast Set-based lookups instead of slow regex matching

### 🚀 Performance Improvements

**Optimized Architecture**
- Background worker maintains canonical blocklist
- Content script requests snapshot on demand
- Instant host-level checks at `document_start` prevent page flash
- Caching system with automatic invalidation

**Smart Caching**
- Pattern cache for compiled regexes
- URL check cache with version tracking
- Keyword check cache for hostname analysis
- Max 1000 entries per cache to prevent memory bloat

### 🎨 User Experience

**Buy Me a Coffee Button**
- Added to popup for easy support (https://buymeacoffee.com/monolab.co)
- Styled with yellow/gold theme
- Opens in new tab

### 🛠️ Developer Tools

**Verbose Logging Toggle**
- Debug logging now disabled by default to avoid console noise
- New "Enable verbose logging" switch in `options.html`
- Toggle persists to `pblocker_settings.debugMode`
- Content scripts watch for changes and enable logs on demand

### 🔧 Technical Details

**New Message Types**
- `get_blocklist_snapshot`: Content script requests current blocklist
- `should_block_url`: Check if a URL should be blocked
- `refresh_remote_blocklist`: Force refresh from GitHub

**Storage Keys**
- `pblocker_blocklist_meta_v2`: Metadata (version, timestamp, chunk count)
- `pblocker_blocklist_chunk_v2_0`, `_1`, etc.: Domain chunks

## Testing Checklist

1. ✅ Visit a recovery article (e.g., "how to overcome porn addiction") - should NOT block
2. ✅ Visit an actual adult site - should block immediately
3. ✅ Check browser console for "Blocklist snapshot loaded X domains"
4. ✅ Test Buy Me a Coffee button opens correct URL
5. ✅ Verify context-aware filtering in search results

## Migration Notes

- Old `blocklist.json` still used as fallback if remote fetch fails
- Existing settings and whitelist preserved
- No user action required - upgrade happens automatically
- First load may take a few seconds to download remote blocklist

## Files Changed

### Background Worker
- `background.js`: Added remote blocklist fetching, chunked storage, context-aware logic

### Content Script
- `content.js`: Updated to use blocklist snapshot, improved keyword detection

### UI
- `popup.html`: Added Buy Me a Coffee button with styling

## Performance Metrics

- **Blocklist size**: ~100,000+ domains (vs ~30 before)
- **Lookup speed**: O(1) Set lookup vs O(n) regex matching
- **Memory usage**: Chunked storage prevents single large object
- **Update frequency**: Weekly automatic refresh
- **Cache TTL**: 7 days

## Debugging

Open browser console and run:
```javascript
// Check current stats
window.PBlocker.getStats()

// Test keyword detection
window.PBlocker.testKeywords("how to overcome porn addiction") // Should return false
window.PBlocker.testKeywords("watch free porn videos") // Should return true

// Test URL blocking
window.PBlocker.testURL("https://example.com")
```

## Support

If you encounter issues:
1. Check browser console for errors
2. Verify blocklist loaded: Look for "Blocklist snapshot loaded" message
3. Try refreshing the page
4. Clear extension storage and reload

---

**Last Updated**: 2025-10-30
**Version**: 1.2.0 (Chrome)

