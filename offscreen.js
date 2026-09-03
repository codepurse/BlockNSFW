// Offscreen document worker for the AI image blocker.
//
// Runs the selected image classifier on the WebGL backend in a persistent DOM
// context. The service worker relays classify/ping requests here so inference
// is GPU-fast and each model only loads once.
//
// Two models are supported (see shared/ai-image-models.js):
//   nsfwjs  MobileNetV2 layers model, loaded through nsfwjs. Bundled.
//   vit384  ViT-Tiny-384 graph model, loaded by shared/vit-classifier.js with
//           tf.loadGraphModel. Weights fetched on first use, then cached.
//
// Both stay loaded once initialised, keyed by model id, so toggling the
// setting back and forth in the options page does not re-pay either load.
//
// Protocol (from background.js): { target: 'offscreen-ai', op, ... }
//   op:'classify' { src, model }        -> { success, scores } | { success:false, error }
//   op:'ping'     { model }             -> { ready:true, backend } | { ready:false, error }
//   op:'model_status' { model }         -> { success, cached }
//   op:'clear_weights' { model }        -> { success, cleared }

const Models = self.AiImageModels;

// modelId -> { model, promise } so each model loads at most once.
const loaded = new Map();
let activeBackend = 'unknown';
// Progress of the most recent vit384 weight download, polled by the options
// page through the service worker.
let lastProgress = null;

async function ensureBackend() {
  // Offscreen documents have a real WebGL context (the service worker does
  // not), so prefer GPU; fall back to CPU only if WebGL init fails.
  try {
    await tf.setBackend('webgl');
  } catch (_) {
    try { await tf.setBackend('cpu'); } catch (_) {}
  }
  await tf.ready();
  activeBackend = (typeof tf.getBackend === 'function' && tf.getBackend()) || 'unknown';
  return activeBackend;
}

function loadModel(modelId) {
  const descriptor = Models.resolveModel(modelId);
  const id = descriptor.id;
  const entry = loaded.get(id);
  if (entry && entry.model) return Promise.resolve(entry.model);
  if (entry && entry.promise) return entry.promise;

  const promise = (async () => {
    await ensureBackend();
    let model;
    if (descriptor.kind === 'tfjs-graph-binary') {
      model = await self.VitClassifier.load(id, (progress) => {
        lastProgress = { model: id, ...progress };
      });
    } else {
      // MobileNetV2 is a tfjs *layers* model; nsfwjs.load() (which calls
      // loadLayersModel) handles it. The CSP-safe nsfwjs.runtime.js build does
      // NOT support graph models, which is exactly why vit384 bypasses nsfwjs.
      model = await nsfwjs.load(chrome.runtime.getURL(descriptor.modelPath));
    }
    loaded.set(id, { model, promise: null });
    console.log('[BlockNSFW] offscreen model ready:', id, 'backend:', activeBackend);
    return model;
  })().catch((err) => {
    // Drop the failed entry so a later ping retries instead of resolving the
    // same rejected promise forever.
    loaded.delete(id);
    console.error('[BlockNSFW] offscreen model FAILED to load:', id, err);
    throw err;
  });

  loaded.set(id, { model: null, promise });
  return promise;
}

async function classify(src, modelId) {
  const descriptor = Models.resolveModel(modelId);
  const model = await loadModel(descriptor.id);

  // Fetch with extension permissions (page CSP / hotlink rules don't apply).
  // force-cache reuses the image the page just loaded, so this is usually free.
  const resp = await fetch(src, { credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();

  let bitmap;
  // Decode straight to the model's input size where the decoder supports it.
  const opts = {
    resizeWidth: descriptor.inputSize,
    resizeHeight: descriptor.inputSize,
    resizeQuality: 'high'
  };
  try {
    bitmap = await createImageBitmap(blob, opts);
  } catch (_) {
    bitmap = await createImageBitmap(blob);
  }

  try {
    if (descriptor.kind === 'tfjs-graph-binary') {
      return await self.VitClassifier.classify(model, bitmap, descriptor.id);
    }
    const predictions = await model.classify(bitmap);
    const scores = {};
    for (const p of predictions) scores[p.className] = p.probability;
    return scores;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen-ai') return; // not for us

  if (message.op === 'classify') {
    classify(message.src, message.model)
      .then((scores) => sendResponse({ success: true, scores }))
      .catch((err) => sendResponse({ success: false, error: err && err.message || String(err) }));
    return true; // async
  }

  if (message.op === 'ping') {
    loadModel(message.model)
      .then(() => sendResponse({ ready: true, backend: activeBackend }))
      .catch((err) => sendResponse({ ready: false, error: err && err.message || String(err) }));
    return true; // async
  }

  if (message.op === 'model_status') {
    const descriptor = Models.resolveModel(message.model);
    (async () => {
      const cached = descriptor.bundled
        ? true
        : await self.VitClassifier.isCached(descriptor.id);
      // `available` distinguishes "not downloaded yet" from "this build has no
      // graph for the model", which no amount of retrying can fix.
      const topology = await self.VitClassifier.topologyStatus(descriptor.id);
      sendResponse({
        success: true,
        model: descriptor.id,
        cached,
        available: topology.available,
        error: topology.error,
        loaded: loaded.has(descriptor.id) && !!loaded.get(descriptor.id).model,
        progress: lastProgress && lastProgress.model === descriptor.id ? lastProgress : null
      });
    })().catch((err) => sendResponse({ success: false, error: err && err.message || String(err) }));
    return true; // async
  }

  if (message.op === 'clear_weights') {
    (async () => {
      const descriptor = Models.resolveModel(message.model);
      loaded.delete(descriptor.id);
      const cleared = await self.VitClassifier.clearCachedWeights(descriptor.id);
      sendResponse({ success: true, cleared });
    })().catch((err) => sendResponse({ success: false, error: err && err.message || String(err) }));
    return true; // async
  }

  return false;
});
