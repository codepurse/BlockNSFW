# Chrome Extension Upgrade Notes

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

