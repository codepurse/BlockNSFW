// Offscreen document worker for the AI image blocker.
//
// Runs the NSFW.js (MobileNetV2Mid graph) model on the WebGL backend in a
// persistent DOM context. The service worker relays classify/ping requests
// here so inference is GPU-fast and the model only loads once.
//
// Protocol (from background.js): { target: 'offscreen-ai', op, ... }
//   op:'classify' { src }  -> { success, scores } | { success:false, error }
//   op:'ping'     { }      -> { ready:true, backend } | { ready:false, error }

const MODEL_URL = chrome.runtime.getURL('nsfwjs/');
const INPUT_SIZE = 224; // MobileNetV2Mid input dimension

let model = null;
let loadPromise = null;
let activeBackend = 'unknown';

async function ensureModel() {
  if (model) return model;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // Offscreen documents have a real WebGL context (the service worker does
      // not), so prefer GPU; fall back to CPU only if WebGL init fails.
      try {
        await tf.setBackend('webgl');
      } catch (_) {
        try { await tf.setBackend('cpu'); } catch (_) {}
      }
      await tf.ready();
      activeBackend = (typeof tf.getBackend === 'function' && tf.getBackend()) || 'unknown';
      // Default MobileNetV2 is a tfjs *layers* model; nsfwjs.load() (which calls
      // loadLayersModel) handles it. The CSP-safe nsfwjs.runtime.js build does
      // NOT support graph models, so the model bundled in nsfwjs/ must be layers.
      const loaded = await nsfwjs.load(MODEL_URL);
      model = loaded;
      console.log('[BlockNSFW] offscreen AI model ready, backend:', activeBackend);
      return model;
    } catch (err) {
      console.error('[BlockNSFW] offscreen AI model FAILED to load:', err);
      throw err;
    }
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function classify(src) {
  const m = await ensureModel();
  // Fetch with extension permissions (page CSP / hotlink rules don't apply).
  // force-cache reuses the image the page just loaded, so this is usually free.
  const resp = await fetch(src, { credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();
  let bitmap;
  const opts = { resizeWidth: INPUT_SIZE, resizeHeight: INPUT_SIZE, resizeQuality: 'high' };
  try {
    bitmap = await createImageBitmap(blob, opts);
  } catch (_) {
    bitmap = await createImageBitmap(blob);
  }
  try {
    const predictions = await m.classify(bitmap);
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
    classify(message.src)
      .then((scores) => sendResponse({ success: true, scores }))
      .catch((err) => sendResponse({ success: false, error: err && err.message || String(err) }));
    return true; // async
  }
  if (message.op === 'ping') {
    ensureModel()
      .then(() => sendResponse({ ready: true, backend: activeBackend }))
      .catch((err) => sendResponse({ ready: false, error: err && err.message || String(err) }));
    return true; // async
  }
  return false;
});
