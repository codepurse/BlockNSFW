// Switching detection models must not let one model's scores be read against
// the other's thresholds.
//
// The verdict cache stores raw SCORES (not verdicts) and re-derives the verdict
// on every hit, so that changing strictness takes effect immediately instead of
// being frozen for 24h. That design is what makes a second model dangerous: a
// 0.8 from MobileNet's trigger-happy "Sexy" class and a 0.8 NSFW probability
// from the ViT are completely different claims, and reading one against the
// other's bar silently blocks or unblocks the wrong images with no error
// anywhere. These tests pin the guards against that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker-core.js'), 'utf8');
const REGISTRY_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'ai-image-models.js'), 'utf8');
const BLOCKER_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker.js'), 'utf8');
const Models = require('../shared/ai-image-models.js');

const MOBILENET_SEXY = { Porn: 0.05, Hentai: 0.02, Sexy: 0.93, Drawing: 0.0, Neutral: 0.0 };
const VIT_NSFW = { NSFW: 0.85, SFW: 0.15 };
const VIT_SAFE = { NSFW: 0.10, SFW: 0.90 };

function makeImg(src) {
  const classes = new Set();
  return {
    src,
    currentSrc: src,
    naturalWidth: 800,
    naturalHeight: 600,
    complete: true,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    _classes: classes
  };
}

// Same shape as tests/ai-image-recycled-node.test.js, but with the model
// registry loaded so the real (non-fallback) code path runs.
function loadBlocker(settings) {
  const pendingClassifies = new Map();
  const sent = [];
  let pendingNodes = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Map, Set, WeakSet, Date, Math, JSON, RegExp, Promise, URL, Error, Number, Object,
    setTimeout, clearTimeout,
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      querySelectorAll: () => pendingNodes
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (typeof cb !== 'function') return;
          if (msg.type === 'ai_ping_model') {
            cb({ ready: true, backend: 'test', model: msg.model });
            return;
          }
          if (msg.type === 'ai_classify_image') pendingClassifies.set(msg.src, cb);
        }
      },
      storage: { session: { get: (_k, cb) => cb({}), set: () => Promise.resolve() } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = { location: { hostname: 'example.com' } };

  vm.createContext(sandbox);
  vm.runInContext(REGISTRY_SOURCE, sandbox, { filename: 'shared/ai-image-models.js' });
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  vm.runInContext(BLOCKER_SOURCE, sandbox, { filename: 'ai-image-blocker.js' });

  const api = sandbox.window.AIImageBlocker;

  return {
    api,
    sent,
    sandbox,
    // Answer an in-flight classify. `servedBy` mimics the service worker
    // reporting which model actually ran.
    resolveClassify(src, scores, servedBy) {
      const cb = pendingClassifies.get(src);
      assert.ok(cb, `no classification in flight for ${src}`);
      pendingClassifies.delete(src);
      cb({ success: true, scores, model: servedBy });
    },
    isClassifying: (src) => pendingClassifies.has(src),
    classifyRequests: () => sent.filter((m) => m.type === 'ai_classify_image'),
    async init(next) {
      api.init(next || settings);
      await new Promise((r) => setTimeout(r, 80));
    }
  };
}

function withModel(modelId, strictness) {
  return {
    enabled: true,
    aiImageBlocker: true,
    aiImageModel: modelId,
    aiThresholds: Models.getThresholds(modelId, strictness || 'balanced')
  };
}

// ─── verdictFor: score shape decides which bars apply ────────────────────

test('verdictFor reads binary scores against the NSFW bar', () => {
  const sandbox = { Object };
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  const t = Models.getThresholds('vit384', 'balanced');

  assert.equal(sandbox.verdictFor({ NSFW: 0.85, SFW: 0.15 }, t), 'block');
  assert.equal(sandbox.verdictFor({ NSFW: 0.30, SFW: 0.70 }, t), 'block'); // at the bar
  assert.equal(sandbox.verdictFor({ NSFW: 0.29, SFW: 0.71 }, t), 'allow');
  // Where safe photos actually score on this model (measured 0.05-0.09).
  assert.equal(sandbox.verdictFor({ NSFW: 0.09, SFW: 0.91 }, t), 'allow');
});

test('verdictFor keeps the existing NSFW.js behaviour untouched', () => {
  const sandbox = { Object };
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  const t = Models.getThresholds('nsfwjs', 'balanced');

  // Porn+Hentai combine; Sexy alone needs 0.90. Same numbers as before the
  // second model existed.
  assert.equal(sandbox.verdictFor({ Porn: 0.35, Hentai: 0.25 }, t), 'block');
  assert.equal(sandbox.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.85 }, t), 'allow');
  assert.equal(sandbox.verdictFor({ Porn: 0.04, Hentai: 0.03, Sexy: 0.90 }, t), 'block');
});

test("verdictFor ignores the other model's thresholds instead of blocking nothing", () => {
  const sandbox = { Object };
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });

  // This is the fallback case: the SW served nsfwjs scores while the setting
  // (and therefore the thresholds in hand) still said vit384. Applying
  // {nsfw: 0.7} to five-class scores must not leave every bar undefined.
  const vitBars = Models.getThresholds('vit384', 'balanced');
  assert.equal(sandbox.verdictFor({ Porn: 0.9, Hentai: 0.05 }, vitBars), 'block');

  // And the reverse: MobileNet bars applied to a binary score.
  const mobilenetBars = Models.getThresholds('nsfwjs', 'balanced');
  assert.equal(sandbox.verdictFor({ NSFW: 0.95, SFW: 0.05 }, mobilenetBars), 'block');
  assert.equal(sandbox.verdictFor({ NSFW: 0.05, SFW: 0.95 }, mobilenetBars), 'allow');
});

