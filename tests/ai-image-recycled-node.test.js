// Regression tests for issue #17 — "AI image filter not working on twitter".
//
// X/Twitter runs a virtualised timeline: React keeps a pool of <img> nodes and
// swaps their src as you scroll, and the browser re-resolves srcset to a
// higher-res candidate once an image is laid out. Both mean the picture in a
// node can change *while* its classification is in flight.
//
// Two things went wrong because of that:
//   1. applyVerdict() applied whatever verdict came back to whatever the node
//      currently held. A stale `allow` from the node's previous occupant would
//      strip the blur straight off an image the model had just blocked — the
//      reported "detected (it's in the log) but not blurred" symptom.
//   2. content.js unblurred a node the moment its src changed, exposing the new
//      image for a whole classify round-trip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker-core.js'), 'utf8');
const BLOCKER_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker.js'), 'utf8');

const BLOCKED = 'pblocker-ai-blocked';
const PENDING = 'pblocker-ai-pending';

// Minimal stand-in for an HTMLImageElement: only classList plus the src/size
// fields the blocker reads.
function makeImg(src, { naturalWidth = 800, naturalHeight = 600 } = {}) {
  const classes = new Set();
  return {
    src,
    currentSrc: src,
    naturalWidth,
    naturalHeight,
    complete: true,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    _classes: classes
  };
}

