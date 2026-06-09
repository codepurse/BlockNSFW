# AI Image Blocker (NSFW.js / MobileNet v2) — Design Spec

**Date:** 2026-06-09
**Status:** Draft — pending review
**Scope:** Add an on-device AI image classifier to BlockNSFW that detects adult images in any visible `<img>` element and applies a heavy blur when the model flags the content. No image data ever leaves the device.

---

## 1. Problem Statement

BlockNSFW currently blocks adult content at the **URL / hostname / keyword** layer only:

- A manually curated blocklist of ~hundreds of thousands of adult domains
- A `useSmartBlocking` keyword check on hostnames
- Cloudflare for Families DNS lookups for ambiguous domains
- A search-engine image-result filter that hides search thumbnails on Google / Bing / DDG / etc.

What is missing is the **in-page** layer: an adult site can still serve innocuous URLs (a Reddit post, a Pinterest pin, a generic CDN) that embed genuinely adult imagery. URL filtering cannot catch that. The existing `image_filtered` pipeline only targets image-search result pages.

**Goal:** Add a second, content-aware filter that classifies every visible `<img>` on every page using NSFW.js (MobileNet v2) running entirely in a Web Worker inside the extension, and blurs flagged images in place. Privacy is preserved end-to-end — no requests, no telemetry, no remote model fetch.

---

## 2. Constraints & Non-Goals

### Constraints

- **Fully on-device.** No network calls for classification. The model is bundled in the extension.
- **Cross-browser.** Must work on Chrome 88+ (current `minimum_chrome_version`) and Firefox 109+ (current `strict_min_version`).
- **Manifest V3 compatible.** Web Worker must be ES-module type, served from a `web_accessible_resources` entry.
- **No main-thread jank.** All inference happens off the main thread.
- **First-party content is trusted by default.** Same-origin images and the existing `DEFAULT_TRUSTED_IMAGE_DOMAINS` are skipped without classification.
- **No recovery from a blocked image.** The user cannot click to reveal. The blur is the final state.
- **Bounded memory.** Cache size is hard-capped; Worker auto-reloads on crash.
- **Stats parity.** New classification events feed the existing `imageBlockedCount` plus a new dedicated `aiImageBlockedCount` so the two layers are visible separately.

### Non-Goals (v1)

- Classifying `<video>` frames, `<canvas>` output, or CSS `background-image`
- Classifying images inside cross-origin `<iframe>` (CORS + same-origin policy makes this unworkable without a hosted proxy)
- Replacing the existing URL/keyword blocklist — the AI is a complementary layer
- Per-domain sensitivity overrides
- User-tunable threshold (the two thresholds in §4.3 are hardcoded for v1; can be exposed in Settings later)
- "Report false positive" UI
- "Show original" / click-to-reveal
- Server-side / hybrid ML fallbacks

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Web page (DOM)                               │
│  <img> elements, observed by an IntersectionObserver                 │
└─────────────────────┬────────────────────────────────────────────────┘
                      │ onImageVisible(img)
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Content script: ai-image-blocker.js                                 │
│  - apply 8 skip rules (trusted host, first-party, too small, …)      │
│  - LRU cache lookup (chrome.storage.session + in-memory mirror)      │
│  - throttle: max 4 concurrent classifications per page               │
│  - createImageBitmap(img)                                            │
│  - worker.postMessage({type:'classify', bitmap}, [bitmap])            │
│  - on reply: applyVerdict(img, 'block' | 'allow')                    │
│      → 'block':  add class .pblocker-ai-blocked                      │
│                  (CSS: filter: blur(50px); pointer-events: none)     │
│      → 'allow':  no-op                                              │
│  - notify background → image_ai_filtered (stats)                     │
└─────────────────────┬────────────────────────────────────────────────┘
                      │ postMessage (Transferable ImageBitmap)
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Web Worker: classify.worker.js (type: 'module')                      │
│  - import tfjs + nsfwjs (bundled)                                    │
│  - ensureModel() → nsfwjs.load(chrome.runtime.getURL('nsfwjs/'))      │
│  - model.classify(bitmap)                                            │
│  - postMessage({type:'classified', requestId, scores})               │
│  - on first model load → postMessage({type:'model_ready'})           │
└─────────────────────┬────────────────────────────────────────────────┘
                      │ WebGL / WASM
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Bundled NSFW.js model (MobileNet v2)                                │
│  nsfwjs/model.json + 9 weight shards                                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Design

