// vit384 classifier: loads Marqo/nsfw-image-detection-384 as a tfjs
// GraphModel and scores one image at a time.
//
// Runs unchanged in all three inference contexts, because all three already
// load vendor/tfjs/tf.es2017.js and expose it as a global `tf`:
//   - the offscreen document (Chrome's fast path, WebGL)
//   - the MV3 service worker (Chrome's fallback)
//   - Firefox's background event page
//
// nsfwjs is deliberately not involved. The CSP-safe nsfwjs.runtime.js build
// only loads *layers* models, which is what blocked the graph-model upgrade
// for so long — but that is a limitation of nsfwjs, not of tfjs. tf.es2017.js
// exports tf.loadGraphModel and is eval-free, so a graph model loads fine as
// long as we do the preprocessing and softmax ourselves.
//
// Weights are not in the extension package. The graph topology is (it is the
// part that describes execution, so it stays reviewable in the store listing);
// the numeric shards are fetched once from the maintainer-owned URL in
// shared/ai-image-models.js and kept in the Cache API. Everything after the
// first enable is local.
(function (root) {
  'use strict';

  // Bump only for a breaking change to how entries are stored. Individual
  // model revisions are handled by the per-model weightsVersion in the cache
  // key, so publishing new weights does not need a change here.
  var SHARD_CACHE_NAME = 'blocknsfw-model-weights-v1';

  var Models = root.AiImageModels ||
    (typeof require === 'function' ? require('./ai-image-models.js') : null);

  function getTf() {
    var tf = root.tf;
    if (!tf || typeof tf.loadGraphModel !== 'function') {
      throw new Error('tfjs not loaded (or missing loadGraphModel)');
    }
    return tf;
  }

  function extensionUrl(path) {
    var api = root.chrome || root.browser;
    if (api && api.runtime && typeof api.runtime.getURL === 'function') {
      return api.runtime.getURL(path);
    }
    return path;
  }

  // Flatten the weightsManifest into the parallel arrays tf.io.fromMemory
  // wants: shard paths in load order, and the specs describing what the
  // concatenated bytes mean.
  function readManifest(topology) {
    var groups = Array.isArray(topology && topology.weightsManifest)
      ? topology.weightsManifest
      : [];
    if (groups.length === 0) throw new Error('model.json has no weightsManifest');

    var paths = [];
    var specs = [];
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i] || {};
      var groupPaths = Array.isArray(group.paths) ? group.paths : [];
      var groupWeights = Array.isArray(group.weights) ? group.weights : [];
      for (var p = 0; p < groupPaths.length; p++) paths.push(groupPaths[p]);
      for (var w = 0; w < groupWeights.length; w++) specs.push(groupWeights[w]);
    }
    if (paths.length === 0) throw new Error('weightsManifest lists no shards');
    if (specs.length === 0) throw new Error('weightsManifest lists no weights');
    return { paths: paths, specs: specs };
  }

  // Cache key for one shard. The weights version is part of the key so that
  // republished weights are treated as a different resource rather than served
  // from a stale cache entry.
  function shardCacheKey(model, relativePath) {
    return Models.weightShardUrl(model.id, relativePath) +
      '?v=' + String(model.weightsVersion || 1);
  }

  function cachesAvailable() {
    return typeof root.caches !== 'undefined' && root.caches &&
      typeof root.caches.open === 'function';
  }

  // Fetch one shard, preferring the local cache. Cache failures are never
  // fatal: a private window or an evicted quota should mean "download again",
  // not "the feature is broken".
  async function loadShard(model, relativePath) {
    var url = Models.weightShardUrl(model.id, relativePath);
    if (!url) throw new Error('no weights URL configured for ' + model.id);
    var key = shardCacheKey(model, relativePath);

    var cache = null;
    if (cachesAvailable()) {
      try { cache = await root.caches.open(SHARD_CACHE_NAME); } catch (_) {}
    }

    if (cache) {
      try {
        var hit = await cache.match(key);
        if (hit && hit.ok) return await hit.arrayBuffer();
      } catch (_) {}
    }

    var resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!resp || !resp.ok) {
      throw new Error('shard ' + relativePath + ': HTTP ' + (resp && resp.status));
    }

    if (cache) {
      try { await cache.put(key, resp.clone()); } catch (_) {}
    }
    return await resp.arrayBuffer();
  }

  function concatBuffers(buffers) {
    var total = 0;
    var i;
    for (i = 0; i < buffers.length; i++) total += buffers[i].byteLength;
    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < buffers.length; i++) {
      out.set(new Uint8Array(buffers[i]), offset);
      offset += buffers[i].byteLength;
    }
    return out.buffer;
  }

  // Load the model. `onProgress({ loaded, total, phase })` is optional and is
  // called per shard so the options page can show real progress on the first
  // (~22 MB) download.
  async function load(modelId, onProgress) {
    var tf = getTf();
    var model = Models.resolveModel(modelId);
    if (model.kind !== 'tfjs-graph-binary') {
      throw new Error('not a graph model: ' + model.id);
    }

    var report = function (loaded, total, phase) {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ loaded: loaded, total: total, phase: phase }); } catch (_) {}
    };

    report(0, 1, 'topology');
    var topologyResp = await fetch(extensionUrl(model.modelPath));
    if (!topologyResp || !topologyResp.ok) {
      throw new Error('packaged model.json missing (HTTP ' +
        (topologyResp && topologyResp.status) + ')');
    }
    var topology = await topologyResp.json();
    var manifest = readManifest(topology);

    var buffers = [];
    for (var i = 0; i < manifest.paths.length; i++) {
      report(i, manifest.paths.length, 'weights');
      buffers.push(await loadShard(model, manifest.paths[i]));
    }
    report(manifest.paths.length, manifest.paths.length, 'weights');

    report(0, 1, 'compile');
    var graph = await tf.loadGraphModel(tf.io.fromMemory({
      modelTopology: topology.modelTopology,
      weightSpecs: manifest.specs,
      weightData: concatBuffers(buffers),
      // Forwarded, not dropped: the converter emits a `signature` naming the
      // graph's input/output tensors ("input:0" -> "Identity:0"). tfjs can
      // infer them from the GraphDef without it, but passing it through keeps
      // the in-memory load identical to loading the same model.json by URL.
      signature: topology.signature,
      format: topology.format,
      generatedBy: topology.generatedBy,
      convertedBy: topology.convertedBy
    }));
    report(1, 1, 'ready');
    return graph;
  }

  // Whether the weights are already local, so the options page can say
  // "downloaded" vs "will download ~22 MB" without starting a download.
  async function isCached(modelId) {
    var model = Models.resolveModel(modelId);
    if (!model.weightsBaseUrl || !cachesAvailable()) return false;
    try {
      var topologyResp = await fetch(extensionUrl(model.modelPath));
      if (!topologyResp || !topologyResp.ok) return false;
      var manifest = readManifest(await topologyResp.json());
      var cache = await root.caches.open(SHARD_CACHE_NAME);
      for (var i = 0; i < manifest.paths.length; i++) {
        var hit = await cache.match(shardCacheKey(model, manifest.paths[i]));
        if (!hit || !hit.ok) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Whether this build can run the model at all. The weight shards are
  // fetched at runtime, but the graph topology is packaged — so a build made
  // before the model was converted has no models/<id>/model.json and the
  // model can NEVER load, no matter how many times a download is retried.
  // Callers need to tell that apart from "not downloaded yet", or the options
  // page offers a download button that cannot possibly succeed.
  async function topologyStatus(modelId) {
    var model = Models.resolveModel(modelId);
    if (model.bundled) return { available: true, error: '' };
    try {
      var resp = await fetch(extensionUrl(model.modelPath));
      if (!resp || !resp.ok) {
        return {
          available: false,
          error: 'this build does not include the ' + model.id +
            ' model graph (HTTP ' + (resp && resp.status) + ')'
        };
      }
      readManifest(await resp.json());
      return { available: true, error: '' };
    } catch (err) {
      // A missing extension resource rejects rather than returning !ok.
      return {
        available: false,
        error: 'this build does not include the ' + model.id +
          ' model graph (' + (err && err.message || String(err)) + ')'
      };
    }
  }

  async function clearCachedWeights(modelId) {
    if (!cachesAvailable()) return false;
    try {
      if (!modelId) return await root.caches.delete(SHARD_CACHE_NAME);
      var model = Models.resolveModel(modelId);
      var topologyResp = await fetch(extensionUrl(model.modelPath));
      if (!topologyResp || !topologyResp.ok) return false;
      var manifest = readManifest(await topologyResp.json());
      var cache = await root.caches.open(SHARD_CACHE_NAME);
      for (var i = 0; i < manifest.paths.length; i++) {
        try { await cache.delete(shardCacheKey(model, manifest.paths[i])); } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Preprocess to the model's fixed input. Done on a canvas rather than with
  // tf.browser.fromPixels + tf.image.resizeBilinear for two reasons: the
  // service worker has no tf.browser, and drawImage gives us the resize for
  // free. The arithmetic is the same — bilinear downscale, then
  // (x/255 - mean) / std per channel, NHWC, alpha dropped.
  function toInputTensor(tf, bitmap, model) {
    var size = model.inputSize;
    if (typeof root.OffscreenCanvas !== 'function') {
      throw new Error('OffscreenCanvas unavailable');
    }
    var canvas = new root.OffscreenCanvas(size, size);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context unavailable');
    // The model was evaluated with bicubic resampling; 'high' is the closest
    // the canvas API gets, and it is free relative to the ViT forward pass.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Deliberately a squash to a square, NOT timm's aspect-preserving
    // Resize+CenterCrop. Measured cost of the distortion on this model: 0.006
    // of NSFW probability. Measured cost of center-cropping instead: anything
    // in the outer edges of a wide or tall image becomes invisible to the
    // filter. For a content blocker, a blind spot is far worse than a mild
    // aspect distortion, so we keep the whole frame in view.
    ctx.drawImage(bitmap, 0, 0, size, size);
    var rgba = ctx.getImageData(0, 0, size, size).data;

    var mean = model.norm.mean;
    var std = model.norm.std;
    var floats = new Float32Array(size * size * 3);
    for (var i = 0, j = 0; i < rgba.length; i += 4) {
      floats[j++] = (rgba[i] / 255 - mean) / std;
      floats[j++] = (rgba[i + 1] / 255 - mean) / std;
      floats[j++] = (rgba[i + 2] / 255 - mean) / std;
    }
    return tf.tensor4d(floats, [1, size, size, 3]);
  }

  // Score one ImageBitmap. Returns the same shape the rest of the pipeline
  // caches and reasons about: a plain map of class name → probability.
  async function classify(graph, bitmap, modelId) {
    var tf = getTf();
    var model = Models.resolveModel(modelId);
    var input = toInputTensor(tf, bitmap, model);
    var logits = null;
    var probs = null;
    try {
      logits = graph.predict(input);
      // A graph model can hand back an array or a dict when it has multiple
      // outputs; this one has a single 2-logit head either way.
      if (Array.isArray(logits)) logits = logits[0];
      else if (logits && !logits.shape && typeof logits === 'object') {
        var keys = Object.keys(logits);
        logits = logits[keys[0]];
      }
      probs = tf.softmax(tf.reshape(logits, [2]));
      var data = await probs.data();
      var nsfwIndex = model.nsfwIndex;
      var nsfw = data[nsfwIndex];
      var sfw = data[nsfwIndex === 0 ? 1 : 0];
      return { NSFW: nsfw, SFW: sfw };
    } finally {
      try { input.dispose(); } catch (_) {}
      try { if (logits && logits.dispose) logits.dispose(); } catch (_) {}
      try { if (probs && probs.dispose) probs.dispose(); } catch (_) {}
    }
  }

  var exported = {
    SHARD_CACHE_NAME: SHARD_CACHE_NAME,
    load: load,
    classify: classify,
    isCached: isCached,
    topologyStatus: topologyStatus,
    clearCachedWeights: clearCachedWeights,
    // exported for tests
    readManifest: readManifest,
    concatBuffers: concatBuffers,
    shardCacheKey: shardCacheKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.VitClassifier = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
