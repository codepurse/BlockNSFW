# AI Image Blocker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-device AI image classifier (NSFW.js / MobileNet v2) to BlockNSFW that detects adult images in any visible `<img>` element and applies a heavy blur when the model flags the content.

**Architecture:** A Web Worker (vendored `@tensorflow/tfjs` + `nsfwjs`) receives transferable `ImageBitmap`s from a content-script controller (`ai-image-blocker.js`) that piggybacks on the existing `IntersectionObserver` in `content.js`. Verdicts are cached in `chrome.storage.session`, applied via a `.pblocker-ai-blocked` CSS class, and counted in a new `aiImageBlockedCount` stat. No network calls; the model is bundled.

**Tech Stack:** Plain ES2020 JavaScript (no TypeScript, no build step), Node.js built-in test runner (`node --test`), `vm` sandbox for unit-testing browser-targeted code in Node, Manifest V3 extension API.

**Spec:** [docs/superpowers/specs/2026-06-09-ai-image-blocker-design.md](file:///d:/Project/Extension/Pblocker/BlockNSFW/docs/superpowers/specs/2026-06-09-ai-image-blocker-design.md)

---

## Conventions

- All paths are relative to the repo root (`d:/Project/Extension/Pblocker/BlockNSFW`).
- Run tests with: `node --test tests/*.test.js`
- Run a single test file: `node --test tests/<file>.test.js`
- Browser-targeted source files use top-level `function` declarations so they can be loaded into a `vm` sandbox for testing (matches the existing `tests/setup.js` pattern).
- All commit messages are conventional-commits style: `feat:`, `chore:`, `test:`, `docs:`.

---

## Task 1: Vendor tfjs + nsfwjs + model files

**Files:**
- Create: `vendor/tfjs/tf.min.js` (copied from npm package)
- Create: `vendor/nsfwjs/nsfwjs.min.js` (copied from npm package)
- Create: `nsfwjs/model.json`
- Create: `nsfwjs/group1-shard1of1.bin` (downloaded from the nsfwjs GitHub `models/mobilenet_v2/` directory — single-shard layout)

- [ ] **Step 1: Install the npm packages into a temporary location**

```bash
cd d:/Project/Extension/Pblocker/BlockNSFW
npm install --no-save --prefix .vendor-staging @tensorflow/tfjs@4.22.0 nsfwjs@4.2.1
```

Expected: creates `.vendor-staging/node_modules/@tensorflow/tfjs` and `.vendor-staging/node_modules/nsfwjs`.

- [ ] **Step 2: Copy the tfjs UMD bundle**

```bash
mkdir -p vendor/tfjs
cp .vendor-staging/node_modules/@tensorflow/tfjs/dist/tf.min.js vendor/tfjs/tf.min.js
ls -la vendor/tfjs/tf.min.js
```

Expected: a single file, ~1.0–1.2 MB.

- [ ] **Step 3: Copy the nsfwjs UMD bundle**

```bash
mkdir -p vendor/nsfwjs
cp .vendor-staging/node_modules/nsfwjs/dist/nsfwjs.min.js vendor/nsfwjs/nsfwjs.min.js
ls -la vendor/nsfwjs/nsfwjs.min.js
```

Expected: a single file, ~2.7 MB. (The spec originally estimated 5–10 KB based on older nsfwjs versions; the 4.2.1 UMD bundle is significantly larger because it inlines some utilities.)

- [ ] **Step 4: Download the bundled NSFW.js model**

The MobileNet v2 model in nsfwjs 4.2.1 is a single-shard file (`group1-shard1of1`, ~2.6 MB). The most reliable way to vendor it is to download the raw files from the nsfwjs GitHub repo, because the npm package's internal layout is version-dependent.

```bash
mkdir -p nsfwjs
curl -L -o nsfwjs/model.json https://raw.githubusercontent.com/infinitered/nsfwjs/master/models/mobilenet_v2/model.json
curl -L -o nsfwjs/group1-shard1of1.bin https://raw.githubusercontent.com/infinitered/nsfwjs/master/models/mobilenet_v2/group1-shard1of1
ls -la nsfwjs/
```

Expected: `model.json` (~129 KB) + `group1-shard1of1.bin` (~2.6 MB), for ~2.7 MB total.

(PowerShell note: `curl` may be aliased to `Invoke-WebRequest`. If `curl -L -o` doesn't work, use `Invoke-WebRequest -Uri <url> -OutFile <path>`. Verify the resulting file size matches — a 0-byte or HTML error page means curl failed.)

(Fallback: if curl/Invoke-WebRequest fails (no internet, GitHub blocked), try the npm package. The nsfwjs 4.2.1 bundled model lives at `dist/cjs/models/mobilenet_v2/model.min.js` + `dist/cjs/models/mobilenet_v2/group1-shard1of1.min.js` — but these are base64-wrapped and would need an `nsfwjs.loadFromBundle()` call instead of `nsfwjs.load()`. **Prefer the GitHub path**; only fall back if curl fails, and report the network issue.)

- [ ] **Step 5: Add `vendor/` and `nsfwjs/` to `.gitignore` exclusions (override) and verify**

The vendored files are binary and large. We **do** want them tracked in git (the extension is shipped as a directory, not via the Web Store), so verify `.gitignore` does NOT exclude them:

```bash
cat .gitignore
git check-ignore -v vendor/tfjs/tf.min.js nsfwjs/model.json
```

If `git check-ignore` prints any path, the file is being ignored. Edit `.gitignore` to remove the relevant `vendor/` or `nsfwjs/` line.

Expected: `git check-ignore` prints nothing (exit code 1) for both files.

- [ ] **Step 6: Clean up the staging directory**

```bash
rm -rf .vendor-staging
```

- [ ] **Step 7: Smoke check — every file is non-empty**

```bash
for f in vendor/tfjs/tf.min.js vendor/nsfwjs/nsfwjs.min.js nsfwjs/model.json nsfwjs/group1-shard1of1.bin; do
  test -s "$f" || { echo "EMPTY: $f"; exit 1; }
done
echo "all vendor files present"
```

Expected: `all vendor files present`.

- [ ] **Step 8: Commit**

```bash
git add vendor/ nsfwjs/ .gitignore
git commit -m "chore: vendor tfjs 4.22.0 and nsfwjs 4.2.1 with bundled MobileNet v2 model"
```

---

## Task 2: `ai-image-blocker-core.js` — pure logic (TDD)

**Files:**
- Create: `ai-image-blocker-core.js`
- Create: `tests/ai-image-blocker-core.test.js`

This file contains only pure functions (no DOM, no `chrome.*`, no `Worker`). It is loaded as a content script in `manifest.json` BEFORE `ai-image-blocker.js`, so its top-level functions become reachable in the same script execution as the controller. Tests load it via `vm.runInContext` in a minimal sandbox.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-image-blocker-core.test.js`:

```js
// Tests for the pure helpers in ai-image-blocker-core.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'ai-image-blocker-core.js'),
  'utf8'
);

function loadCore() {
  const sandbox = {
    console,
    Map,
    Set,
    Date,
    Math,
    JSON,
    RegExp,
    Promise,
    URL,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  return sandbox;
}

// ─── verdictFor ──────────────────────────────────────────────────────────

test('verdictFor: high Porn blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.80, Hentai: 0.10, Sexy: 0.05, Drawing: 0.03, Neutral: 0.02 }), 'block');
});

test('verdictFor: high Hentai blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.10, Hentai: 0.85, Sexy: 0.03, Drawing: 0.01, Neutral: 0.01 }), 'block');
});