### 4.1 [ai-image-blocker.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/ai-image-blocker.js) (content script, ~250 LOC)

**Responsibilities**
- Boot the Web Worker once per content-script lifetime
- Maintain the `inflight` Map (`requestId → {img, resolve}`)
- Maintain the in-memory LRU Map mirrored to `chrome.storage.session`
- Listen to the `IntersectionObserver` already set up in [content.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/content.js) (line 2410 area) and classify newly-visible images
- Apply / remove the `.pblocker-ai-blocked` class on each verdict
- Emit `image_ai_filtered` messages to the background

**Public API consumed by `content.js`**
- `AIImageBlocker.init(settings)` — boots worker, attaches to the existing observer
- `AIImageBlocker.onImageVisible(img)` — called by the existing observer callback

**State**
```js
const worker;                              // Module Worker handle
const inflight = new Map();                // requestId → pending
let nextRequestId = 1;
let modelReady = false;
let modelReadyPromise = null;
const lru = new Map();                     // src → {scores, verdict, ts}
let aiBlockerDegraded = false;             // set true on unrecoverable error
```

**Skip rules** (`shouldSkipImage(img) → boolean`)

| # | Rule | Rationale |
|---|---|---|
| 1 | `aiImageBlocker === false` (settings) | Master toggle |
| 2 | `aiBlockerDegraded === true` | After an unrecoverable error, stop sending work |
| 3 | Image hostname ∈ `DEFAULT_TRUSTED_IMAGE_DOMAINS` or user `trustedImageDomains` | Cheap, no false-positive class |
| 4 | Image hostname is first-party (same registrable domain as the page — see "First-party match" below) | Same-site images are typically UI chrome |
| 5 | `naturalWidth < 64` or `naturalHeight < 64` | Icons / avatars / spinners — never worth scanning |
| 6 | `src` is `data:` or `blob:` URL | Can't be cached cross-tab; classification not useful |
| 7 | `src` is in `lru` | Already classified this session |
| 8 | Image is hidden at observation time (`offsetParent === null`) | Below-the-fold, in collapsed accordion, etc. |

**First-party match** (used in rule 4)
- The page's hostname (`window.location.hostname`) and the image's hostname are compared using **simple suffix matching**, not the Public Suffix List
- A match means either:
  - `imageHost === pageHost`, OR
  - `imageHost.endsWith('.' + pageHost)`, OR
  - `pageHost.endsWith('.' + imageHost)`
- Examples:
  - Page `example.com`, image `cdn.example.com` → first-party → skip
  - Page `example.com`, image `evil-cdn.com` → not first-party → scan
  - Page `sub.example.com`, image `other.example.com` → not first-party → scan (subdomain mismatch)
- The simple suffix check is sufficient for v1 because legitimate same-org images almost always share at least one parent label; PSL accuracy is not required to avoid false positives at the first-party layer (other rules handle CDN miss-classification).

**Throttle + retry queue**
- `inflight.size >= 4` ⇒ enqueue the image into a `pendingQueue: HTMLImageElement[]` and return
- When a classification completes (in `onWorkerMessage`), `pendingQueue.shift()` and send the next request (if `inflight.size < 4`)
- The queue is unbounded in theory but capped in practice by the LRU cache (already-classified images re-enqueue once and then never again)
- Drained in FIFO order so the first-visible images are scanned first
- Drained on `model_ready` (replays everything queued before the model finished loading)

**Worker recreation** — on `worker.addEventListener('error', ...)`:
1. Drain `inflight` and call `bitmap.close?.()` on each
2. Re-spawn worker
3. Re-classify the first 4 images that triggered the crash (best-effort)

### 4.2 [classify.worker.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/classify.worker.js) (ES-module Web Worker, ~60 LOC)

**Imports** (relative paths to vendored copies):
```js
import * as tf from './vendor/tfjs/tf.min.js';
import * as nsfwjs from './vendor/nsfwjs/nsfwjs.min.js';
```

**Lifecycle**
- `let model = null` (module-scoped)
- `async function ensureModel()` — `if (model) return model; model = await nsfwjs.load(chrome.runtime.getURL('nsfwjs/')); self.postMessage({type:'model_ready'}); return model;`
- `self.addEventListener('message', ...)` — handles `{type:'classify', requestId, bitmap}`. Calls `model.classify(bitmap)`, posts `{type:'classified', requestId, scores}` or `{type:'classified', requestId, error}` on failure.

