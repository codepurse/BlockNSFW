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