// Load core + blocker into one sandbox, with a controllable classify channel.
// `classify(src)` returns a promise the test resolves by hand, so a node can be
// recycled mid-flight exactly like X does.
function loadBlocker({ settings = { enabled: true, aiImageBlocker: true }, pageHost = 'x.com' } = {}) {
  const pendingClassifies = new Map(); // src -> {resolve, reject}
  const sent = [];
  const styleEls = [];
  let pendingNodes = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Map, Set, WeakSet, Date, Math, JSON, RegExp, Promise, URL, Error, Number,
    setTimeout, clearTimeout,
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (el) => styleEls.push(el) },
      documentElement: { appendChild: (el) => styleEls.push(el) },
      // revealAllPending() sweeps this; the test controls what it returns.
      querySelectorAll: () => pendingNodes
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (typeof cb !== 'function') return; // fire-and-forget (image_ai_filtered)
          if (msg.type === 'ai_ping_model') {
            cb({ ready: true, backend: 'test' });
            return;
          }
          if (msg.type === 'ai_classify_image') {
            pendingClassifies.set(msg.src, cb);
          }
        }
      },
      storage: {
        session: {
          get: (_k, cb) => cb({}),
          set: () => Promise.resolve()
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = { location: { hostname: pageHost } };

  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  vm.runInContext(BLOCKER_SOURCE, sandbox, { filename: 'ai-image-blocker.js' });

  const api = sandbox.window.AIImageBlocker;

  return {
    api,
    sent,
    setPendingNodes: (nodes) => { pendingNodes = nodes; },
    // Answer an in-flight classify for `src`.
    resolveClassify(src, scores) {
      const cb = pendingClassifies.get(src);
      assert.ok(cb, `no classification in flight for ${src}`);
      pendingClassifies.delete(src);
      cb({ success: true, scores });
    },
    isClassifying: (src) => pendingClassifies.has(src),
    async init() {
      api.init(settings);
      // init defers pingModel by 50ms; let it land so the model reports ready.
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(api.isReady(), true, 'model should report ready');
    }
  };
}

const EXPLICIT = { Porn: 0.95, Hentai: 0.02, Sexy: 0.02, Drawing: 0.01, Neutral: 0.00 };
const SAFE = { Porn: 0.01, Hentai: 0.01, Sexy: 0.05, Drawing: 0.03, Neutral: 0.90 };

const A = 'https://pbs.twimg.com/media/AAA?format=jpg&name=small';
const B = 'https://pbs.twimg.com/media/BBB?format=jpg&name=small';

// ─── the reported bug: a stale verdict strips a live blur ────────────────────

test('a stale allow verdict does not unblur the image that replaced it', async () => {
  const h = loadBlocker();
  await h.init();

  // Node shows image A (safe). Classification starts.
  const img = makeImg(A);
  h.api.onImageVisible(img);
  assert.ok(h.isClassifying(A), 'A is being classified');

  // X recycles the node for a different post: it now shows B, which its own
  // verdict has already blocked.
  img.src = img.currentSrc = B;
  img.classList.remove(PENDING);
  img.classList.add(BLOCKED);

  // A's verdict finally arrives — and it is "safe".
  h.resolveClassify(A, SAFE);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(
    img.classList.contains(BLOCKED), true,
    'B must stay blurred; A\'s stale allow verdict must not be applied to it'
  );
});

test('a stale block verdict does not blur the image that replaced it', async () => {
  const h = loadBlocker();
  await h.init();

  const img = makeImg(A);
  h.api.onImageVisible(img);
  assert.ok(h.isClassifying(A));

  // Node recycled to B before A's verdict lands.
  img.src = img.currentSrc = B;
  img.classList.remove(PENDING);

  h.resolveClassify(A, EXPLICIT);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(
    img.classList.contains(BLOCKED), false,
    'the safe image now in the node must not inherit A\'s block verdict'
  );
});

test('a verdict is still applied when the node has not been recycled', async () => {
  const h = loadBlocker();
  await h.init();

  const img = makeImg(A);
  h.api.onImageVisible(img);
  assert.equal(img.classList.contains(PENDING), true, 'hidden while awaiting a verdict');

  h.resolveClassify(A, EXPLICIT);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(img.classList.contains(BLOCKED), true, 'explicit image is blurred');
  assert.equal(img.classList.contains(PENDING), false, 'pending hide is swapped for the blur');
  assert.ok(
    h.sent.some((m) => m.type === 'image_ai_filtered' && m.src === A),
    'the block is reported for the stats/audit log'
  );
});

test('the scores of a verdict dropped for a recycled node are still cached', async () => {
  const h = loadBlocker();
  await h.init();

  const img = makeImg(A);
  h.api.onImageVisible(img);
  img.src = img.currentSrc = B;          // recycled mid-flight
  h.resolveClassify(A, EXPLICIT);
  await new Promise((r) => setTimeout(r, 0));

  // A second node showing A must be blocked straight from cache — no refetch.
  const other = makeImg(A);
  h.api.onImageVisible(other);
  assert.equal(other.classList.contains(BLOCKED), true, 'served from cache');
  assert.equal(h.isClassifying(A), false, 'no second round-trip for the same URL');
});

// ─── onImageSrcChanged: hide, don't unblur ───────────────────────────────────

test('onImageSrcChanged hides the node instead of revealing the new image', async () => {
  const h = loadBlocker();
  await h.init();

  const img = makeImg(A);
  img.classList.add(BLOCKED);
  img.src = img.currentSrc = B;
  h.api.onImageSrcChanged(img);

  assert.equal(img.classList.contains(BLOCKED), false, 'the stale verdict is dropped');
  assert.equal(
    img.classList.contains(PENDING), true,
    'the new image stays hidden until its own verdict lands'
  );
});

test('onImageSrcChanged reveals the node when the AI filter is off', async () => {
  const h = loadBlocker({ settings: { enabled: true, aiImageBlocker: false } });
  h.api.init({ enabled: true, aiImageBlocker: false });

  const img = makeImg(A);
  img.classList.add(BLOCKED);
  h.api.onImageSrcChanged(img);

  assert.equal(img.classList.contains(BLOCKED), false);
  assert.equal(img.classList.contains(PENDING), false, 'never hide when the filter is off');
});

// ─── no image may be stranded hidden ─────────────────────────────────────────

for (const [label, mutate] of [
  ['a data: URL', (img) => { img.src = img.currentSrc = 'data:image/png;base64,AAAA'; }],
  ['an image below the minimum size', (img) => { img.naturalWidth = 16; img.naturalHeight = 16; }],
  ['no src at all', (img) => { img.src = img.currentSrc = ''; }]
]) {
  test(`onImageVisible reveals a pending node it declines to classify — ${label}`, async () => {
    const h = loadBlocker();
    await h.init();

    const img = makeImg(A);
    h.api.onImageSrcChanged(img);           // hidden, awaiting a fresh verdict
    assert.equal(img.classList.contains(PENDING), true);

    mutate(img);
    h.api.onImageVisible(img);

    assert.equal(
      img.classList.contains(PENDING), false,
      'a node we will never classify must not be left invisible'
    );
  });
}

test('onImageVisible reveals a pending node on a trusted image domain', async () => {
  const h = loadBlocker({
    settings: { enabled: true, aiImageBlocker: true, trustedImageDomains: ['twimg.com'] }
  });
  await h.init();

  const img = makeImg(A);
  h.api.onImageSrcChanged(img);
  assert.equal(img.classList.contains(PENDING), true);

  h.api.onImageVisible(img);
  assert.equal(img.classList.contains(PENDING), false, 'trusted domains are revealed, not hidden');
});

// ─── content.js must route src changes through the blocker ───────────────────

test('content.js hands a changed src to onImageSrcChanged rather than unblurring', () => {
  const source = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const observeImage = source.slice(source.indexOf('function observeImage(img)'));
  const body = observeImage.slice(0, observeImage.indexOf('\n}\n'));

  assert.match(
    body, /AIImageBlocker\.onImageSrcChanged\(img\)/,
    'observeImage must delegate a changed src to the AI blocker'
  );
  // The bare removal is only allowed as the fallback when the blocker is absent.
  const bareRemovals = body.match(/img\.classList\.remove\('pblocker-ai-blocked'\)/g) || [];
  assert.equal(bareRemovals.length, 1, 'exactly one fallback unblur, inside the else branch');
  assert.match(body, /\}\s*else\s*\{\s*\n\s*img\.classList\.remove\('pblocker-ai-blocked'\);/);
});