**Backend selection** — `tf.setBackend('webgl')` with a fallback to `'cpu'` if WebGL init fails. (TF.js auto-detects by default; we just wrap in try/catch.)

**Resource hygiene** — `bitmap.close?.()` is called immediately after `model.classify` returns, before the postMessage, so the GPU texture is released.

### 4.3 Score → Verdict Mapping

The model returns 5 classes: `Porn`, `Hentai`, `Sexy`, `Drawing`, `Neutral`. (NSFW.js documentation: see `infinitered/nsfwjs` README.)

```js
function verdictFor(scores) {
  const pornHentai = scores.Porn + scores.Hentai;
  if (pornHentai >= 0.50) return 'block';   // high-confidence adult
  if (scores.Sexy >= 0.70) return 'block';   // suggestive (higher bar to avoid false positives)
  return 'allow';
}
```

The two thresholds in the function above are the **only** classification tuning knobs in v1. They are deliberately distinct:
- The `Porn + Hentai >= 0.50` path catches explicit imagery (NSFW.js is highly confident on this class, so a low floor is safe).
- The `Sexy >= 0.70` path catches suggestive content, where NSFW.js is noisier, so a higher bar avoids over-blocking fashion / beach / fitness photography.

### 4.4 LRU cache (`chrome.storage.session` + in-memory mirror)

**Entry shape**
```ts
{ src: string, scores: {Porn, Hentai, Sexy, Drawing, Neutral}, verdict: 'block'|'allow', ts: number }
```

**Implementation**
- Source of truth for hot reads: in-memory `Map<string, Entry>`
- Source of truth for cross-tab persistence: `chrome.storage.session` under key `pblocker_ai_image_cache_v1`
- On boot: read the entire session store into the Map, then truncate to 2 000 entries (drop oldest by `ts`)
- On every classification: write to Map; schedule a debounced `storage.session.set` (5 s `requestIdleCallback` flush) so we don't write on every image
- TTL: 24 h per entry; stale entries are dropped on read
- Quota: `chrome.storage.session` allows 10 MB; entries are ~150 bytes each → safe up to ~65 000 entries. Wrap writes in try/catch; on quota error, log and fall back to in-memory only.

### 4.5 Background integration ([background.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/background.js))

**New stats field** in `DEFAULT_STATS` (line 82 area):
```js
aiImageBlockedCount: 0,
```

**New message handler** (extending the existing `onMessage` listener at line 1370):
```js
} else if (message.type === 'image_ai_filtered') {
  updateStats('image_ai_filtered');                    // new switch case in updateStats
  try {
    const url = typeof message.url === 'string' ? message.url : (typeof sender?.url === 'string' ? sender.url : '');
    if (url) logBlockedPage(url, 'AI image filtered');
  } catch (_) {}
  sendResponse({ success: true });
}
```

**New `updateStats` case** (alongside the existing `'image_filtered'` branch):
```js
case 'image_ai_filtered':
  newStats.aiImageBlockedCount++;
  newDailyStats.imageAiBlocked = (newDailyStats.imageAiBlocked || 0) + 1;
  break;
```

### 4.6 Content-script integration

The existing `IntersectionObserver` in [content.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/content.js) (around line 2410, inside `observeImage(img)`) gets a single new line:

```js
function observeImage(img) {
  imageObserver.observe(img);
  // existing onImageVisible logic ...
+ if (settings.aiImageBlocker) AIImageBlocker.onImageVisible(img);
}
```

`content.js` itself does not need to be substantially restructured — `ai-image-blocker.js` is a self-contained controller that piggybacks on the existing observer.

### 4.7 Settings UI ([options.html](file:///d:/Project/Extension/Pblocker/BlockNSFW/options.html))

A new card appended after the existing "Image Filtering Level" card:

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

**Settings wiring** in [options.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/options.js):
- Add `aiImageBlocker: true` to `DEFAULT_SETTINGS` (lines 9–24)
- In `render()`: read the toggle state and reflect it
- New change handler that reuses `requirePINIfSet('turn off AI image blocker')` when toggling **off** (matches the existing Facebook Reels pattern at line 1324)

