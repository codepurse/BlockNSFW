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
//   Porn + Hentai >= 0.60  → block  (combined explicit signal)
//   Sexy         >= 0.90   → block  (suggestive but non-explicit)
//
// IMPORTANT: NSFW.js's "Sexy" class is very trigger-happy — ordinary photos of
// people, fashion, fitness, beaches and portraits routinely score 0.6-0.8 Sexy.
// The Sexy bar is therefore deliberately high (0.90) to avoid blocking benign
// images; the reliable explicit signal is Porn+Hentai. Lowering these trades
// fewer misses for more false positives (that's what the "strict" preset does).
//
// NOTE: NSFW.js's "Drawing" and "Neutral" are *safe* classes. A high Drawing
// score means "confidently a safe illustration", not "hentai" — hentai scores
// high on the Hentai class instead. So Drawing must never trigger a block, or
// ordinary cartoons, logos, and diagrams get filtered.
//
// Thresholds are overridable via the `thresholds` argument so users can
// tune strictness in the options page.
const DEFAULT_THRESHOLDS = {
  pornHentai: 0.60,
  sexy: 0.90
};

// The vit384 model answers a single question ("how likely is this NSFW?"), so
// it needs one bar rather than the class arithmetic above.
//
// 0.30 is calibrated, not chosen for feel: safe photos score in a tight
// 0.05-0.09 band on this model, and Marqo's own evaluation holds ~98% precision
// AND recall anywhere from 0.1 to 0.9. A higher bar therefore buys no accuracy
// and only loses borderline content — which is exactly how the first cut
// (0.70) ended up less accurate in practice than the five-class MobileNet it
// was meant to beat. See the threshold presets in shared/ai-image-models.js.
const DEFAULT_BINARY_THRESHOLDS = {
  nsfw: 0.30
};

// Score → verdict, for either model's score shape.
//
// Dispatch is on the SCORES, not on a caller-supplied model id, because the
// scores are what get cached: a 24h-old entry has to be interpretable on its
// own. The two shapes are disjoint (NSFW.js emits Porn/Hentai/Sexy/Drawing/
// Neutral, the ViT emits NSFW/SFW), so presence of an `NSFW` key identifies
// the binary model unambiguously.
//
// A `thresholds` object whose bars belong to the *other* model is ignored in
// favour of that model's defaults, so a stale threshold object can never make
// the bar accidentally unreachable (e.g. `{sexy: 0.9}` applied to a binary
// score would otherwise leave `nsfw` undefined and block nothing).
function verdictFor(scores, thresholds) {
  if (!scores) return 'allow';

  if (Object.prototype.hasOwnProperty.call(scores, 'NSFW')) {
    const supplied = thresholds && typeof thresholds.nsfw === 'number'
      ? { nsfw: thresholds.nsfw }
      : null;
    const t = { ...DEFAULT_BINARY_THRESHOLDS, ...(supplied || {}) };
    return (scores.NSFW || 0) >= t.nsfw ? 'block' : 'allow';
  }

  const supplied = thresholds || {};
  const t = {
    pornHentai: typeof supplied.pornHentai === 'number'
      ? supplied.pornHentai
      : DEFAULT_THRESHOLDS.pornHentai,
    sexy: typeof supplied.sexy === 'number' ? supplied.sexy : DEFAULT_THRESHOLDS.sexy
  };
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
