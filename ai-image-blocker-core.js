// Pure helpers for the AI Image Blocker. No DOM, no chrome.*, no Worker —
// safe to load in a Node vm sandbox for testing. Loaded in manifest.json
// before ai-image-blocker.js so its top-level functions are reachable.

// Minimum natural dimension for an image to be worth scanning. Below this
// the model is unreliable and the user almost certainly wants the image
// rendered (icons, avatars, spinners).
const MIN_NATURAL_DIMENSION = 64;

// Class applied to <img> elements the model flagged.
const BLOCKED_CLASS = 'pblocker-ai-blocked';

// Score → verdict.
//   Porn + Hentai >= 0.50  → block  (combined explicit signal)
//   Sexy         >= 0.70   → block  (suggestive but non-explicit; higher bar
//                                     so swimwear/fashion/fitness pass)
//
// NOTE: NSFW.js's "Drawing" and "Neutral" are *safe* classes. A high Drawing
// score means "confidently a safe illustration", not "hentai" — hentai scores
// high on the Hentai class instead. So Drawing must never trigger a block, or
// ordinary cartoons, logos, and diagrams get filtered.
//
// Thresholds are overridable via the `thresholds` argument so users can
// tune strictness in the options page.
const DEFAULT_THRESHOLDS = {
  pornHentai: 0.50,
  sexy: 0.70
};

function verdictFor(scores, thresholds) {
  if (!scores) return 'allow';
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const pornHentai = (scores.Porn || 0) + (scores.Hentai || 0);
  if (pornHentai >= t.pornHentai) return 'block';
  if ((scores.Sexy || 0) >= t.sexy) return 'block';
  return 'allow';
}

// First-party check using simple suffix matching (not the Public Suffix List).
// Kept as a helper because other call sites may still need registrable-host
// comparisons, but same-origin images must not be skipped by the AI blocker:
// many adult/self-hosted sites serve explicit media from their own domain.
function firstPartyMatch(imageHost, pageHost) {
  if (!imageHost || !pageHost) return false;
  if (imageHost === pageHost) return true;
  if (imageHost.endsWith('.' + pageHost)) return true;
  if (pageHost.endsWith('.' + imageHost)) return true;
  return false;
}

// Decide whether an image should be skipped without classification.
// `opts` shape:
//   { aiImageBlocker: boolean, degraded?: boolean, trustedDomains: Set<string>,
//     pageHost?: string, lru?: Map<string, any> }
// `img` shape (plain object, not necessarily HTMLImageElement):
//   { src, currentSrc, naturalWidth, naturalHeight, complete, offsetParent, hostname }
function shouldSkipImage(img, opts) {
  if (!opts || opts.aiImageBlocker === false) return true;
  if (opts.degraded) return true;

  const src = (img && (img.currentSrc || img.src)) || '';
  if (!src) return true;
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;

  // Only skip for tiny dimensions, never for unloaded (naturalWidth == 0) images.
  if (img.naturalWidth > 0 && img.naturalWidth < MIN_NATURAL_DIMENSION) return true;
  if (img.naturalHeight > 0 && img.naturalHeight < MIN_NATURAL_DIMENSION) return true;

  // Hidden / not-rendered elements (display:none, detached) report a null
  // offsetParent — nothing is on screen to filter, so skip. `undefined` means
  // the caller supplied no visibility info, so analyze to be safe.
  if (img.offsetParent === null) return true;

  const host = (img.hostname || '').toLowerCase();
  if (host && opts.trustedDomains && opts.trustedDomains.has(host)) return true;

  if (opts.lru && opts.lru.has(src)) return true;

  return false;
}

// Insert into a Map with a hard cap. When full, the oldest entry (first
// insertion) is dropped. Updating an existing key is a no-op for ordering
// — the key keeps its original position, which is the desired LRU
// semantic for our cache (we only want freshness, not strict LRU).
function setWithCap(map, key, value, maxSize) {
  if (map.has(key)) {
    map.set(key, value);
    return;
  }
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, value);
}