### 4.8 Stats page ([stats.html](file:///d:/Project/Extension/Pblocker/BlockNSFW/stats.html) / [stats.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/stats.js))

Add a new counter `aiImageBlockedCount` alongside the existing `imageBlockedCount`, displayed in the same dark-themed card grid. The card mirrors the "Image Blocked" tile styling.

### 4.9 Blur stylesheet

A single class injected once by the content script (idempotent):

```css
.pblocker-ai-blocked {
  filter: blur(50px) !important;
  pointer-events: none !important;
  user-select: none !important;
  -webkit-user-drag: none !important;
}
```

Injected via a `<style>` element with id `pblocker-ai-blocker-styles` in the page's head.

---

## 5. Message Protocol

| Direction | Type | Payload | When |
|---|---|---|---|
| content → background | `image_ai_filtered` | `{ url: string, scores: object }` | When a `block` verdict is applied |
| worker → content | `model_ready` | `{}` | First time the model finishes loading in the worker |
| worker → content | `model_error` | `{ error: string }` | Model load failed (recoverable on next page load) |
| worker → content | `classified` | `{ requestId, scores: {Porn, Hentai, Sexy, Drawing, Neutral} }` | Successful classification |
| worker → content | `classified` | `{ requestId, error: string }` | Per-image classification failure |
| content → worker | `classify` | `{ requestId, src, bitmap }` (bitmap is Transferable) | When the content script wants a classification |

`requestId` is a monotonic counter generated by the content script; the worker is stateless and only echoes it back. Multiple in-flight requests are supported.

---

## 6. File Layout

| File | Status | Purpose |
|---|---|---|
| `manifest.json` | edit | +1 content_script entry, +11 web_accessible_resources |
| `manifest.firefox.json` | edit | Mirror the same changes for the Firefox build |
| `background.js` | edit | +1 message handler, +1 `DEFAULT_STATS` field, +1 `updateStats` switch case |
| `content.js` | edit | +1 line in `observeImage()` to call `AIImageBlocker.onImageVisible` |
| `options.html` | edit | +1 new card |
| `options.js` | edit | +1 `DEFAULT_SETTINGS` field, +1 change handler, +1 render block |
| `stats.html` | edit | +1 counter tile |
| `stats.js` | edit | +1 stats read |
| `ai-image-blocker.js` | **new** | Content-script controller (~250 LOC) |
| `classify.worker.js` | **new** | ES-module Web Worker (~60 LOC) |
| `vendor/tfjs/tf.min.js` | **new** | Vendored `@tensorflow/tfjs` minified build |
| `vendor/nsfwjs/nsfwjs.min.js` | **new** | Vendored `nsfwjs` package |
| `nsfwjs/model.json` | **new** | MobileNet v2 model topology |
| `nsfwjs/group1-shard{1..9}of9.bin` | **new** | Model weight shards |
| `tests/ai-image-blocker.test.js` | **new** | Unit tests for `shouldSkipImage`, verdict mapping, LRU eviction |
| `tests/smoke.test.js` | edit | +3 smoke checks (settings default, model URL 200, worker construct) |

Total package size delta: ≈ 5.3 MB (tfjs 1.1 MB + nsfwjs 0.3 MB + model 3.9 MB), of which 3.9 MB is the model. Acceptable for a v1.7.0 release.

---

## 7. Error Handling & Degradation

| Failure | User-visible behavior | Internal handling |
|---|---|---|
| Model files fail to load (corrupt cache, MV3 race) | Images render normally. One-time toast (once per content-script lifetime, gated by `degradeToastShown`): "AI Image Blocker unavailable — model failed to load." (6 s) | `aiBlockerDegraded = true`. All images pass through. Retried on next page load. |
| `createImageBitmap(img)` throws (e.g. tainted canvas) | That one image is skipped; no UI change | `console.debug` log, no retry |
| `transferControlToOffscreen` not supported (theoretical; pre-2022 Firefox) | Same as above | Feature-detect at boot; set `aiBlockerDegraded = true` |
| Worker crashes | First new image triggers re-spawn + model re-load (~2 s one-time) | `worker.error` listener drains `inflight` and re-creates worker |
| Page is `chrome-extension://`, `about:`, or DevTools | AI blocker is a no-op | Cheap host check in `shouldSkipImage` |
| `chrome.storage.session` quota exceeded | Cache silently falls back to in-memory `Map` only | Wrap `set` in try/catch, keep working |
| User toggles off mid-scan | Inflight requests are abandoned | Walk `inflight`, call `bitmap.close?.()` on each |
| Browser version predates ES-module workers | Worker fails to construct → degrade as above | `try { new Worker(url, {type:'module'}) } catch { aiBlockerDegraded = true }` at boot |

