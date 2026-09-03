// AI Image Blocker — content script (SW-delegated).
// The model lives in the service worker so TF.js (which uses Function() /
// eval during compilation) is not subject to the host page's CSP. Content
// script sends image URLs to the SW; the SW fetches, classifies, and returns
// scores. verdictFor() lives in ai-image-blocker-core.js
// (plain JS, no eval) which is loaded before this script in the manifest.

(function () {
  'use strict';

  const MAX_INFLIGHT = 4;
  const MAX_CACHE_ENTRIES = 2000;
  // v2 adds a per-entry model tag. v1 entries carry raw scores with no record
  // of which model produced them, and the two models' scores are not
  // comparable, so v1 is abandoned rather than migrated.
  const CACHE_KEY = 'pblocker_ai_image_cache_v2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const STYLE_ID = 'pblocker-ai-blocker-styles';
  const MODEL_PING_TIMEOUT_MS = 60000;
  const CLASSIFY_TIMEOUT_MS = 60000;
  const MODEL_RETRY_DELAY_MS = 5000;

  const PENDING_CLASS = 'pblocker-ai-pending';

  const state = {
    modelReady: false,
    modelFailed: false,
    modelPingInFlight: false,
    modelRetryTimer: null,
    inflight: new Map(),
    pendingQueue: [],
    queuedImages: new WeakSet(),
    lru: new Map(),
    settings: null
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent =
      // The flagged <img> is kept in place but heavily blurred so the adult
      // content is unreadable while the page layout stays intact. `clip-path`
      // contains the blur halo to the element box so it can't bleed over
      // neighbouring content, and pointer events are disabled so the blurred
      // image can't be clicked through to its source.
      '.pblocker-ai-blocked {' +
        'filter: blur(28px) !important;' +
        'clip-path: inset(0) !important;' +
        'pointer-events: none !important;' +
        'user-select: none !important;' +
      '}' +
      // While a candidate image is being classified it is hidden up-front so
      // adult content never paints. `visibility: hidden` keeps its layout box
      // (no page jump); a clear verdict reveals it, a block leaves it in place
      // but blurred. This is the "block-first, reveal-on-safe" strategy.
      '.' + PENDING_CLASS + ' {' +
        'visibility: hidden !important;' +
      '}';
    (document.head || document.documentElement).appendChild(el);
  }

  // Hide a candidate the moment it is queued for classification so adult
  // content never paints. Skipped if it is already blocked (and blurred).
  function markPending(img) {
    if (!img || !img.classList) return;
    if (img.classList.contains('pblocker-ai-blocked')) return;
    img.classList.add(PENDING_CLASS);
  }

  function clearPending(img) {
    if (!img || !img.classList) return;
    img.classList.remove(PENDING_CLASS);
  }

  // Reveal everything still awaiting a verdict. Used when the model is
  // unavailable so the page is never left permanently broken.
  function revealAllPending() {
    try {
      document.querySelectorAll('.' + PENDING_CLASS).forEach((img) => {
        img.classList.remove(PENDING_CLASS);
      });
    } catch (_) {}
  }

  function flushCacheToStorage() {
    try {
      const obj = {};
      for (const [k, v] of state.lru) obj[k] = v;
      chrome.storage.session.set({ [CACHE_KEY]: obj }).catch(() => {});
    } catch (_) {}
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
    } catch (_) {}
  }

  function setWithCap(key, value) {
    if (state.lru.has(key)) {
      state.lru.set(key, value);
      return;
    }
    if (state.lru.size >= MAX_CACHE_ENTRIES) {
      const oldest = state.lru.keys().next().value;
      state.lru.delete(oldest);
    }
    state.lru.set(key, value);
  }

  async function waitForImageLoad(img) {
    if (img.complete && img.naturalWidth > 0) return true;
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        clearTimeout(timer);
      };
      const onLoad = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      }, 8000);
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  // `expectedSrc` is the URL this verdict was computed for. Virtualised feeds
  // (X/Twitter, Instagram, Reddit) recycle the same <img> node for a different
  // post while a classification is still in flight, and lazy-loaders swap in a
  // higher-res candidate mid-flight, so by the time a verdict lands the node
  // may be showing a different picture. Applying it blind is how an explicit
  // image ends up unblurred on X: the previous occupant's stale `allow` verdict
  // arrives and strips the blur off the image that replaced it. When the node
  // has moved on, drop the verdict — the URL it now holds has its own
  // classification pending.
  function applyVerdict(img, verdict, scores, expectedSrc) {
    if (!img || !img.classList) return;
    if (expectedSrc && (img.currentSrc || img.src) !== expectedSrc) return;
    const alreadyBlocked = img.classList.contains('pblocker-ai-blocked');
    if (verdict === 'block') {
      if (!alreadyBlocked) {
        // Swap the pending hide for the blocked state: the <img> stays in
        // place (layout box already intact under `visibility: hidden`) and the
        // blocked class blurs it heavily.
        clearPending(img);
        img.classList.add('pblocker-ai-blocked');
        // Page-level counter read by content.js's AI text blocker as a fusion
        // signal (moderate text score + >=1 blocked image -> block the page).
        try {
          globalThis.__pblockerAIImageBlockCount =
            (globalThis.__pblockerAIImageBlockCount | 0) + 1;
        } catch (_) {}
        try {
          chrome.runtime.sendMessage({
            type: 'image_ai_filtered',
            url: window.location.href,
            src: img.currentSrc || img.src,
            scores
          });
        } catch (_) {}
      }
      return;
    }
    // Cleared as safe: reveal it and remove any prior blur.
    clearPending(img);
    if (alreadyBlocked) {
      img.classList.remove('pblocker-ai-blocked');
    }
  }

  function drainQueue() {
    while (state.pendingQueue.length > 0 && state.inflight.size < MAX_INFLIGHT) {
      const next = state.pendingQueue.shift();
      state.queuedImages.delete(next);
      classifyImage(next);
    }
  }

  function isAiActive() {
    return !!(state.settings &&
      state.settings.enabled !== false &&
      state.settings.aiImageBlocker !== false);
  }

  function activeModelId() {
    const requested = state.settings && state.settings.aiImageModel;
    if (typeof AiImageModels !== 'undefined') {
      return AiImageModels.normalizeModelId(requested);
    }
    return requested || 'nsfwjs';
  }

  // A cache entry is usable only if it is fresh AND was produced by the model
  // that is active now. Without the model check, switching models would keep
  // serving the old model's scores for up to 24h — and because verdicts are
  // re-derived from raw scores against the *current* thresholds, a 0.8 from
  // MobileNet's Sexy class would be read against the ViT's single NSFW bar.
  // That silently blocks or unblocks the wrong images, with no error anywhere.
  function usableCacheEntry(src) {
    const cached = state.lru.get(src);
    if (!cached) return null;
    if ((Date.now() - cached.ts) >= CACHE_TTL_MS) return null;
    if (typeof AiImageModels !== 'undefined') {
      if (!AiImageModels.scoresMatchModel(cached.scores, activeModelId())) return null;
    } else if (cached.m && cached.m !== activeModelId()) {
      return null;
    }
    return cached;
  }

  function clearAIBlockedImages() {
    try {
      document.querySelectorAll('.pblocker-ai-blocked').forEach((img) => {
        img.classList.remove('pblocker-ai-blocked');
      });
      // Reveal anything that was hidden awaiting a verdict.
      revealAllPending();
    } catch (_) {}
  }

  function clearModelRetryTimer() {
    if (!state.modelRetryTimer) return;
    clearTimeout(state.modelRetryTimer);
    state.modelRetryTimer = null;
  }

  function scheduleModelRetry(delayMs) {
    if (!isAiActive() ||
        state.modelReady ||
        state.modelPingInFlight ||
        state.modelRetryTimer) {
      return;
    }
    const parsedDelay = Number(delayMs);
    const waitMs = Number.isFinite(parsedDelay)
      ? Math.max(0, parsedDelay)
      : MODEL_RETRY_DELAY_MS;
    state.modelRetryTimer = setTimeout(() => {
      state.modelRetryTimer = null;
      pingModel(true);
    }, waitMs);
  }

  function enqueueImage(img) {
    if (!img || state.queuedImages.has(img)) return;
    state.queuedImages.add(img);
    state.pendingQueue.push(img);
  }

  function sendRuntimeMessage(message, timeoutMs, timeoutLabel) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutLabel));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || String(runtimeError)));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function sendClassifyToSW(src) {
    // Send just URL; service worker fetches + classifies with extension
    // permissions so page CSP and hotlink restrictions do not block us.
    const res = await sendRuntimeMessage(
      { type: 'ai_classify_image', src, model: activeModelId() },
      CLASSIFY_TIMEOUT_MS,
      'classify timeout'
    );
    if (!res || !res.success) {
      throw new Error(res && res.error ? res.error : 'classify failed');
    }
    // `res.model` is the model that ACTUALLY produced these scores, which is
    // not always the one we asked for: the service worker falls back to the
    // bundled model rather than leave a page unfiltered. The cache is tagged
    // with what ran, so a later switch back to the selected model correctly
    // treats these entries as belonging to something else.
    return { scores: res.scores, model: res.model || activeModelId() };
  }

  // Recompute the verdict from cached *scores* using the CURRENT thresholds, so
  // changing strictness (or the default thresholds) takes effect immediately for
  // already-classified images instead of being frozen by the 24h cache.
  function verdictFromCache(cached) {
    if (cached && cached.scores) {
      return verdictFor(cached.scores, (state.settings && state.settings.aiThresholds) || null);
    }
    return cached ? cached.verdict : 'allow';
  }

  function getOrStartClassification(src) {
    if (state.inflight.has(src)) return state.inflight.get(src);
    const promise = (async () => {
      try {
        return await sendClassifyToSW(src);
      } finally {
        state.inflight.delete(src);
        drainQueue();
      }
    })();
    state.inflight.set(src, promise);
    return promise;
  }

  async function classifyImage(img) {
    if (!img) {
      drainQueue();
      return;
    }
    if (!isAiActive()) {
      state.pendingQueue.length = 0;
      state.queuedImages = new WeakSet();
      revealAllPending();
      return;
    }

    const src = img.currentSrc || img.src;
    if (!src) {
      drainQueue();
      return;
    }

    // Hide up-front so the image never paints while we wait for a verdict.
    // applyVerdict() (cached or fresh) and the catch below all clear it.
    markPending(img);

    if (!state.modelReady) {
      enqueueImage(img);
      if (!state.modelPingInFlight) scheduleModelRetry();
      return;
    }

    const cached = usableCacheEntry(src);
    if (cached) {
      applyVerdict(img, verdictFromCache(cached), cached.scores, src);
      drainQueue();
      return;
    }
    if (!state.inflight.has(src) && state.inflight.size >= MAX_INFLIGHT) {
      enqueueImage(img);
      return;
    }

    try {
      const result = await getOrStartClassification(src);
      const scores = result && result.scores;
      const servedBy = (result && result.model) || activeModelId();
      const thresholds = (state.settings && state.settings.aiThresholds) || null;
      const verdict = verdictFor(scores, thresholds);
      // Cache the scores even if this node moved on — the next image to use
      // this URL gets an instant verdict instead of a fresh round-trip.
      setWithCap(src, { scores, verdict, ts: Date.now(), m: servedBy });
      flushCacheToStorage();
      if (!isAiActive()) {
        clearPending(img);
        if (img.classList) img.classList.remove('pblocker-ai-blocked');
        return;
      }
      applyVerdict(img, verdict, scores, src);
    } catch (_) {
      // Classification failed (CORS, network, SW error) - reveal the image
      // rather than leaving it hidden forever.
      clearPending(img);
    }
  }

  // Called by content.js when an <img> starts pointing at a different picture
  // (lazy-load upgrade, srcset re-resolution, or an SPA recycling the node for
  // another post). The previous verdict no longer describes what is on screen.
  // Crucially this does NOT just unblur: dropping the blur while the fresh
  // verdict is a network round-trip away is what left explicit images visible
  // on X's virtualised timeline. Hide the node instead and let the new verdict
  // decide. Every classification path clears the pending state, and
  // onImageVisible below clears it on each of its skip paths, so an image can
  // never be stranded hidden.
  function onImageSrcChanged(img) {
    if (!img || !img.classList) return;
    img.classList.remove('pblocker-ai-blocked');
    if (!isAiActive()) {
      clearPending(img);
      return;
    }
    img.classList.add(PENDING_CLASS);
  }

  function onImageVisible(img) {
    // Any path that declines to classify must reveal the image, otherwise a
    // node hidden by onImageSrcChanged/markPending stays blank forever.
    const skip = () => { clearPending(img); };

    if (!isAiActive()) return skip();

    const src = img.currentSrc || img.src;
    if (!src) return skip();
    const minDimension = typeof MIN_NATURAL_DIMENSION === 'number'
      ? MIN_NATURAL_DIMENSION
      : 64;
    if (img.naturalWidth > 0 && img.naturalWidth < minDimension) return skip();
    if (img.naturalHeight > 0 && img.naturalHeight < minDimension) return skip();

    const hostname = (() => {
      try { return new URL(src).hostname.toLowerCase(); } catch (_) { return ''; }
    })();

    if (src.startsWith('data:') || src.startsWith('blob:')) return skip();

    // By default the AI filter scans images from ALL origins — including the
    // site you are on — so adult sites (which serve their own images) are
    // covered, not just third-party images embedded elsewhere. Set
    // aiImageScanAllSites:false to restore the lighter "third-party only" mode.
    const scanAllSites = !state.settings || state.settings.aiImageScanAllSites !== false;
    const pageHost = (window.location && window.location.hostname || '').toLowerCase();
    if (!scanAllSites && hostname && pageHost) {
      if (hostname === pageHost) return skip();
      if (hostname.endsWith('.' + pageHost)) return skip();
      if (pageHost.endsWith('.' + hostname)) return skip();
    }

    const trustedDomains = (state.settings && state.settings.trustedImageDomains) || [];
    if (trustedDomains.length > 0 && hostname) {
      for (const d of trustedDomains) {
        const td = String(d).toLowerCase();
        if (hostname === td || hostname.endsWith('.' + td)) return skip();
      }
    }

    const cached = usableCacheEntry(src);
    if (cached) {
      applyVerdict(img, verdictFromCache(cached), cached.scores, src);
      return;
    }

    classifyImage(img);
  }

  async function pingModel(forceRetry = false) {
    if (!isAiActive()) {
      state.modelReady = false;
      state.modelFailed = false;
      clearModelRetryTimer();
      return;
    }
    if (state.modelPingInFlight) return;
    state.modelPingInFlight = true;
    try {
      const result = await sendRuntimeMessage(
        { type: 'ai_ping_model', forceRetry, model: activeModelId() },
        MODEL_PING_TIMEOUT_MS,
        'ping timeout'
      );
      if (!isAiActive()) {
        state.modelReady = false;
        state.modelFailed = false;
        clearModelRetryTimer();
        return;
      }
      if (result && result.ready) {
        state.modelReady = true;
        state.modelFailed = false;
        clearModelRetryTimer();
        console.log('[BlockNSFW] AI Image Blocker ready' +
          (result.backend ? ' (backend: ' + result.backend + ')' : '') + '.');
        drainQueue();
      } else {
        state.modelReady = false;
        state.modelFailed = true;
        console.warn('[BlockNSFW] AI model unavailable:',
          result && result.error || 'unknown');
        // Don't leave candidates hidden while the model is down. Queued
        // images stay in pendingQueue and are re-hidden when a retry succeeds.
        revealAllPending();
        scheduleModelRetry(result && result.retryAfterMs);
      }
    } catch (err) {
      state.modelReady = false;
      state.modelFailed = true;
      console.warn('[BlockNSFW] AI model init failed:', err && err.message || err);
      revealAllPending();
      scheduleModelRetry();
    } finally {
      state.modelPingInFlight = false;
    }
  }

  window.AIImageBlocker = {
    init(settings) {
      state.settings = settings || state.settings || {};
      if (state.lru.size === 0) loadCacheFromStorage();
      injectStyles();
      clearModelRetryTimer();
      if (!isAiActive()) {
        state.modelReady = false;
        state.modelFailed = false;
        state.pendingQueue.length = 0;
        state.queuedImages = new WeakSet();
        clearAIBlockedImages();
        return;
      }
      if (!state.modelReady) {
        state.modelFailed = false;
        setTimeout(() => pingModel(false), 50);
      } else {
        drainQueue();
      }
    },
    onImageVisible,
    onImageSrcChanged,
    isReady() { return state.modelReady; },
    isDegraded() { return state.modelFailed; }
  };
})();
