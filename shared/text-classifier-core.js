// shared/text-classifier-core.js
// Pure inference core for the multilingual AI Text Blocker.
//
// A hashed character-n-gram + word-token logistic-regression classifier
// (FastText family). It is a genuinely machine-learned model — the weights in
// text-model.json are produced by tools/train_text_classifier.py — but the
// runtime is pure arithmetic: no TF.js, no eval, no DOM, no chrome.*. That
// keeps it CSP-safe in the content script and testable in a Node vm sandbox
// (see tests/text-classifier-core.test.js).
//
// In a content-script context this file is loaded via manifest.json before
// content.js and exports `root.TextClassifier`. In Node it exports via
// module.exports. Mirrors the UMD pattern in shared/host-keywords.js.
//
// ============================ HASHING INVARIANT ============================
// The feature hashing here MUST match tools/train_text_classifier.py exactly,
// or the learned weights will not line up with the features at inference time.
// The invariant, covered by golden-vector parity tests in BOTH languages
// (tools/seed_data/golden_vectors.json):
//
//   1. Normalize: NFKC, lower-case, collapse whitespace runs to a single
//      space, trim. (JS String.normalize('NFKC')/toLowerCase ≈ Python
//      unicodedata.normalize('NFKC')/str.lower — equivalent for the scripts
//      we target.)
//   2. Char n-grams are built over Unicode CODE POINTS (JS Array.from / Python
//      list), never UTF-16 code units, so surrogate pairs never split.
//   3. Feature strings are namespaced: '#' + ngram for char n-grams,
//      '$' + token (and '$' + tokenA + '_' + tokenB) for word features.
//   4. Hash = FNV-1a 32-bit over the UTF-8 bytes of the feature string;
//      bucket = hash % dim.
// Change any of these and you must retrain and bump the model version.
// ===========================================================================

(function (root) {
  'use strict';

  // dim must equal the trainer's dim (2^18). Kept here only as a default for
  // callers that build a model object by hand; the live value always comes
  // from the loaded model.
  var DEFAULT_DIM = 1 << 18; // 262144
  var DEFAULT_NGRAM_MIN = 3;
  var DEFAULT_NGRAM_MAX = 5;

  // Strictness presets -> thresholds. Lower = blocks more. `fuse` is the
  // lower bar that only blocks when corroborated by AI image evidence.
  var DEFAULT_TEXT_THRESHOLDS = { block: 0.90, fuse: 0.60 };

  // ---- UTF-8 encoding from Unicode code points (matches Python str.encode) --
  // We encode manually instead of relying on TextEncoder so behaviour is
  // identical everywhere (content script, worker, Node vm) with zero deps.
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; ) {
      var c = str.codePointAt(i);
      i += c > 0xFFFF ? 2 : 1; // advance past surrogate pair when needed
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

  // ---- Normalization --------------------------------------------------------
  function normalizeForClassifier(text) {
    if (!text || typeof text !== 'string') return '';
    var s = text;
    try { s = s.normalize('NFKC'); } catch (_) {}
    s = s.toLowerCase();
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // ---- Feature extraction ---------------------------------------------------
  // Returns Map<bucket, count>. Char n-grams run over a space-padded code-point
  // array so word starts/ends are captured. Word features add unigrams and
  // adjacent bigrams.
  function extractFeatures(norm, opts) {
    opts = opts || {};
    var dim = opts.dim || DEFAULT_DIM;
    var nmin = opts.ngramMin || DEFAULT_NGRAM_MIN;
    var nmax = opts.ngramMax || DEFAULT_NGRAM_MAX;
    var feats = new Map();

    function add(featureStr) {
      var b = hashFeature(featureStr, dim);
      feats.set(b, (feats.get(b) || 0) + 1);
    }

    if (norm) {
      var cps = Array.from(' ' + norm + ' '); // code points, not UTF-16 units
      for (var n = nmin; n <= nmax; n++) {
        if (cps.length < n) break;
        for (var i = 0; i + n <= cps.length; i++) {
          add('#' + cps.slice(i, i + n).join(''));
        }
      }
      var words = norm.split(' ');
      for (var w = 0; w < words.length; w++) {
        if (!words[w]) continue;
        add('$' + words[w]);
        if (w + 1 < words.length && words[w + 1]) {
          add('$' + words[w] + '_' + words[w + 1]);
        }
      }
    }
    return feats;
  }

  // ---- Model loading --------------------------------------------------------
  // json: { version, dim, ngramMin, ngramMax, bias, scale, weights:[[bucket,int8],...] }
  // Dequantizes int8 weights (q * scale) into a Map<bucket, float>. Returns null
  // on malformed input so callers can fail open.
  function loadModel(json) {
    if (!json || typeof json !== 'object') return null;
    var dim = json.dim || DEFAULT_DIM;
    var scale = typeof json.scale === 'number' ? json.scale : 1;
    var weights = new Map();
    var raw = json.weights;
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var pair = raw[i];
        if (!pair || pair.length < 2) continue;
        var bucket = pair[0] | 0;
        var q = pair[1];
        if (typeof q !== 'number') continue;
        weights.set(bucket, q * scale);
      }
    } else if (raw && typeof raw === 'object') {
      // Allow an object form { bucket: weight } (already-dequantized floats).
      for (var key in raw) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) {
          weights.set(parseInt(key, 10), raw[key] * scale);
        }
      }
    } else {
      return null;
    }
    return {
      version: json.version || 0,
      dim: dim,
      ngramMin: json.ngramMin || DEFAULT_NGRAM_MIN,
      ngramMax: json.ngramMax || DEFAULT_NGRAM_MAX,
      bias: typeof json.bias === 'number' ? json.bias : 0,
      weights: weights
    };
  }

  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    var e = Math.exp(z);
    return e / (1 + e);
  }

  // ---- Scoring --------------------------------------------------------------
  // Returns the model's adult probability in [0,1]. Returns -1 if the model is
  // missing/invalid so the caller can distinguish "no opinion" from "safe".
  function scoreText(text, model) {
    if (!model || !model.weights) return -1;
    var norm = normalizeForClassifier(text);
    if (!norm) return 0;
    var feats = extractFeatures(norm, model);
    var z = model.bias;
    feats.forEach(function (count, bucket) {
      var w = model.weights.get(bucket);
      if (w) z += w * count;
    });
    return sigmoid(z);
  }

  // ---- Verdict --------------------------------------------------------------
  // prob: scoreText() output. thresholds: { block, fuse }. imageBlockCount:
  // how many images the AI image blocker flagged on this page (fusion signal).
  //   'block'      -> high confidence, block on text alone
  //   'fuse-block' -> moderate confidence corroborated by >=1 blocked image
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

  var exported = {
    DEFAULT_DIM: DEFAULT_DIM,
    DEFAULT_NGRAM_MIN: DEFAULT_NGRAM_MIN,
    DEFAULT_NGRAM_MAX: DEFAULT_NGRAM_MAX,
    DEFAULT_TEXT_THRESHOLDS: DEFAULT_TEXT_THRESHOLDS,
    utf8Bytes: utf8Bytes,
    fnv1a32: fnv1a32,
    hashFeature: hashFeature,
    normalizeForClassifier: normalizeForClassifier,
    extractFeatures: extractFeatures,
    loadModel: loadModel,
    scoreText: scoreText,
    verdictForText: verdictForText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.TextClassifier = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