The feature is **never load-bearing**: every failure mode degrades to the previous (URL-only) blocking behavior with no loss of existing functionality.

---

## 8. Testing Strategy

### Unit tests ([tests/ai-image-blocker.test.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/tests/ai-image-blocker.test.js))

Pure-JS, no DOM. Run with the existing Jest setup (`tests/setup.js`).

- `shouldSkipImage()` — covers all 8 skip rules with synthetic `HTMLImageElement` stubs
- `verdictFor(scores)` — 15+ synthetic score vectors including edge cases (exactly at threshold, all-zero, only-Neutral, all-Drawing)
- LRU eviction order with a 3-entry cap
- Settings-default test: after `mergeDefaults`, `aiImageBlocker === true`

### Smoke tests (extend [tests/smoke.test.js](file:///d:/Project/Extension/Pblocker/BlockNSFW/tests/smoke.test.js))

- After extension install, `chrome.storage.local.get('pblocker_settings').aiImageBlocker === true`
- `chrome.runtime.getURL('nsfwjs/model.json')` returns a 200
- `new Worker(chrome.runtime.getURL('classify.worker.js'), { type: 'module' })` constructs without throwing in both Chrome and Firefox CI lanes

### Manual QA checklist

1. Cold install on Chrome stable + Firefox stable — verify model loads, status badge updates
2. Visit a known NSFW image host — flagged images get blur within ~1 s of viewport entry
3. Visit a known safe host (e.g. `reddit.com/r/pics`) — no false positives on top 20 hot posts
4. Disable the toggle in Options — images render unblurred immediately on next reload
5. Re-enable — first scan triggers the ~2 s model load
6. Open 5 tabs to image-heavy sites simultaneously — verify the 4-concurrent throttle (DevTools → Memory)
7. Confirm `stats.html` shows `aiImageBlockedCount > 0` after step 2
8. Test on a slow 4G connection — model still loads from `chrome-extension://` (not network)
9. Set `aiImageBlocker = false` in DevTools, reload — verify `[class*="ai-blocked"]` count stays at 0
10. Inject a deliberately-broken `model.json` (empty file) via dev tools — verify degradation toast + non-blocking behavior

### Performance budget

Measured on a mid-range laptop (M1 Air / equivalent), Chrome 120 stable:

| Metric | Budget |
|---|---|
| Cold model load (worker boot → `model_ready` postMessage) | ≤ 3 000 ms |
| Warm cache hit | ≤ 1 ms per image |
| Single classification (WebGL backend) | ≤ 200 ms |
| Single classification (CPU fallback) | ≤ 600 ms |
| Additional resident memory while Worker is alive | ≤ 80 MB |
| `image_ai_filtered` message round-trip | ≤ 5 ms |
| Page load time impact (Worker constructed but no images classified yet) | ≤ 50 ms (one-time per page) |

The throttle (4 concurrent) plus LRU cache keep typical page interactions smooth even on heavy image pages.

---

## 9. Rollout & Versioning

- First ships in **v1.7.0** (next minor bump; feature is new, not a patch)
- `CHANGELOG.md` entry under the "Added" section
- `VERSION_NOTES.md` — new section summarizing the feature, with a link to the privacy policy section confirming on-device processing
- `manifest.json` `version` → `1.7.0`, same for Firefox
- `package.json` `version` if present (check during implementation)
- No migration of user data needed — `aiImageBlocker` defaults to `true` for all users; users who want to opt out can flip the toggle

---

## 10. Out-of-Scope Future Work (documented, not implemented)

- Adaptive per-domain thresholds (e.g. lower threshold on Twitter, higher on news sites)
- User-trainable feedback loop
- Background-image classification
- Per-image classification confidence display
- Replacing NSFW.js with NudeNet or Transformers.js as those mature
- "Soft" mode that blurs only when the model is highly confident

These are intentionally deferred to keep v1 small, focused, and shippable in a single iteration.
