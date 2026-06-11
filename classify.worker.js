// Classic Web Worker (importScripts for better Chrome extension compatibility).
// Owns the tfjs + nsfwjs lifecycle and the model.
// Receives Transferable ImageBitmaps from the content script and replies
// with a scores object (or an error string) keyed by the caller-supplied
// requestId.

try {
  importScripts(
    chrome.runtime.getURL('vendor/tfjs/tf.min.js'),
    chrome.runtime.getURL('vendor/nsfwjs/nsfwjs.min.js')
  );
} catch (e) {
  self.postMessage({ type: 'import_error', error: String(e) });
  throw e;
}

let model = null;
let modelLoadAttempted = false;
let modelLoadFailed = false;

async function ensureModel() {
  if (model) return model;
  if (modelLoadFailed) throw new Error('model previously failed to load');
  modelLoadAttempted = true;
  try {
    // Prefer WebGL; fall back to CPU if WebGL init throws (e.g. hardware
    // acceleration disabled). nsfwjs calls tf.setBackend internally
    // when it loads, but we set ours first to make the choice explicit.
    try {
      await tf.setBackend('webgl');
    } catch (_) {
      await tf.setBackend('cpu');
    }
    await tf.ready();
    model = await nsfwjs.load(chrome.runtime.getURL('nsfwjs/'));
    self.postMessage({ type: 'model_ready' });
    return model;
  } catch (err) {
    modelLoadFailed = true;
    self.postMessage({ type: 'model_error', error: String(err && err.message || err) });
    throw err;
  }
}

self.addEventListener('message', async (e) => {
  const data = e.data || {};
  if (data.type !== 'classify') return;
  const { requestId, bitmap } = data;
  try {
    const m = await ensureModel();
    const predictions = await m.classify(bitmap);
    // Free the GPU/CPU texture immediately. nsfwjs clones what it needs.
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    const scores = {};
    for (const p of predictions) scores[p.className] = p.probability;
    self.postMessage({ type: 'classified', requestId, scores });
  } catch (err) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    self.postMessage({
      type: 'classified',
      requestId,
      error: String(err && err.message || err)
    });
  }
});

// Catch unhandled errors so the content script can re-spawn us.
self.addEventListener('error', (e) => {
  self.postMessage({ type: 'worker_error', error: String(e.message || e) });
});
