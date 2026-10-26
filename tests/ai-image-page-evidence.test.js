// What the AI image blocker reports to the AI text blocker as corroboration:
// AIImageBlocker.pageEvidence() -> { checked, blocked } for the page on screen.
//
// It replaced a single running count of blurs (globalThis
// __pblockerAIImageBlockCount) that only ever went up. On YouTube that count
// survived every video change (navigation there is pushState, no new document)
// and kept counting thumbnails that had since been un-blurred, so one misread
// thumbnail anywhere in the tab's history could lower the text bar for every
// later watch page. These tests pin the three properties that fixes it:
// each image counts once, a blur taken off is taken back, and a new page
// address starts over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker-core.js'), 'utf8');
const BLOCKER_SOURCE = fs.readFileSync(path.join(ROOT, 'ai-image-blocker.js'), 'utf8');

const BLOCKED = 'pblocker-ai-blocked';
const EXPLICIT = { Porn: 0.95, Hentai: 0.02, Sexy: 0.02, Drawing: 0.01, Neutral: 0.00 };
const SAFE = { Porn: 0.01, Hentai: 0.01, Sexy: 0.05, Drawing: 0.03, Neutral: 0.90 };

function makeImg(src) {
  const classes = new Set();
  return {
    src,
    currentSrc: src,
    naturalWidth: 480,
    naturalHeight: 360,
    complete: true,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    }
  };
}

// Core + blocker in one sandbox. Classifications answer at once from `verdicts`
// (src -> scores); `location.href` is the page address the counts belong to.
function loadBlocker(verdicts) {
  let blurredNodes = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Map, Set, WeakSet, Date, Math, JSON, RegExp, Promise, URL, Error, Number, String,
    setTimeout, clearTimeout,
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      querySelectorAll: (sel) => (sel === '.' + BLOCKED ? blurredNodes : [])
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (typeof cb !== 'function') return;
          if (msg.type === 'ai_ping_model') return cb({ ready: true, backend: 'test' });
          if (msg.type === 'ai_classify_image') return cb({ success: true, scores: verdicts[msg.src] || SAFE });
        }
      },
      storage: { session: { get: (_k, cb) => cb({}), set: () => Promise.resolve() } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = { location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=one' } };
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  vm.runInContext(BLOCKER_SOURCE, sandbox, { filename: 'ai-image-blocker.js' });
  const api = sandbox.window.AIImageBlocker;
  return {
    api,
    navigate(href) { sandbox.window.location.href = href; },
    setBlurredNodes(nodes) { blurredNodes = nodes; },
    async init(settings = { enabled: true, aiImageBlocker: true }) {
      api.init(settings);
      await new Promise((r) => setTimeout(r, 80)); // init defers the model ping
    },
    async judge(img) {
      api.onImageVisible(img);
      await new Promise((r) => setTimeout(r, 0));
    },
    evidence: () => ({ ...api.pageEvidence() })
  };
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

test('counts every judged image, and the blurred ones among them', async () => {
  const h = loadBlocker({ [thumb('bad1')]: EXPLICIT, [thumb('bad2')]: EXPLICIT });
  await h.init();
  for (const id of ['ok1', 'bad1', 'ok2', 'bad2', 'ok3']) await h.judge(makeImg(thumb(id)));
  assert.deepEqual(h.evidence(), { checked: 5, blocked: 2 });
});

test('an image judged again, or served from cache, counts once', async () => {
  const h = loadBlocker({ [thumb('bad')]: EXPLICIT });
  await h.init();
  const img = makeImg(thumb('bad'));
  await h.judge(img);
  await h.judge(img);           // cached verdict re-applied to the same node
  assert.deepEqual(h.evidence(), { checked: 1, blocked: 1 });
  await h.judge(makeImg(thumb('bad')));  // the same picture in a second node is a second image
  assert.deepEqual(h.evidence(), { checked: 2, blocked: 2 });
});

test('a blur taken off is taken back: the node now shows something else', async () => {
  const h = loadBlocker({ [thumb('bad')]: EXPLICIT });
  await h.init();
  const img = makeImg(thumb('bad'));
  await h.judge(img);
  assert.equal(h.evidence().blocked, 1);

  // A feed recycles the node for another video, which turns out safe.
  img.src = img.currentSrc = thumb('ok');
  h.api.onImageSrcChanged(img);
  assert.equal(h.evidence().blocked, 0, 'the old picture is gone, so is its blur');
  await h.judge(img);
  assert.deepEqual(h.evidence(), { checked: 1, blocked: 0 }, 'still one image, now clear');
});

test('a blur taken off is taken back: the image is re-judged as safe', async () => {
  const h = loadBlocker({ [thumb('edge')]: { Porn: 0.30, Hentai: 0.20, Sexy: 0.05, Drawing: 0.40, Neutral: 0.05 } });
  await h.init({ enabled: true, aiImageBlocker: true, aiThresholds: { pornHentai: 0.45, sexy: 0.80 } });
  const img = makeImg(thumb('edge'));
  await h.judge(img);
  assert.equal(h.evidence().blocked, 1, 'blurred at Strict');

  // The user moves to Relaxed: the cached scores are read against the new bar.
  await h.init({ enabled: true, aiImageBlocker: true, aiThresholds: { pornHentai: 0.80, sexy: 0.97 } });
  await h.judge(img);
  assert.equal(img.classList.contains(BLOCKED), false);
  assert.deepEqual(h.evidence(), { checked: 1, blocked: 0 });
});

test('turning the image filter off takes every blur back', async () => {
  const h = loadBlocker({ [thumb('bad1')]: EXPLICIT, [thumb('bad2')]: EXPLICIT });
  await h.init();
  const nodes = [makeImg(thumb('bad1')), makeImg(thumb('bad2'))];
  for (const img of nodes) await h.judge(img);
  assert.equal(h.evidence().blocked, 2);

  h.setBlurredNodes(nodes);
  h.api.init({ enabled: true, aiImageBlocker: false });
  assert.equal(h.evidence().blocked, 0);
});

test('a new page address starts over (YouTube moving to the next video)', async () => {
  const h = loadBlocker({ [thumb('bad1')]: EXPLICIT, [thumb('bad2')]: EXPLICIT });
  await h.init();
  const old = makeImg(thumb('bad1'));
  await h.judge(old);
  await h.judge(makeImg(thumb('bad2')));
  await h.judge(makeImg(thumb('ok')));
  assert.deepEqual(h.evidence(), { checked: 3, blocked: 2 });

  h.navigate('https://www.youtube.com/watch?v=two');
  assert.deepEqual(h.evidence(), { checked: 0, blocked: 0 }, 'nothing judged on this page yet');

  // A node blurred on the previous page and recycled here must not drive the
  // count below zero, and is counted afresh once judged on this page.
  old.src = old.currentSrc = thumb('ok2');
  h.api.onImageSrcChanged(old);
  assert.deepEqual(h.evidence(), { checked: 0, blocked: 0 });
  await h.judge(old);
  assert.deepEqual(h.evidence(), { checked: 1, blocked: 0 });
});

test('a change of #hash alone is the same page', async () => {
  const h = loadBlocker({ [thumb('bad')]: EXPLICIT });
  await h.init();
  await h.judge(makeImg(thumb('bad')));
  h.navigate('https://www.youtube.com/watch?v=one#comments');
  assert.deepEqual(h.evidence(), { checked: 1, blocked: 1 });
});

test('the old ever-growing counter is gone', () => {
  for (const file of ['ai-image-blocker.js', 'content.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(source.includes('__pblockerAIImageBlockCount'), false, `${file} still uses the old counter`);
  }
});