test('verdictFor: Porn + Hentai just at 0.50 blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.30, Hentai: 0.20, Sexy: 0.40, Drawing: 0.05, Neutral: 0.05 }), 'block');
});

test('verdictFor: Porn + Hentai just below 0.50 allows even with high Sexy', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.20, Hentai: 0.20, Sexy: 0.69, Drawing: 0.05, Neutral: 0.06 }), 'allow');
});

test('verdictFor: Sexy exactly at 0.70 blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.70, Drawing: 0.10, Neutral: 0.10 }), 'block');
});

test('verdictFor: Sexy 0.69 allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.69, Drawing: 0.10, Neutral: 0.11 }), 'allow');
});

test('verdictFor: all-Neutral allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.01, Hentai: 0.01, Sexy: 0.02, Drawing: 0.05, Neutral: 0.91 }), 'allow');
});

test('verdictFor: all-Drawing allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.10, Drawing: 0.75, Neutral: 0.05 }), 'allow');
});

// ─── firstPartyMatch ─────────────────────────────────────────────────────

test('firstPartyMatch: exact match', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('example.com', 'example.com'), true);
});

test('firstPartyMatch: image is subdomain of page', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('cdn.example.com', 'example.com'), true);
});

test('firstPartyMatch: page is subdomain of image', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('example.com', 'cdn.example.com'), true);
});

test('firstPartyMatch: different registrable domains', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('evil.com', 'example.com'), false);
});

test('firstPartyMatch: suffix lookalike does not match', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('notexample.com', 'example.com'), false);
});

test('firstPartyMatch: subdomain mismatch is not first-party', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('other.example.com', 'sub.example.com'), false);
});

// ─── shouldSkipImage ─────────────────────────────────────────────────────

function makeImg(overrides) {
  return Object.assign({
    src: 'https://cdn.example.com/photo.jpg',
    currentSrc: 'https://cdn.example.com/photo.jpg',
    naturalWidth: 800,
    naturalHeight: 600,
    offsetParent: {},
    hostname: 'cdn.example.com',
  }, overrides);
}

test('shouldSkipImage: settings off → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg(), { aiImageBlocker: false, trustedDomains: new Set() }), true);
});

test('shouldSkipImage: degraded → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg(), { aiImageBlocker: true, degraded: true, trustedDomains: new Set() }), true);
});

test('shouldSkipImage: trusted domain → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ hostname: 'i.imgur.com' }), { aiImageBlocker: true, trustedDomains: new Set(['i.imgur.com']) }), true);
});

test('shouldSkipImage: first-party → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ hostname: 'example.com' }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'example.com' }), true);
});

test('shouldSkipImage: too small (width) → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ naturalWidth: 32, naturalHeight: 200 }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: too small (height) → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ naturalWidth: 200, naturalHeight: 32 }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: data: URL → skip', () => {
  const ctx = loadCore();
  const img = makeImg({ src: 'data:image/png;base64,AAAA', currentSrc: 'data:image/png;base64,AAAA' });
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: blob: URL → skip', () => {
  const ctx = loadCore();
  const img = makeImg({ src: 'blob:https://example.com/abc', currentSrc: 'blob:https://example.com/abc' });
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: hidden element → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ offsetParent: null }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: already in cache → skip', () => {
  const ctx = loadCore();
  const img = makeImg();
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com', lru: new Map([[img.currentSrc, { verdict: 'allow' }]]) }), true);
});

test('shouldSkipImage: regular external image → do not skip', () => {
  const ctx = loadCore();
  const img = makeImg();
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), false);
});

// ─── LRU helpers ─────────────────────────────────────────────────────────

test('setWithCap: writes new entries under the cap', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 3);
  ctx.setWithCap(m, 'b', 2, 3);
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), 1);
  assert.equal(m.get('b'), 2);
});

test('setWithCap: evicts oldest when at cap', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 2);
  ctx.setWithCap(m, 'b', 2, 2);
  ctx.setWithCap(m, 'c', 3, 2);
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), false, 'oldest should be evicted');
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
});

