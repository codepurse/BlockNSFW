// Registry of the image classifiers the AI image blocker can run.
//
// One descriptor per model, shared by every context that touches
// classification: the content script (thresholds + cache tagging), the
// offscreen document and service worker (loading + inference), the options
// page (the picker), and the tests. Keeping the input size, score shape and
// threshold presets in ONE place is what stops the three inference routes from
// drifting apart.
//
// Two models, deliberately different in shape:
//
//   nsfwjs  MobileNetV2, a tfjs *layers* model loaded through nsfwjs. Five
//           classes (Porn/Hentai/Sexy/Drawing/Neutral). Bundled in the
//           package (2.6 MB) so it works offline on first run. The default.
//
//   vit384  Marqo/nsfw-image-detection-384 (`vit_tiny_patch16_384`), a tfjs
//           *graph* model loaded directly with tf.loadGraphModel — nsfwjs is
//           not involved, because the CSP-safe nsfwjs.runtime.js build cannot
//           load graph models. Binary NSFW/SFW. Its weights are NOT bundled:
//           fp32 they are ~22 MB, which every user would pay for in store
//           download size for an opt-in beta feature most never enable. The
//           graph topology (model.json) ships in the package — it is the part
//           that describes execution, so it stays reviewable — and only the
//           numeric weight shards are fetched on first use and cached locally.
//
// Why the binary model is worth the extra machinery: NSFW.js's "Sexy" class
// fires on beaches, fitness, fashion and ordinary portraits, which is why
// verdictFor() has to hold that bar up at 0.90 (see ai-image-blocker-core.js).
// A binary SFW/NSFW head has no such class to defend against.
(function (root) {
  'use strict';

  // Where the vit384 weight shards are published. The shards are numeric
  // weights only (the graph lives in the packaged model.json), served from the
  // same maintainer-owned repo as the remote blocklist — see
  // REMOTE_BLOCKLIST_URL in background.js for the established pattern.
  //
  // Bump VIT384_WEIGHTS_VERSION whenever the published shards change: it is
  // part of the local cache key, so a bump is what makes clients re-download
  // instead of serving stale weights forever.
  var VIT384_WEIGHTS_BASE_URL =
    'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/models/vit384/';
  var VIT384_WEIGHTS_VERSION = 1;

  var MODELS = {
    nsfwjs: {
      id: 'nsfwjs',
      label: 'NSFW.js (MobileNetV2)',
      // Shown in the options picker.
      blurb: 'Bundled and offline. Five categories. Occasionally flags ' +
        'ordinary photos of people as suggestive.',
      kind: 'nsfwjs-layers',
      inputSize: 224,
      bundled: true,
      // Directory, not a file: nsfwjs.load() appends model.json itself.
      modelPath: 'nsfwjs/',
      // Score keys this model produces, used to identify cached scores.
      scoreKeys: ['Porn', 'Hentai', 'Sexy', 'Drawing', 'Neutral'],
      thresholds: {
        relaxed: { pornHentai: 0.80, sexy: 0.97 },
        balanced: { pornHentai: 0.60, sexy: 0.90 },
        strict: { pornHentai: 0.45, sexy: 0.80 }
      }
    },
    vit384: {
      id: 'vit384',
      label: 'Vision Transformer (ViT-384)',
      blurb: 'More accurate, and far less likely to flag ordinary photos. ' +
        'Downloads once (~22 MB) and is slower per image.',
      kind: 'tfjs-graph-binary',
      inputSize: 384,
      bundled: false,
      // Graph topology, packaged. Weight shards come from the URL above.
      modelPath: 'models/vit384/model.json',
      weightsBaseUrl: VIT384_WEIGHTS_BASE_URL,
      weightsVersion: VIT384_WEIGHTS_VERSION,
      // Preprocessing: resize to inputSize, then (x/255 - mean) / std.
      norm: { mean: 0.5, std: 0.5 },
      // Index of the NSFW logit in the model's 2-class output.
      nsfwIndex: 0,
      scoreKeys: ['NSFW', 'SFW'],
      // A single probability, so a single bar. These are CALIBRATED, not
      // guessed — the first cut (0.40/0.70/0.90) was invented and under-blocked
      // badly, because this model's scores are nothing like NSFW.js's.
      //
      // Two measurements set them:
      //
      //  1. False positives (measured locally, tools/ scan over 18 varied
      //     safe photos incl. people and sports): NSFW sits in a very tight
      //     0.047-0.094 band, topping out at 0.0941. Safe content simply does
      //     not reach into the tenths.
      //
      //  2. Recall (Marqo's published ThresholdEvals): precision AND recall
      //     both hold ~0.98 on a flat plateau from ~0.1 to ~0.9, then recall
      //     falls off a cliff past 0.9.
      //
      // So the whole usable range is 0.1-0.9, safe content never exceeds ~0.1,
      // and a high bar buys no precision while destroying recall — the old
      // `relaxed: 0.90` sat exactly on the cliff. Every preset now lives inside
      // the plateau with measured headroom over the safe band.
      //
      // Caveat worth knowing before tuning further: the deliberately borderline
      // class (beachwear, lingerie, fitness) is NOT in the local sample, and it
      // legitimately scores higher than ordinary photos. `balanced` keeps ~3x
      // headroom over the measured safe ceiling for that reason; `strict`
      // deliberately does not, which is what makes it strict.
      thresholds: {
        relaxed: { nsfw: 0.60 },
        balanced: { nsfw: 0.30 },
        strict: { nsfw: 0.15 }
      }
    }
  };

  var DEFAULT_MODEL_ID = 'nsfwjs';
  var DEFAULT_STRICTNESS = 'balanced';

  function getModel(id) {
    var key = String(id || '').trim();
    return Object.prototype.hasOwnProperty.call(MODELS, key) ? MODELS[key] : null;
  }

  // Never throws and never returns null: an unknown/absent id falls back to
  // the bundled default, so a corrupt setting degrades to a working model
  // rather than to no filtering at all.
  function resolveModel(id) {
    return getModel(id) || MODELS[DEFAULT_MODEL_ID];
  }

  function normalizeModelId(id) {
    return resolveModel(id).id;
  }

  function normalizeStrictness(level) {
    var key = String(level || '').trim().toLowerCase();
    if (key === 'relaxed' || key === 'balanced' || key === 'strict') return key;
    return DEFAULT_STRICTNESS;
  }

  // Threshold preset for a (model, strictness) pair. The returned object also
  // carries `model`, so verdictFor() can tell which score shape the caller
  // meant even when the thresholds are passed around on their own.
  function getThresholds(modelId, level) {
    var model = resolveModel(modelId);
    var preset = model.thresholds[normalizeStrictness(level)];
    var out = { model: model.id };
    for (var k in preset) {
      if (Object.prototype.hasOwnProperty.call(preset, k)) out[k] = preset[k];
    }
    return out;
  }

  // True when a score object was produced by `modelId`. Used to reject cached
  // scores after a model switch: a 0.8 from MobileNet's Sexy class and a 0.8
  // NSFW probability from the ViT are not the same number, and re-deriving a
  // verdict from the wrong one silently blocks or unblocks the wrong images.
  function scoresMatchModel(scores, modelId) {
    if (!scores || typeof scores !== 'object') return false;
    var model = resolveModel(modelId);
    for (var i = 0; i < model.scoreKeys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(scores, model.scoreKeys[i])) return true;
    }
    return false;
  }

  // Absolute URL of one weight shard. `relativePath` comes from the packaged
  // model.json's weightsManifest.
  function weightShardUrl(modelId, relativePath) {
    var model = resolveModel(modelId);
    if (!model.weightsBaseUrl) return null;
    return model.weightsBaseUrl + String(relativePath || '').replace(/^\/+/, '');
  }

  var exported = {
    MODELS: MODELS,
    DEFAULT_MODEL_ID: DEFAULT_MODEL_ID,
    DEFAULT_STRICTNESS: DEFAULT_STRICTNESS,
    getModel: getModel,
    resolveModel: resolveModel,
    normalizeModelId: normalizeModelId,
    normalizeStrictness: normalizeStrictness,
    getThresholds: getThresholds,
    scoresMatchModel: scoresMatchModel,
    weightShardUrl: weightShardUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.AiImageModels = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
