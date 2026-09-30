// shared/text-classifier-core.js
// Pure inference core for the multilingual AI Text Blocker (model format v4).
//
// A hashed character-n-gram + word-token logistic-regression classifier
// (FastText family), trained by tools/train_text_classifier.py on real page
// text from Common Crawl. The runtime is pure arithmetic: no TF.js, no eval,
// no DOM, no chrome.*. That keeps it CSP-safe in the content script and
// testable in a Node vm sandbox (see tests/text-classifier-core.test.js).
//
// Why v4 scores a page in WINDOWS rather than as one bag of words: v3 summed
// weight x count over the whole page, so its score grew with page length.
// Every real page came out at exactly 0.0000 or 1.0000, the strictness presets
// were unreachable, and one explicit sentence inside 700 words of ordinary
// text scored 0. v4 scores ~200-character windows, each normalised by its own
// feature count, and a small second model turns the window scores into one
// calibrated page probability. The same windows are used in training, so the
// model is judged on text shaped exactly like what it was taught on.
//
// In a content-script context this file is loaded via manifest.json before
// content.js and exports `root.TextClassifier`. In Node it exports via
// module.exports. Mirrors the UMD pattern in shared/host-keywords.js.
//
// ============================ PARITY INVARIANT =============================
// Everything below MUST match tools/train_text_classifier.py exactly, or the
// learned weights will not line up with the features at inference time.
// Golden vectors (tools/seed_data/golden_vectors.json) pin it in BOTH
// languages: normalisation, tokens, window spans, and final probabilities.
//
//   1. Normalise: NFKC, lower-case, every Unicode punctuation (P*) or symbol
//      (S*) character -> space, collapse whitespace runs, trim.
//   2. Tokens: split on spaces; a token longer than maxTokenLen code points is
//      cut into maxTokenLen-code-point pieces.
//   3. Token features: char n-grams (ngramMin..ngramMax) over the CODE POINTS
//      of ' ' + token + ' ', as '#' + ngram, plus '$' + token. Tokens in a
//      space-less script (isDenseScript) start at 2-grams. Adjacent tokens
//      inside a window add '$' + a + '_' + b.
//   4. Hash = FNV-1a 32-bit over the UTF-8 bytes of the feature string;
//      bucket = hash % dim.
//   5. Windows: see windowSpans(). z = bias + scale * sum(q) / N^alpha, where
//      N is the window's feature count.
//   6. Page probability: see pageFeatures().
// Change any of these and you must retrain and bump the model version.
// ===========================================================================