test('setWithCap: updating existing key preserves order', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 2);
  ctx.setWithCap(m, 'b', 2, 2);
  ctx.setWithCap(m, 'a', 11, 2);   // re-set 'a'
  ctx.setWithCap(m, 'c', 3, 2);   // now 'b' is oldest
  assert.equal(m.size, 2);
  assert.equal(m.has('b'), false, 'b should be evicted (was oldest after a was refreshed)');
  assert.equal(m.get('a'), 11);
  assert.equal(m.get('c'), 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/ai-image-blocker-core.test.js
```

Expected: every test fails with `TypeError: ctx.verdictFor is not a function` (or similar — the file doesn't exist yet).

- [ ] **Step 3: Write `ai-image-blocker-core.js`**

```js
// Pure helpers for the AI Image Blocker. No DOM, no chrome.*, no Worker —
// safe to load in a Node vm sandbox for testing. Loaded in manifest.json
// before ai-image-blocker.js so its top-level functions are reachable.

// Minimum natural dimension for an image to be worth scanning. Below this
// the model is unreliable and the user almost certainly wants the image
// rendered (icons, avatars, spinners).
const MIN_NATURAL_DIMENSION = 64;

// Class applied to <img> elements the model flagged.
const BLOCKED_CLASS = 'pblocker-ai-blocked';

// Score → verdict.
//   Porn + Hentai >= 0.50  → block  (explicit imagery; model is confident)
//   Sexy         >= 0.70   → block  (suggestive; model is noisier, higher bar)
function verdictFor(scores) {
  if (!scores) return 'allow';
  const pornHentai = (scores.Porn || 0) + (scores.Hentai || 0);
  if (pornHentai >= 0.50) return 'block';
  if ((scores.Sexy || 0) >= 0.70) return 'block';
  return 'allow';
}

// First-party check using simple suffix matching (not the Public Suffix List).
//   imageHost === pageHost
//   imageHost ends with '.' + pageHost
//   pageHost  ends with '.' + imageHost
function firstPartyMatch(imageHost, pageHost) {
  if (!imageHost || !pageHost) return false;
  if (imageHost === pageHost) return true;
  if (imageHost.endsWith('.' + pageHost)) return true;
  if (pageHost.endsWith('.' + imageHost)) return true;
  return false;
}

// Decide whether an image should be skipped without classification.
// `opts` shape:
//   { aiImageBlocker: boolean, degraded?: boolean, trustedDomains: Set<string>,
//     pageHost?: string, lru?: Map<string, any> }
// `img` shape (plain object, not necessarily HTMLImageElement):
//   { src, currentSrc, naturalWidth, naturalHeight, offsetParent, hostname }
function shouldSkipImage(img, opts) {
  if (!opts || opts.aiImageBlocker === false) return true;
  if (opts.degraded) return true;

  const src = (img && (img.currentSrc || img.src)) || '';
  if (!src) return true;
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;

  if (img.naturalWidth != null && img.naturalWidth < MIN_NATURAL_DIMENSION) return true;
  if (img.naturalHeight != null && img.naturalHeight < MIN_NATURAL_DIMENSION) return true;

  if (img.offsetParent == null) return true;

  const host = (img.hostname || '').toLowerCase();
  if (host && opts.trustedDomains && opts.trustedDomains.has(host)) return true;

  if (host && opts.pageHost && firstPartyMatch(host, opts.pageHost.toLowerCase())) return true;

  if (opts.lru && opts.lru.has(src)) return true;

  return false;
}

// Insert into a Map with a hard cap. When full, the oldest entry (first
// insertion) is dropped. Updating an existing key is a no-op for ordering
// — the key keeps its original position, which is the desired LRU
// semantic for our cache (we only want freshness, not strict LRU).
function setWithCap(map, key, value, maxSize) {
  if (map.has(key)) {
    map.set(key, value);
    return;
  }
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/ai-image-blocker-core.test.js
```

Expected: all 25 tests pass.

- [ ] **Step 5: Commit**

```bash
git add ai-image-blocker-core.js tests/ai-image-blocker-core.test.js
git commit -m "feat(ai-blocker): add core verdict/skip/lru helpers with unit tests"
```

---

## Task 3: `classify.worker.js` — the Web Worker

**Files:**
- Create: `classify.worker.js`

No TDD — Web Workers can't be unit-tested under `node --test`. The worker is verified by the integration smoke test in Task 10.

- [ ] **Step 1: Write the worker module**

```js
// ES-module Web Worker. Owns the tfjs + nsfwjs lifecycle and the model.
// Receives Transferable ImageBitmaps from the content script and replies
// with a scores object (or an error string) keyed by the caller-supplied
// requestId.

import * as tf from './vendor/tfjs/tf.min.js';
import * as nsfwjs from './vendor/nsfwjs/nsfwjs.min.js';

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
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check classify.worker.js
```

Expected: exits 0, no output. (Node won't actually resolve the imports, but the syntax must parse.)

- [ ] **Step 3: Commit**

```bash
git add classify.worker.js
git commit -m "feat(ai-blocker): add ES-module classify worker with tfjs+nsfwjs"
```

---

## Task 4: `ai-image-blocker.js` — content-script controller

**Files:**
- Create: `ai-image-blocker.js`

This file is browser-targeted. It assumes `ai-image-blocker-core.js` has already loaded (manifest order) and that `chrome`, `Worker`, `IntersectionObserver`, `createImageBitmap`, `URL`, `chrome.runtime.getURL`, `chrome.storage.session` are all available.

- [ ] **Step 1: Write the controller**

```js
// AI Image Blocker — content-script controller.
// Boots a Web Worker that runs NSFW.js / MobileNet v2 and routes every
// visible <img> through it. Verdict: 'block' → add .pblocker-ai-blocked
// class. Verdict: 'allow' → no-op. Results are cached in a session-scoped
// LRU mirrored to chrome.storage.session. The pure logic lives in
// ai-image-blocker-core.js (loaded earlier in manifest.json order).

(function () {
  'use strict';

  // Refuse to run on extension / browser-internal pages.
  if (typeof window === 'undefined') return;
  const scheme = (window.location && window.location.protocol) || '';
  if (scheme === 'chrome-extension:' || scheme === 'moz-extension:' ||
      scheme === 'about:' || scheme === 'devtools:') {
    return;
  }

  const MAX_INFLIGHT = 4;
  const MAX_CACHE_ENTRIES = 2000;
  const CACHE_KEY = 'pblocker_ai_image_cache_v1';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const STORAGE_FLUSH_IDLE_MS = 5000;
  const STYLE_ID = 'pblocker-ai-blocker-styles';

  const state = {
    worker: null,
    inflight: new Map(),
    pendingQueue: [],
    nextRequestId: 1,
    modelReady: false,
    modelReadyPromise: null,
    modelReadyResolve: null,
    lru: new Map(),
    aiBlockerDegraded: false,
    degradeToastShown: false,
    settings: null,
    trustedDomains: new Set(),
    pageHost: (window.location && window.location.hostname || '').toLowerCase(),
    storageFlushTimer: null,
  };

  function showDegradeToast() {
    if (state.degradeToastShown) return;
    state.degradeToastShown = true;
    // Reuse the existing toast pattern from content.js if available.
    // Fall back to a simple console warning if the global is missing.
    if (typeof window.pblockerShowToast === 'function') {
      window.pblockerShowToast('AI Image Blocker unavailable — model failed to load.', 6000);
    } else {
      console.warn('[BlockNSFW] AI Image Blocker unavailable — model failed to load.');
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent =
      '.pblocker-ai-blocked {' +
        'filter: blur(50px) !important;' +
        'pointer-events: none !important;' +
        'user-select: none !important;' +
        '-webkit-user-drag: none !important;' +
      '}';
    (document.head || document.documentElement).appendChild(el);
  }

  function scheduleStorageFlush() {
    if (state.storageFlushTimer != null) return;
    const flush = () => {
      state.storageFlushTimer = null;
      const obj = {};
      for (const [k, v] of state.lru) obj[k] = v;
      try {
        chrome.storage.session.set({ [CACHE_KEY]: obj }).catch(() => {
          // Quota exceeded or session ended — fall back to in-memory only.
        });
      } catch (_) { /* session storage unavailable */ }
    };
    const ric = (typeof window.requestIdleCallback === 'function')
      ? window.requestIdleCallback : (cb) => setTimeout(cb, 0);
    ric(() => {
      state.storageFlushTimer = setTimeout(flush, STORAGE_FLUSH_IDLE_MS);
    });
  }

  function loadCacheFromStorage() {
    try {
      chrome.storage.session.get(CACHE_KEY, (res) => {
        const data = res && res[CACHE_KEY];
        if (!data || typeof data !== 'object') return;
        const entries = Object.entries(data)
          .map(([src, entry]) => ({ src, entry }))
          .filter(({ entry }) => entry && entry.ts && (Date.now() - entry.ts) < CACHE_TTL_MS)
          .sort((a, b) => a.entry.ts - b.entry.ts);
        const kept = entries.slice(-MAX_CACHE_ENTRIES);
        for (const { src, entry } of kept) {
          state.lru.set(src, entry);
        }
      });
    } catch (_) { /* ignore */ }
  }

  function buildTrustedDomainSet() {
    const set = new Set();
    const globalList = (window.DEFAULT_TRUSTED_IMAGE_DOMAINS) || [];
    for (const d of globalList) set.add(String(d).toLowerCase());
    const userList = (state.settings && state.settings.trustedImageDomains) || [];
    for (const d of userList) set.add(String(d).toLowerCase());
    return set;
  }

  function applyVerdict(img, verdict, scores) {
    if (!img || !img.classList) return;
    if (verdict === 'block') {
      img.classList.add(BLOCKED_CLASS);
      try {
        chrome.runtime.sendMessage({
          type: 'image_ai_filtered',
          url: window.location.href,
          src: img.currentSrc || img.src,
          scores,
        });
      } catch (_) { /* context invalidated */ }
    }
  }

  function handleClassified(requestId, payload) {
    const pending = state.inflight.get(requestId);
    if (!pending) return;
    state.inflight.delete(requestId);
    if (payload && payload.error) {
      // Per-image failure — drop quietly, the image renders normally.
      return;
    }
    const scores = payload && payload.scores;
    const verdict = verdictFor(scores);
    setWithCap(state.lru, pending.src, { scores, verdict, ts: Date.now() }, MAX_CACHE_ENTRIES);
    applyVerdict(pending.img, verdict, scores);
    scheduleStorageFlush();
    drainQueue();
  }

  function drainQueue() {
    while (state.pendingQueue.length > 0 && state.inflight.size < MAX_INFLIGHT) {
      const next = state.pendingQueue.shift();
      sendForClassification(next);
    }
  }

  function sendForClassification(img) {
    if (!img || state.aiBlockerDegraded) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    if (state.inflight.size >= MAX_INFLIGHT) {
      state.pendingQueue.push(img);
      return;
    }
    let bitmap;
    try {
      bitmap = createImageBitmap(img);
    } catch (err) {
      // Tainted canvas, decode failure, etc.
      return;
    }
    const requestId = state.nextRequestId++;
    state.inflight.set(requestId, { img, src });
    Promise.resolve(bitmap)
      .then((b) => {
        state.worker.postMessage({ type: 'classify', requestId, src, bitmap: b }, [b]);
      })
      .catch(() => {
        state.inflight.delete(requestId);
      });
  }

  function setupWorker() {
    try {
      state.worker = new Worker(chrome.runtime.getURL('classify.worker.js'), { type: 'module' });
    } catch (err) {
      state.aiBlockerDegraded = true;
      showDegradeToast();
      return;
    }
    state.modelReadyPromise = new Promise((resolve) => { state.modelReadyResolve = resolve; });

    state.worker.addEventListener('message', (e) => {
      const data = e.data || {};
      if (data.type === 'model_ready') {
        state.modelReady = true;
        if (state.modelReadyResolve) state.modelReadyResolve();
        drainQueue();
        return;
      }
      if (data.type === 'model_error') {
        state.aiBlockerDegraded = true;
        showDegradeToast();
        return;
      }
      if (data.type === 'worker_error') {
        // The worker died; re-spawn on the next call.
        try { state.worker.terminate(); } catch (_) {}
        state.worker = null;
        state.modelReady = false;
        // Best-effort re-spawn: schedule for next tick.
        setTimeout(setupWorker, 0);
        return;
      }
      if (data.type === 'classified') {
        handleClassified(data.requestId, data);
      }
    });

    state.worker.addEventListener('error', () => {
      try { state.worker && state.terminate && state.worker.terminate(); } catch (_) {}
      state.worker = null;
      state.modelReady = false;
      setTimeout(setupWorker, 0);
    });
  }

  function onImageVisible(img) {
    if (!state.settings || state.settings.aiImageBlocker === false) return;
    if (state.aiBlockerDegraded) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    // Build a plain object so the core helper doesn't need a real <img>.
    const imgShape = {
      src: img.src,
      currentSrc: img.currentSrc,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      offsetParent: img.offsetParent,
      hostname: hostnameOf(src),
    };
    const opts = {
      aiImageBlocker: true,
      degraded: state.aiBlockerDegraded,
      trustedDomains: state.trustedDomains,
      pageHost: state.pageHost,
      lru: state.lru,
    };
    if (shouldSkipImage(imgShape, opts)) return;
    sendForClassification(img);
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  // Expose the public surface consumed by content.js.
  window.AIImageBlocker = {
    init(settings) {
      state.settings = settings || state.settings || {};
      state.trustedDomains = buildTrustedDomainSet();
      if (!state.worker) setupWorker();
      if (state.lru.size === 0) loadCacheFromStorage();
      injectStyles();
    },
    onImageVisible,
  };
})();
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check ai-image-blocker.js
```

Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add ai-image-blocker.js
git commit -m "feat(ai-blocker): add content-script controller with worker bridge"
```

---

## Task 5: Wire `content.js` to call `AIImageBlocker.onImageVisible`

**Files:**
- Modify: `content.js` (around line 2410, inside `observeImage`)

- [ ] **Step 1: Read the current `observeImage` to find the exact insertion point**

```bash
grep -n "function observeImage\|imageObserver.observe" content.js | head -20
```

- [ ] **Step 2: Add the call to `AIImageBlocker.onImageVisible`**

Find the body of `observeImage(img)` and add one line at the end. Example (the exact surrounding code will match your `grep` output):

```js
function observeImage(img) {
  imageObserver.observe(img);
  // ... existing onImageVisible logic ...
  if (typeof window.AIImageBlocker !== 'undefined' &&
      window.AIImageBlocker &&
      typeof window.AIImageBlocker.onImageVisible === 'function') {
    window.AIImageBlocker.onImageVisible(img);
  }
}
```

- [ ] **Step 3: Verify the file still parses**

```bash
node --check content.js
```

Expected: exit 0, no output.

- [ ] **Step 4: Run the full test suite to confirm nothing else broke**

```bash
node --test tests/*.test.js
```

Expected: same pass count as before this task.

- [ ] **Step 5: Commit**

```bash
git add content.js
git commit -m "feat(ai-blocker): wire content.js to AIImageBlocker.onImageVisible"
```

---

## Task 6: `background.js` — message handler + new stats field

**Files:**
- Modify: `background.js` (3 small additions)

- [ ] **Step 1: Add the new stats field**

Find `DEFAULT_STATS` (around line 82) and add a new field. The block looks like:

```js
const DEFAULT_STATS = {
  // ... existing fields ...
  imageBlockedCount: 0,
+ aiImageBlockedCount: 0,
};
```

(Adjust the surrounding fields to match the actual file. Keep alphabetical / grouped order if the file uses one.)

- [ ] **Step 2: Add the new `updateStats` switch case**

Find the `updateStats` function's switch on `message.type` and add a new case alongside the existing `'image_filtered'`:

```js
case 'image_filtered':
  // existing
  break;
+ case 'image_ai_filtered':
+   newStats.aiImageBlockedCount++;
+   newDailyStats.imageAiBlocked = (newDailyStats.imageAiBlocked || 0) + 1;
+   break;
```

- [ ] **Step 3: Add the new message handler in the `onMessage` listener**

Find the `chrome.runtime.onMessage.addListener` block (around line 1370) and add the new branch alongside the existing `image_filtered` branch:

```js
} else if (message.type === 'image_filtered') {
  // existing
  sendResponse({ success: true });
+ } else if (message.type === 'image_ai_filtered') {
+   updateStats('image_ai_filtered');
+   try {
+     const url = typeof message.url === 'string'
+       ? message.url
+       : (typeof sender !== 'undefined' && sender && sender.url ? sender.url : '');
+     if (url) logBlockedPage(url, 'AI image filtered');
+   } catch (_) {}
+   sendResponse({ success: true });
 }
```

- [ ] **Step 4: Verify the file still parses**

```bash
node --check background.js
```

Expected: exit 0.

- [ ] **Step 5: Run the full test suite**

```bash
node --test tests/*.test.js
```

Expected: all existing tests still pass.

- [ ] **Step 6: Add a regression test for the new stats path**

Create `tests/ai-image-blocker-stats.test.js` (so the test is opt-in and easy to skip if the source layout changes):

```js
// Regression: aiImageBlockedCount is defined in background.js's
// DEFAULT_STATS object. We verify by source-string match because const
// declarations are not reachable through the vm sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('background.js declares aiImageBlockedCount in DEFAULT_STATS', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'), 'utf8'
  );
  assert.match(
    source,
    /aiImageBlockedCount\s*:\s*0/,
    'DEFAULT_STATS should initialize aiImageBlockedCount to 0'
  );
});

test('background.js handles the image_ai_filtered message', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'), 'utf8'
  );
  assert.match(
    source,
    /['"]image_ai_filtered['"]/,
    'background.js should reference the image_ai_filtered message type'
  );
});
```

Then run:

```bash
node --test tests/ai-image-blocker-stats.test.js
```

Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add background.js tests/ai-image-blocker-stats.test.js
git commit -m "feat(ai-blocker): add image_ai_filtered message handler and stats field"
```

---

## Task 7: `manifest.json` and `manifest.firefox.json` updates

**Files:**
- Modify: `manifest.json` — add `ai-image-blocker-core.js` + `ai-image-blocker.js` to `content_scripts[0].js`, add 12 paths to `web_accessible_resources[0].resources`
- Modify: `manifest.firefox.json` — same edits

- [ ] **Step 1: Read the current `content_scripts` block in `manifest.json`**

```bash
grep -n "content_scripts\|\"js\"" manifest.json
```

- [ ] **Step 2: Add the two new content scripts to `manifest.json`**

Edit the `js` array inside the first (and only) `content_scripts` entry. The result should be:

```json
"js": [
  "shared/hostname.js",
  "shared/host-keywords.js",
  "ai-image-blocker-core.js",
  "ai-image-blocker.js",
  "content.js"
]
```

Order matters: `ai-image-blocker-core.js` must load before `ai-image-blocker.js` so its top-level functions are reachable.

- [ ] **Step 3: Add the 12 new paths to `web_accessible_resources`**

Edit the `resources` array in `web_accessible_resources[0]`. Append:

```json
"classify.worker.js",
"vendor/tfjs/tf.min.js",
"vendor/nsfwjs/nsfwjs.min.js",
"nsfwjs/model.json",
"nsfwjs/group1-shard1of1.bin"
]
```

- [ ] **Step 4: Mirror the same edits in `manifest.firefox.json`**

Apply the same `content_scripts` and `web_accessible_resources` edits to [manifest.firefox.json](file:///d:/Project/Extension/Pblocker/BlockNSFW/manifest.firefox.json) (if it exists; if it does not, skip this step and document the gap in the PR description).

- [ ] **Step 5: Validate the JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK');"
node -e "JSON.parse(require('fs').readFileSync('manifest.firefox.json','utf8')); console.log('manifest.firefox.json OK');" 2>/dev/null || echo "(no Firefox manifest — skipped)"
```

Expected: `manifest.json OK` and (optionally) `manifest.firefox.json OK`.

- [ ] **Step 6: Verify every new `web_accessible_resources` file exists on disk**

```bash
for p in classify.worker.js vendor/tfjs/tf.min.js vendor/nsfwjs/nsfwjs.min.js nsfwjs/model.json nsfwjs/group1-shard1of1.bin; do
  test -f "$p" || { echo "MISSING: $p"; exit 1; }
done
echo "all manifest resources present"
```

- [ ] **Step 7: Commit**

```bash
git add manifest.json manifest.firefox.json
git commit -m "chore(ai-blocker): wire worker, tfjs, nsfwjs, and model into manifest"
```

---

## Task 8: Options page — new card + toggle handler

**Files:**
- Modify: `options.html` (add the new card after the existing "Image Filtering Level" card)
- Modify: `options.js` (add the new field, render block, change handler)

- [ ] **Step 1: Add the new field to `DEFAULT_SETTINGS`**

In [options.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/options.js), find `DEFAULT_SETTINGS` (around line 9–24) and add:

```js
+ aiImageBlocker: true,
```

- [ ] **Step 2: Add the new card to `options.html`**

Insert the following HTML immediately after the closing `</div>` of the existing "Image Filtering Level" card (search for "Image Filtering Level" to find the right spot):

```html
<div class="card card-featured fade-in" id="ai-image-blocker-card">
  <div class="card-header">
    <h2 class="card-title">🖼 AI Image Blocker <span class="badge-new">New</span></h2>
    <p class="card-description">
      Uses an on-device AI model (NSFW.js / MobileNet v2) to detect adult
      images directly in the browser. Nothing is sent to a server.
    </p>
  </div>
  <div class="switch-container">
    <div class="switch-label">
      <span class="label">Enable AI Image Blocker</span>
      <span class="description">
        On any visible image, applies a heavy blur if the model flags it as
        adult content. Adds ~5 MB to the extension download.
      </span>
    </div>
    <label class="switch">
      <input type="checkbox" id="ai-image-blocker" />
      <span class="slider"></span>
    </label>
  </div>
  <div style="margin-top: 1rem; display: flex; gap: .75rem; flex-wrap: wrap; align-items: center;">
    <span class="status-badge" id="ai-image-blocker-status">🖼 AI Blocker: Active</span>
  </div>
  <div class="info-box" style="margin-top: .875rem">
    <div class="info-box-title">How it works</div>
    <p class="info-box-text">
      The model is bundled with the extension and runs in a dedicated
      Web Worker so it never blocks the page. First scan after install
      loads the model (~2 s one-time cost). Trusted image domains
      (Steam, YouTube, Reddit, Imgur, etc.) are skipped.
    </p>
  </div>
</div>
```

- [ ] **Step 3: Add the render + change-handler in `options.js`**

Find the `render()` function and the existing checkbox event-handler pattern. Add a block that mirrors the existing toggle wiring. Locate the function that wires a `.switch input[type=checkbox]` change and add this branch (or a new event listener registered after the others):

```js
const aiToggle = document.getElementById('ai-image-blocker');
if (aiToggle) {
  const apply = () => {
    aiToggle.checked = !!(mergedSettings.aiImageBlocker);
    const status = document.getElementById('ai-image-blocker-status');
    if (status) {
      status.textContent = mergedSettings.aiImageBlocker
        ? '🖼 AI Blocker: Active'
        : '🖼 AI Blocker: Off';
    }
  };
  apply();
  aiToggle.addEventListener('change', async () => {
    const newVal = aiToggle.checked;
    if (newVal === false) {
      const ok = await (typeof requirePINIfSet === 'function'
        ? requirePINIfSet('turn off AI image blocker')
        : Promise.resolve(true));
      if (!ok) { aiToggle.checked = true; return; }
    }
    mergedSettings.aiImageBlocker = newVal;
    await persistSettings(mergedSettings);
    apply();
  });
}
```

(Adjust the `persistSettings` / `mergedSettings` / `requirePINIfSet` names to match the actual existing code in `options.js`.)

- [ ] **Step 4: Verify both files parse**

```bash
node --check options.js
```

Expected: exit 0. (For `options.html`, eyeball-verify the new card sits inside the existing options container — no parser available, but the indentation should match the surrounding cards.)

- [ ] **Step 5: Commit**

```bash
git add options.html options.js
git commit -m "feat(ai-blocker): add Options page card and toggle handler"
```

---

## Task 9: Stats page — new counter tile

**Files:**
- Modify: `stats.html` (add a new tile next to the existing "Image Blocked" counter)
- Modify: `stats.js` (read the new field)

- [ ] **Step 1: Find the existing Image-Blocked tile in `stats.html`**

```bash
grep -n "imageBlockedCount\|imageBlocked\|Image Blocked" stats.html
```

- [ ] **Step 2: Add the new tile next to the existing one**

Mirror the structure of the existing `imageBlockedCount` tile. Example:

```html
<div class="stat-tile" id="ai-image-blocked-tile">
  <div class="stat-tile-icon">🖼</div>
  <div class="stat-tile-value" id="ai-image-blocked-value">0</div>
  <div class="stat-tile-label">AI Image Blocked</div>
</div>
```

(Adjust the class names to match the existing tile convention in `stats.html`.)

- [ ] **Step 3: Wire the value read in `stats.js`**

Find the function in `stats.js` that sets each tile's `textContent` from the loaded stats object, and add:

```js
const aiTile = document.getElementById('ai-image-blocked-value');
if (aiTile) aiTile.textContent = String(stats.aiImageBlockedCount || 0);
```

(Adjust the variable name / lookup path to match how the existing tiles fetch their values.)

- [ ] **Step 4: Verify `stats.js` parses**

```bash
node --check stats.js
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add stats.html stats.js
git commit -m "feat(ai-blocker): add aiImageBlockedCount stat tile"
```

---

## Task 10: Smoke tests

**Files:**
- Modify: `tests/smoke.test.js` (append new smoke checks)

These tests run in `node --test` and exercise the parts of the new code that don't need a real browser. The Web Worker and DOM are not testable here; those are covered by the manual QA in Task 12.

- [ ] **Step 1: Add new assertions to `tests/smoke.test.js`**

Append the following to the existing file (it already imports `loadBackgroundContext` and `assert`):

```js
const fs = require('fs');
const path = require('path');

test('ai-image-blocker-core.js loads and exposes pure helpers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'ai-image-blocker-core.js'), 'utf8'
  );
  const vm = require('vm');
  const sandbox = { Map, Set, Date, Math, JSON, RegExp, Promise, URL, Error, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'ai-image-blocker-core.js' });
  for (const name of ['verdictFor', 'firstPartyMatch', 'shouldSkipImage', 'setWithCap']) {
    assert.equal(typeof sandbox[name], 'function', `${name} should be a function`);
  }
});

test('ai-image-blocker.js parses (syntax check)', () => {
  // We can't load it (it references `chrome`, `Worker`, `createImageBitmap`),
  // but `node --check` is the cheap equivalent — wrap in a child_process to
  // avoid crashing the test runner.
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'ai-image-blocker.js')], { stdio: 'pipe' });
});

test('classify.worker.js parses (syntax check)', () => {
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'classify.worker.js')], { stdio: 'pipe' });
});

test('manifest.json lists all 12 new web_accessible_resources', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const war = manifest.web_accessible_resources[0].resources;
  for (const required of [
    'classify.worker.js',
    'vendor/tfjs/tf.min.js',
    'vendor/nsfwjs/nsfwjs.min.js',
    'nsfwjs/model.json',
    'nsfwjs/group1-shard1of9.bin',
    'nsfwjs/group1-shard2of9.bin',
    'nsfwjs/group1-shard3of9.bin',
    'nsfwjs/group1-shard4of9.bin',
    'nsfwjs/group1-shard5of9.bin',
    'nsfwjs/group1-shard6of9.bin',
    'nsfwjs/group1-shard7of9.bin',
    'nsfwjs/group1-shard8of9.bin',
    'nsfwjs/group1-shard9of9.bin',
  ]) {
    assert.ok(war.includes(required), `manifest must list ${required}`);
  }
});

test('manifest.json content_scripts loads ai-image-blocker-core.js before ai-image-blocker.js', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  const coreIdx = js.indexOf('ai-image-blocker-core.js');
  const ctlIdx = js.indexOf('ai-image-blocker.js');
  assert.ok(coreIdx >= 0, 'manifest must list ai-image-blocker-core.js');
  assert.ok(ctlIdx >= 0, 'manifest must list ai-image-blocker.js');
  assert.ok(coreIdx < ctlIdx, 'ai-image-blocker-core.js must load before ai-image-blocker.js');
});
```

- [ ] **Step 2: Run the full test suite**

```bash
node --test tests/*.test.js
```

Expected: all previous tests still pass, and the 5 new smoke tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.test.js
git commit -m "test(ai-blocker): add smoke tests for core, worker, and manifest"
```

---

## Task 11: Versioning & changelog

**Files:**
- Modify: `manifest.json` (`version: "1.6.1"` → `"1.7.0"`)
- Modify: `manifest.firefox.json` (same, if it exists)
- Modify: `package.json` (`"version": "1.6.1"` → `"1.7.0"`)
- Modify: `CHANGELOG.md` (new entry under "Added")
- Modify: `VERSION_NOTES.md` (new section, if file exists)

- [ ] **Step 1: Bump the version in `manifest.json`**

```bash
node -e "const fs=require('fs'); const p='manifest.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version='1.7.0'; fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');"
```

- [ ] **Step 2: Bump the version in `manifest.firefox.json` (if present)**

```bash
if [ -f manifest.firefox.json ]; then
  node -e "const fs=require('fs'); const p='manifest.firefox.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version='1.7.0'; fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');"
fi
```

- [ ] **Step 3: Bump the version in `package.json`**

Edit the `"version"` field from `"1.6.1"` to `"1.7.0"`.

- [ ] **Step 4: Add a `CHANGELOG.md` entry under "Added"**

At the top of [CHANGELOG.md](file:///d:/Project/Extension/Pblocker/BlockNSFW/CHANGELOG.md), insert:

```markdown
## 1.7.0

### Added
- **AI Image Blocker** — new optional layer that runs NSFW.js (MobileNet v2)
  in a dedicated Web Worker to classify every visible `<img>` on every page.
  Flagged images are blurred in place with `filter: blur(50px)`. The model
  is bundled with the extension (~5 MB), runs entirely on-device, and
  never sends image data over the network. Toggle in Options →
  "AI Image Blocker" (default ON).
```

- [ ] **Step 5: Add a `VERSION_NOTES.md` section (if the file exists)**

```markdown
## AI Image Blocker (1.7.0)

This release adds an on-device AI image classifier (NSFW.js / MobileNet v2)
that detects adult images in any visible `<img>` element and applies a heavy
blur when the model flags the content.

**Privacy:** No image data ever leaves the device. The model is bundled
inside the extension and runs in a dedicated Web Worker. No network
requests are made for classification.

**Performance:** The model is loaded once on first use (~2 s one-time cost)
and runs in a Web Worker so the page never blocks. A session-scoped LRU
cache prevents re-classifying the same image, and a 4-concurrent throttle
keeps image-heavy pages snappy.

**Package size:** Adds ~5 MB to the extension download (the bundled model
is the bulk of it). Users can disable the feature from Options to remove
the model from memory; it remains in the package until the next install.
```

- [ ] **Step 6: Verify all three version strings are in sync**

```bash
grep '"version"' manifest.json package.json
```

Expected:
```
manifest.json:  "version": "1.7.0",
package.json:   "version": "1.7.0",
```

- [ ] **Step 7: Commit**

```bash
git add manifest.json manifest.firefox.json package.json CHANGELOG.md VERSION_NOTES.md
git commit -m "chore(release): bump to 1.7.0 for AI image blocker"
```

---

## Task 12: Manual QA + final verification

**Files:** none — this is a verification + cleanup task.

- [ ] **Step 1: Run the full test suite one more time**

```bash
node --test tests/*.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Walk through the manual QA checklist from the spec**

Open the unpacked extension in Chrome (`chrome://extensions` → Developer mode → "Load unpacked" → select the repo root). Then:

1. **Cold install.** Confirm the model loads (DevTools → Application → Service Workers / Web Workers → `classify.worker.js` is listed and reports `model_ready` in its console).
2. **Status badge.** Open the Options page; the "🖼 AI Blocker: Active" badge is visible.
3. **Functional check.** Visit a known image-heavy site (e.g. `reddit.com/r/pics`). Scroll — no false positives on the top 20 hot posts.
4. **NSFW check.** Visit a known NSFW image host. Flagged images get blur within ~1 s of viewport entry. DevTools shows `.pblocker-ai-blocked` class on the blurred elements.
5. **Stats.** Open the stats page; `aiImageBlockedCount > 0` after step 4.
6. **Toggle off.** In Options, turn off the AI Image Blocker. Reload any image-heavy page — no blur applied, no worker activity in DevTools.
7. **Toggle on again.** Turn it back on. Reload — the first scan triggers the model load.
8. **Cross-browser.** Repeat steps 1–7 in Firefox (`about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.firefox.json`).
9. **Degradation.** In DevTools, set the AI toggle to off in `chrome.storage.local`, reload, then in DevTools simulate a model load failure by editing the `nsfwjs/model.json` file in the unpacked extension directory to be empty. Reload — the toast "AI Image Blocker unavailable — model failed to load." appears, no images are blurred, no console errors.
10. **Quota failure.** Hard to simulate in a fresh install (the LRU is well under quota). Skip this in QA; covered by the unit tests' `setWithCap` eviction logic.

- [ ] **Step 3: Inspect the final git log**

```bash
git log --oneline -15
```

Expected: roughly 12 commits, one per task, all on the same branch. No commit should include the model weight binaries in its diff unless they are part of the vendoring commit (Task 1) — the rest of the tasks should only touch source files.

- [ ] **Step 4: Verify no stray TODO / FIXME / placeholder in the new files**

```bash
grep -nE "TODO|FIXME|XXX|placeholder" ai-image-blocker-core.js ai-image-blocker.js classify.worker.js
```

Expected: no matches.

- [ ] **Step 5: Final commit (if any small fixes were needed during QA)**

```bash
git add -p
git commit -m "chore(ai-blocker): post-QA polish"
```

If nothing was changed, this step is a no-op.

---

## Out-of-scope reminders

The following are explicitly **not** in this plan and should NOT be added during implementation:

- Per-domain threshold overrides
- "Show original" / click-to-reveal
- "Report false positive" UI
- Background-image classification
- `<video>` frame classification
- Cross-origin `<iframe>` classification
- NudeNet or Transformers.js migration
- Adaptive thresholds
- User-tunable sensitivity slider

If any of these come up during execution, file a follow-up issue and continue with the current plan.