// ─── the cache must not survive a model switch ───────────────────────────

test('classify requests name the active model', async () => {
  const h = loadBlocker(withModel('vit384'));
  await h.init();
  h.api.onImageVisible(makeImg('https://cdn.example.com/a.jpg'));
  await new Promise((r) => setTimeout(r, 10));

  const requests = h.classifyRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'vit384');

  const pings = h.sent.filter((m) => m.type === 'ai_ping_model');
  assert.ok(pings.length > 0);
  assert.equal(pings[0].model, 'vit384');
});

test('an unknown model id in settings is normalized, not passed through', async () => {
  const h = loadBlocker({
    enabled: true,
    aiImageBlocker: true,
    aiImageModel: 'not-a-model'
  });
  await h.init();
  h.api.onImageVisible(makeImg('https://cdn.example.com/b.jpg'));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.classifyRequests()[0].model, 'nsfwjs');
});

test('scores cached under one model are re-classified after switching models', async () => {
  const src = 'https://cdn.example.com/shared.jpg';
  const h = loadBlocker(withModel('nsfwjs'));
  await h.init();

  // Classify once under MobileNet. Sexy 0.93 clears its 0.90 bar -> blocked.
  const first = makeImg(src);
  h.api.onImageVisible(first);
  await new Promise((r) => setTimeout(r, 10));
  h.resolveClassify(src, MOBILENET_SEXY, 'nsfwjs');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(first._classes.has('pblocker-ai-blocked'), true,
    'MobileNet should block Sexy 0.93 at the balanced bar');
  assert.equal(h.classifyRequests().length, 1);

  // Switch to the ViT and show the SAME url again. The cached MobileNet
  // scores must NOT be reused: {Sexy: 0.93} has no NSFW key, so reading it
  // against the ViT's single bar would score 0 and quietly unblur an image
  // the other model just blocked.
  await h.init(withModel('vit384'));
  const second = makeImg(src);
  h.api.onImageVisible(second);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.classifyRequests().length, 2, 'switching models must re-classify');
  assert.equal(h.classifyRequests()[1].model, 'vit384');
  assert.equal(h.isClassifying(src), true);

  // The ViT's own verdict then applies.
  h.resolveClassify(src, VIT_NSFW, 'vit384');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(second._classes.has('pblocker-ai-blocked'), true);
});

test('scores from the same model ARE reused (the cache still works)', async () => {
  const src = 'https://cdn.example.com/same.jpg';
  const h = loadBlocker(withModel('vit384'));
  await h.init();

  const first = makeImg(src);
  h.api.onImageVisible(first);
  await new Promise((r) => setTimeout(r, 10));
  h.resolveClassify(src, VIT_SAFE, 'vit384');
  await new Promise((r) => setTimeout(r, 10));

  const second = makeImg(src);
  h.api.onImageVisible(second);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.classifyRequests().length, 1,
    'a second view of the same url under the same model should hit the cache');
  assert.equal(second._classes.has('pblocker-ai-blocked'), false);
});

test('a fallback response tags the cache with the model that actually ran', async () => {
  const src = 'https://cdn.example.com/fellback.jpg';
  const h = loadBlocker(withModel('vit384'));
  await h.init();

  // Setting says vit384, but the service worker fell back to the bundled
  // model (weights unreachable) and says so.
  const first = makeImg(src);
  h.api.onImageVisible(first);
  await new Promise((r) => setTimeout(r, 10));
  h.resolveClassify(src, MOBILENET_SEXY, 'nsfwjs');
  await new Promise((r) => setTimeout(r, 10));

  // The verdict still has to be right: MobileNet scores judged by MobileNet
  // bars, even though the thresholds in hand belong to the ViT.
  assert.equal(first._classes.has('pblocker-ai-blocked'), true,
    'a fallback verdict must still block explicit content');

  // And the entry is not treated as a vit384 result, so the next view
  // re-classifies rather than reusing MobileNet scores as if they were the
  // selected model's.
  const second = makeImg(src);
  h.api.onImageVisible(second);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.classifyRequests().length, 2);
});

test('strictness changes still take effect without re-classifying', async () => {
  const src = 'https://cdn.example.com/borderline.jpg';
  const h = loadBlocker(withModel('vit384', 'relaxed'));
  await h.init();

  // A borderline 0.45 is under the relaxed bar (0.60) -> allowed.
  const first = makeImg(src);
  h.api.onImageVisible(first);
  await new Promise((r) => setTimeout(r, 10));
  h.resolveClassify(src, { NSFW: 0.45, SFW: 0.55 }, 'vit384');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(first._classes.has('pblocker-ai-blocked'), false);

  // Same model, stricter bar (0.30 balanced): the cached scores are still
  // valid, so this must re-derive a block WITHOUT another round-trip.
  await h.init(withModel('vit384', 'balanced'));
  const second = makeImg(src);
  h.api.onImageVisible(second);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.classifyRequests().length, 1, 'no re-classification needed');
  assert.equal(second._classes.has('pblocker-ai-blocked'), true);
});