(function (root) {
  'use strict';

  var FORMAT = 'fnv1a-token-ngram-window-v4';
  var DEFAULT_DIM = 1 << 18; // 262144
  var DEFAULT_NGRAM_MIN = 3;
  var DEFAULT_NGRAM_MAX = 5;

  // Window logits are clipped before they become page features, so one
  // absurdly confident window cannot swamp the page model.
  var Z_CLIP = 12;
  // A window at or above this logit (p ~ 0.9) counts as "confidently adult".
  var Z_CONFIDENT = 2.2;
  var PAGE_FEATURES = ['head_max', 'has_head', 'body_top1', 'body_top3_mean',
    'body_frac_pos', 'body_frac_confident', 'log_body_windows'];

  // Fallback only. A v4 model carries its own thresholds, chosen on held-out
  // data; thresholds from one model mean nothing to another.
  var DEFAULT_TEXT_THRESHOLDS = { block: 0.90, fuse: 0.60 };

  // Words seen on the page are scored once and remembered: pages repeat their
  // vocabulary heavily, and an SPA re-scans the same page as it changes.
  var TOKEN_CACHE_MAX = 20000;

  // ---- UTF-8 encoding from Unicode code points (matches Python str.encode) --
  // Encoded manually instead of via TextEncoder so behaviour is identical
  // everywhere (content script, worker, Node vm) with zero dependencies.
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; ) {
      var c = str.codePointAt(i);
      i += c > 0xFFFF ? 2 : 1; // advance past a surrogate pair when needed
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0x10000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        out.push(
          0xF0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3F),
          0x80 | ((c >> 6) & 0x3F),
          0x80 | (c & 0x3F)
        );
      }
    }
    return out;
  }

  // ---- FNV-1a 32-bit hash ---------------------------------------------------
  function fnv1a32(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      // Math.imul does the 32-bit multiply; >>> 0 keeps it unsigned.
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hashFeature(featureStr, dim) {
    return fnv1a32(utf8Bytes(featureStr)) % (dim || DEFAULT_DIM);
  }

  // ---- Normalisation and tokens ---------------------------------------------
  var PUNCT_SYMBOL_RE = /[\p{P}\p{S}]/gu;

  function normalizeForClassifier(text) {
    if (!text || typeof text !== 'string') return '';
    var s = text;
    try { s = s.normalize('NFKC'); } catch (_) {}
    s = s.toLowerCase();
    s = s.replace(PUNCT_SYMBOL_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function codePointLength(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0xDC00 || c > 0xDFFF) n++; // count everything but low surrogates
    }
    return n;
  }

  function tokenize(norm, maxTokenLen) {
    var out = [];
    if (!norm) return out;
    var max = maxTokenLen || 24;
    var words = norm.split(' ');
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (w.length <= max || codePointLength(w) <= max) {
        out.push(w);
        continue;
      }
      var cps = Array.from(w);
      for (var j = 0; j < cps.length; j += max) out.push(cps.slice(j, j + max).join(''));
    }
    return out;
  }

  // Chinese, Japanese, Korean and Thai are written without spaces between
  // words, and their words are mostly one or two characters long (巨乳, エロ),
  // which 3-grams barely see. Tokens in those scripts also get character
  // bigrams. Every range here is in the BMP, so charCodeAt is enough.
  function isDenseScript(c) {
    return (c >= 0x0E00 && c <= 0x0E7F) ||   // Thai
      (c >= 0x3040 && c <= 0x30FF) ||         // Hiragana, Katakana
      (c >= 0x3400 && c <= 0x4DBF) ||         // CJK extension A
      (c >= 0x4E00 && c <= 0x9FFF) ||         // CJK unified ideographs
      (c >= 0xAC00 && c <= 0xD7AF) ||         // Hangul syllables
      (c >= 0xF900 && c <= 0xFAFF);           // CJK compatibility ideographs
  }

  function hasDenseScript(token) {
    for (var i = 0; i < token.length; i++) {
      if (isDenseScript(token.charCodeAt(i))) return true;
    }
    return false;
  }

  function tokenFeatureStrings(token, nmin, nmax) {
    var feats = [];
    var cps = Array.from(' ' + token + ' ');
    var start = (nmin > 2 && hasDenseScript(token)) ? 2 : nmin;
    for (var n = start; n <= nmax; n++) {
      if (cps.length < n) break;
      for (var i = 0; i + n <= cps.length; i++) {
        feats.push('#' + cps.slice(i, i + n).join(''));
      }
    }
    feats.push('$' + token);
    return feats;
  }

  // ---- Windows --------------------------------------------------------------
  // Tokens [a, b) form a window. A window starts at token a and takes tokens
  // while they end within `chars` code points of token a's start (always at
  // least one token). The next window starts at the first token at or beyond
  // `stride` code points from a, and never later than b, so windows overlap or
  // abut and every token is covered. Measured in code points, not tokens, so a
  // window holds a similar amount of text in English, Thai and Japanese alike.
  function windowSpans(tokens, chars, stride) {
    var n = tokens.length;
    var spans = [];
    if (!n) return spans;
    var len = new Array(n);
    var off = new Array(n);
    var o = 0;
    for (var i = 0; i < n; i++) {
      len[i] = codePointLength(tokens[i]);
      off[i] = o;
      o += len[i] + 1;
    }
    var a = 0;
    for (;;) {
      var b = a + 1;
      while (b < n && off[b] + len[b] - off[a] <= chars) b++;
      spans.push([a, b]);
      if (b >= n) break;
      var next = a + 1;
      while (next < b && off[next] < off[a] + stride) next++;
      a = next;
    }
    return spans;
  }

  // ---- Base64 + varint (model weights) --------------------------------------
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = null;

  function base64ToBytes(str) {
    if (!B64_LOOKUP) {
      B64_LOOKUP = new Int16Array(128).fill(-1);
      for (var k = 0; k < B64.length; k++) B64_LOOKUP[B64.charCodeAt(k)] = k;
    }
    var clean = String(str || '').replace(/[^A-Za-z0-9+/]/g, '');
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var buf = 0, bits = 0, pos = 0;
    for (var i = 0; i < clean.length; i++) {
      buf = ((buf << 6) | B64_LOOKUP[clean.charCodeAt(i)]) & 0xFFFFFF;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[pos++] = (buf >> bits) & 0xFF;
      }
    }
    return pos === out.length ? out : out.subarray(0, pos);
  }

  // ---- Model loading --------------------------------------------------------
  // Returns null on anything malformed, so the caller fails open.
  function loadModel(json) {
    if (!json || typeof json !== 'object' || json.format !== FORMAT) return null;
    var dim = json.dim | 0;
    var count = json.count | 0;
    if (dim <= 0 || count < 0 || typeof json.scale !== 'number') return null;
    var page = json.page;
    if (!page || !Array.isArray(page.weights) || !Array.isArray(page.features) ||
        page.features.join(',') !== PAGE_FEATURES.join(',')) {
      return null; // a page model for a different feature set would be garbage
    }
    var dense = new Int8Array(dim);
    try {
      var bucketBytes = base64ToBytes(json.buckets);
      var qBytes = base64ToBytes(json.q);
      if (qBytes.length !== count) return null;
      var pos = 0;
      var bucket = 0;
      for (var i = 0; i < count; i++) {
        var delta = 0;
        var shift = 1;
        var byte;
        do {
          if (pos >= bucketBytes.length) return null;
          byte = bucketBytes[pos++];
          delta += (byte & 0x7F) * shift;
          shift *= 128;
        } while (byte & 0x80);
        bucket += delta;
        if (bucket >= dim) return null;
        var q = qBytes[i];
        dense[bucket] = q > 127 ? q - 256 : q;
      }
    } catch (_) {
      return null;
    }
    return {
      version: json.version || 0,
      dim: dim,
      ngramMin: json.ngramMin || DEFAULT_NGRAM_MIN,
      ngramMax: json.ngramMax || DEFAULT_NGRAM_MAX,
      maxTokenLen: json.maxTokenLen || 24,
      windowChars: json.windowChars || 200,
      windowStride: json.windowStride || 100,
      alpha: typeof json.alpha === 'number' ? json.alpha : 1,
      bias: typeof json.bias === 'number' ? json.bias : 0,
      scale: json.scale,
      dense: dense,
      size: count,
      headMaxChars: json.headMaxChars || 1000,
      maxChars: json.maxChars || 8000,
      page: { bias: page.bias || 0, weights: page.weights.slice() },
      thresholds: json.thresholds || null,
      _tokenCache: new Map()
    };
  }

  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    var e = Math.exp(z);
    return e / (1 + e);
  }

  // Sum of this token's quantised weights (an integer) and its feature count.
  function tokenStats(token, model) {
    var cache = model._tokenCache;
    var hit = cache.get(token);
    if (hit) return hit;
    var feats = tokenFeatureStrings(token, model.ngramMin, model.ngramMax);
    var q = 0;
    for (var i = 0; i < feats.length; i++) q += model.dense[hashFeature(feats[i], model.dim)];
    var st = { q: q, n: feats.length };
    if (cache.size >= TOKEN_CACHE_MAX) cache.clear();
    cache.set(token, st);
    return st;
  }

  // ---- Scoring --------------------------------------------------------------
  // Scores every window of one segment. Prefix sums make each window O(1), so
  // the whole segment costs one pass over its tokens.
  function scoreSegment(text, model) {
    var norm = normalizeForClassifier(text);
    var tokens = tokenize(norm, model.maxTokenLen);
    var n = tokens.length;
    var result = { tokens: tokens, stats: [], spans: [], z: [] };
    if (!n) return result;
    var ps = new Float64Array(n + 1); // prefix sums of token q (integers)
    var pn = new Float64Array(n + 1); // prefix sums of token feature counts
    var pb = new Float64Array(n);     // prefix sums of bigram q
    for (var i = 0; i < n; i++) {
      var st = tokenStats(tokens[i], model);
      result.stats.push(st);
      ps[i + 1] = ps[i] + st.q;
      pn[i + 1] = pn[i] + st.n;
      if (i + 1 < n) {
        pb[i + 1] = pb[i] + model.dense[hashFeature('$' + tokens[i] + '_' + tokens[i + 1], model.dim)];
      }
    }
    var spans = windowSpans(tokens, model.windowChars, model.windowStride);
    for (var w = 0; w < spans.length; w++) {
      var a = spans[w][0];
      var b = spans[w][1];
      var qSum = (ps[b] - ps[a]) + (pb[b - 1] - pb[a]);
      var count = (pn[b] - pn[a]) + (b - a - 1);
      result.spans.push(spans[w]);
      result.z.push(model.bias + (model.scale * qSum) / Math.pow(count, model.alpha));
    }
    return result;
  }

  function clipZ(z) {
    return z > Z_CLIP ? Z_CLIP : (z < -Z_CLIP ? -Z_CLIP : z);
  }

  // Turns window logits into the page model's inputs. Order == PAGE_FEATURES.
  function pageFeatures(headZ, bodyZ) {
    var hasHead = headZ.length > 0 ? 1 : 0;
    var headMax = -Z_CLIP;
    for (var h = 0; h < headZ.length; h++) headMax = Math.max(headMax, clipZ(headZ[h]));
    var sorted = [];
    for (var i = 0; i < bodyZ.length; i++) sorted.push(clipZ(bodyZ[i]));
    sorted.sort(function (x, y) { return y - x; });
    var nb = sorted.length;
    var top1 = nb ? sorted[0] : -Z_CLIP;
    var k = Math.min(3, nb);
    var top3 = 0;
    for (var t = 0; t < k; t++) top3 += sorted[t];
    top3 = k ? top3 / k : -Z_CLIP;
    var pos = 0;
    var confident = 0;
    for (var j = 0; j < nb; j++) {
      if (sorted[j] >= 0) pos++;
      if (sorted[j] >= Z_CONFIDENT) confident++;
    }
    return [
      hasHead ? headMax : 0,
      hasHead,
      top1,
      top3,
      nb ? pos / nb : 0,
      nb ? confident / nb : 0,
      Math.log(1 + nb)
    ];
  }

  // parts: { head, body } -- head is the title + meta tags, body the visible
  // text. Returns { prob, head, body, features } or null without a model.
  function scorePage(parts, model) {
    if (!model || !model.dense || !model.page) return null;
    var head = (parts && parts.head) || '';
    var body = (parts && parts.body) || '';
    if (head.length > model.headMaxChars) head = head.slice(0, model.headMaxChars);
    var bodyMax = Math.max(0, model.maxChars - head.length);
    if (body.length > bodyMax) body = body.slice(0, bodyMax);
    var hs = scoreSegment(head, model);
    var bs = scoreSegment(body, model);
    if (!hs.z.length && !bs.z.length) {
      return { prob: 0, head: hs, body: bs, features: null, empty: true };
    }
    var f = pageFeatures(hs.z, bs.z);
    var z = model.page.bias;
    for (var i = 0; i < f.length; i++) z += model.page.weights[i] * f[i];
    return { prob: sigmoid(z), head: hs, body: bs, features: f, empty: false };
  }

  // Backwards-compatible single-string entry point: treats the text as body.
  // Returns -1 without a usable model so callers can tell "no opinion" apart
  // from "safe".
  function scoreText(text, model) {
    var r = scorePage({ head: '', body: typeof text === 'string' ? text : '' }, model);
    return r ? r.prob : -1;
  }

  // ---- Verdict --------------------------------------------------------------
  //   'block'      -> confident enough to block on text alone
  //   'fuse-block' -> moderately confident, corroborated by >=1 blocked image
  //   'allow'      -> otherwise (or no model opinion)
  function verdictForText(prob, thresholds, imageBlockCount) {
    if (typeof prob !== 'number' || prob < 0) return 'allow';
    var t = thresholds || DEFAULT_TEXT_THRESHOLDS;
    var blockT = typeof t.block === 'number' ? t.block : DEFAULT_TEXT_THRESHOLDS.block;
    var fuseT = typeof t.fuse === 'number' ? t.fuse : DEFAULT_TEXT_THRESHOLDS.fuse;
    if (prob >= blockT) return 'block';
    if (prob >= fuseT && (imageBlockCount || 0) >= 1) return 'fuse-block';
    return 'allow';
  }

  // The model's thresholds for a strictness level, or null if it has none.
  function thresholdsFor(model, level) {
    var all = model && model.thresholds;
    if (!all) return null;
    var key = String(level || '').toLowerCase();
    return all[key] || all.balanced || null;
  }

  // ---- Explainability -------------------------------------------------------
  // The words that pushed the most confident windows toward "adult". Because
  // the model is linear, a word's push is exactly the sum of its features'
  // weights, so this is an attribution, not a guess. Words below `minShare`
  // of the strongest are dropped so the list never pads out with noise.
  function explain(result, topK, minShare) {
    if (!result || result.empty) return [];
    var k = topK > 0 ? topK : 5;
    var share = typeof minShare === 'number' ? minShare : 0.15;
    var windows = [];
    [result.head, result.body].forEach(function (seg) {
      for (var w = 0; w < seg.z.length; w++) windows.push({ seg: seg, span: seg.spans[w], z: seg.z[w] });
    });
    windows.sort(function (x, y) { return y.z - x.z; });
    var seen = new Map();
    for (var i = 0; i < windows.length && i < 3; i++) {
      if (windows[i].z < 0) break;
      var seg = windows[i].seg;
      for (var t = windows[i].span[0]; t < windows[i].span[1]; t++) {
        var tok = seg.tokens[t];
        var st = seg.stats[t];
        if (!seen.has(tok) && st.q > 0) seen.set(tok, st.q / st.n);
      }
    }
    var out = [];
    seen.forEach(function (c, tok) { out.push({ feature: tok, contribution: c }); });
    out.sort(function (a, b) { return b.contribution - a.contribution; });
    if (out.length > 0) {
      var floor = out[0].contribution * share;
      out = out.filter(function (e) { return e.contribution >= floor; });
    }
    if (out.length > k) out.length = k;
    return out;
  }

  function topContributors(textOrParts, model, topK, minShare) {
    var parts = typeof textOrParts === 'string' ? { head: '', body: textOrParts } : textOrParts;
    return explain(scorePage(parts, model), topK, minShare);
  }

  var exported = {
    FORMAT: FORMAT,
    DEFAULT_DIM: DEFAULT_DIM,
    DEFAULT_NGRAM_MIN: DEFAULT_NGRAM_MIN,
    DEFAULT_NGRAM_MAX: DEFAULT_NGRAM_MAX,
    DEFAULT_TEXT_THRESHOLDS: DEFAULT_TEXT_THRESHOLDS,
    PAGE_FEATURES: PAGE_FEATURES,
    utf8Bytes: utf8Bytes,
    fnv1a32: fnv1a32,
    hashFeature: hashFeature,
    normalizeForClassifier: normalizeForClassifier,
    tokenize: tokenize,
    tokenFeatureStrings: tokenFeatureStrings,
    windowSpans: windowSpans,
    base64ToBytes: base64ToBytes,
    loadModel: loadModel,
    scoreSegment: scoreSegment,
    pageFeatures: pageFeatures,
    scorePage: scorePage,
    scoreText: scoreText,
    verdictForText: verdictForText,
    thresholdsFor: thresholdsFor,
    explain: explain,
    topContributors: topContributors
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.TextClassifier = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
