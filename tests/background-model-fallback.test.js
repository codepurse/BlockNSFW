// The ai_ping_model contract when the selected model cannot load.
//
// Regression: the options page's "Download model now" button appeared to do
// nothing. The ping falls back to the bundled model so pages are never left
// unfiltered, and it answered `ready: true` with no indication that a DIFFERENT
// model had come up and no record of why the requested one failed. The button
// read that as success and re-rendered itself back to its starting state — no
// spinner, no message, no change.
//
// So a fallback must be self-describing: which model actually came up, and why
// the requested one did not.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { loadBackgroundContext } = require('./setup.js');

// The SW path is what runs here: the chrome stub has no chrome.offscreen, so
// offscreenAvailable() is false.
function prepare(ctx, { vitError = null } = {}) {
  ctx.self.tf = {
    setBackend: async () => {},
    ready: async () => {},
    getBackend: () => 'cpu'
  };
  ctx.self.nsfwjs = {
    load: async (url) => ({ modelUrl: url, classify: async () => [] })
  };
  // Override the real graph loader with a controllable one.
  ctx.self.VitClassifier = {
    ...ctx.self.VitClassifier,
    load: async () => {
      if (vitError) throw new Error(vitError);
      return { predict: () => null };
    }
  };
}

function ping(ctx, message) {
  const listener = ctx.chrome.runtime.onMessage.listeners[0];
  return new Promise((resolve) => {
    const keepOpen = listener(message, {}, (response) => resolve(response));
    assert.equal(keepOpen, true, 'the ping handler must keep the channel open');
  });
}

test('a ping for the bundled model reports itself, with no fallback', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx);

  const res = await ping(ctx, { type: 'ai_ping_model', model: 'nsfwjs' });
  assert.equal(res.ready, true);
  assert.equal(res.model, 'nsfwjs');
  assert.equal(res.fellBackFrom, null);
  assert.equal(res.requestedError, '');
});

test('a working graph model reports itself, not the fallback', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx);

  const res = await ping(ctx, { type: 'ai_ping_model', model: 'vit384' });
  assert.equal(res.ready, true);
  assert.equal(res.model, 'vit384');
  assert.equal(res.fellBackFrom, null);
  assert.equal(res.requestedError, '');
});

test('a failed graph model falls back AND says which model ran and why', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx, { vitError: 'packaged model.json missing (HTTP 404)' });

  const res = await ping(ctx, { type: 'ai_ping_model', model: 'vit384' });

  // Still ready, because leaving pages unfiltered is the worst outcome.
  assert.equal(res.ready, true);
  // But unmistakably a fallback — this is what the download button checks.
  assert.equal(res.model, 'nsfwjs');
  assert.equal(res.fellBackFrom, 'vit384');
  // And the reason survives, so the UI can show something actionable.
  assert.match(res.requestedError, /model\.json missing \(HTTP 404\)/);
});

test('the download button success condition rejects a fallback', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx, { vitError: 'weights unreachable' });

  const res = await ping(ctx, { type: 'ai_ping_model', model: 'vit384', forceRetry: true });

  // Mirrors options.js: `ready` alone must NOT read as a completed download.
  const requested = 'vit384';
  const succeeded = !!(res && res.ready && res.model === requested && !res.fellBackFrom);
  assert.equal(succeeded, false, 'a fallback must not count as a finished download');
  assert.ok(res.requestedError, 'the UI needs a reason to show');
});

test('a bundled-model failure still reports not-ready rather than pretending', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  ctx.self.tf = { setBackend: async () => {}, ready: async () => {}, getBackend: () => 'cpu' };
  ctx.self.nsfwjs = { load: async () => { throw new Error('bundled model broken'); } };

  const res = await ping(ctx, { type: 'ai_ping_model', model: 'nsfwjs', forceRetry: true });
  assert.equal(res.ready, false);
  assert.match(res.error, /bundled model broken/);
});

// ─── classify: the content script tags its cache from res.model ──────────

function classifyMsg(ctx, message) {
  const listener = ctx.chrome.runtime.onMessage.listeners[0];
  return new Promise((resolve) => {
    listener(message, {}, (response) => resolve(response));
  });
}

function stubBlobFetch(ctx) {
  // classifyImageBytes fetches the image itself when given only a src.
  ctx.fetch = async () => ({ ok: true, status: 200, blob: async () => ({ fake: 'blob' }) });
  ctx.createImageBitmap = async () => ({ close() {} });
  ctx.Blob = class { constructor(parts) { this.parts = parts; } };
}

test('classify reports which model produced the scores', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx);
  stubBlobFetch(ctx);
  ctx.self.nsfwjs = {
    load: async () => ({
      classify: async () => [
        { className: 'Porn', probability: 0.9 },
        { className: 'Neutral', probability: 0.1 }
      ]
    })
  };

  const res = await classifyMsg(ctx, {
    type: 'ai_classify_image',
    src: 'https://cdn.example.com/a.jpg',
    model: 'nsfwjs'
  });
  assert.equal(res.success, true);
  assert.equal(res.model, 'nsfwjs');
  assert.equal(res.scores.Porn, 0.9);
});

test('classify falls back and reports the model that actually ran', async () => {
  const ctx = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', ctx);
  prepare(ctx, { vitError: 'packaged model.json missing (HTTP 404)' });
  stubBlobFetch(ctx);
  ctx.self.nsfwjs = {
    load: async () => ({
      classify: async () => [{ className: 'Neutral', probability: 0.99 }]
    })
  };

  const res = await classifyMsg(ctx, {
    type: 'ai_classify_image',
    src: 'https://cdn.example.com/b.jpg',
    model: 'vit384'
  });

  // Asked for vit384, got MobileNet scores — and the response says so, which
  // is what stops the content script tagging them as vit384 results.
  assert.equal(res.success, true);
  assert.equal(res.model, 'nsfwjs');
  assert.ok(Object.prototype.hasOwnProperty.call(res.scores, 'Neutral'));
  assert.equal(Object.prototype.hasOwnProperty.call(res.scores, 'NSFW'), false);
});
