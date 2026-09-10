/* BlockNSFW background service worker */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Shared browser-safe hostname normalization helpers (RFC 3492 punycode
// decoder, IDN-aware variant helper). See shared/hostname.js.
try {
  if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
    self.importScripts('shared/browser-key.js');
    self.importScripts('shared/hostname.js');
    self.importScripts('shared/host-keywords.js');
    self.importScripts('shared/version-compare.js');
    self.importScripts('shared/validate-domain.js');
    self.importScripts('shared/keyword-pattern.js');
    self.importScripts('shared/ruleset.js');
    self.importScripts('shared/dns-providers.js');
    self.importScripts('shared/ai-image-models.js');
    self.importScripts('shared/vit-classifier.js');
  }
} catch (_) {
  // shared/hostname.js or shared/host-keywords.js could not be loaded
  // (e.g. test environment). The helpers are optional; ASCII-only checks
  // still work via ADULT_HOST_KEYWORDS.
}

// --- AI Image Blocker: TF.js + NSFW.js-compatible runtime in the background --
// The background context owns the model so host-page CSP never applies to the
// classifier runtime. How the runtime gets loaded differs per browser
// (importScripts in Chrome's service worker, <script> tags in Firefox's event
// page) — see preloadAiRuntime() / loadAiRuntimeViaDom() below.
// One entry per model id (see shared/ai-image-models.js). Both models can be
// resident at once, so switching the setting back and forth does not re-pay
// either load. Failure state is per model too: vit384's first load needs the
// network, so it can fail in ways the bundled MobileNet never will, and a
// vit384 outage must not put the fallback model into cooldown.
//   modelId -> { model, promise, failed, lastError, lastFailureAt }
const _aiModels = new Map();
// The TF.js backend the model actually ended up on ('webgl' | 'cpu'), reported
// back to the content script so the ready log names something real.
let _aiModelBackend = 'unknown';
let _aiRuntimeLoaded = false;
let _aiRuntimeLoadError = '';
// Firefox-only (<script>-tag) loading state; see loadAiRuntimeViaDom().
let _aiRuntimeDomPromise = null;
const _aiRuntimeScriptsLoaded = new Set();
const AI_MODEL_RETRY_COOLDOWN_MS = 5000;

function aiModelState(modelId) {
  const id = self.AiImageModels.normalizeModelId(modelId);
  let entry = _aiModels.get(id);
  if (!entry) {
    entry = { model: null, promise: null, failed: false, lastError: '', lastFailureAt: 0 };
    _aiModels.set(id, entry);
  }
  return entry;
}

function getAiModelErrorMessage(error) {
  return String(error && error.message || error || 'unknown error');
}

function getAiModelRetryAfterMs(now = Date.now(), modelId) {
  const state = aiModelState(modelId);
  if (!state.failed || !state.lastFailureAt) return 0;
  const remaining = AI_MODEL_RETRY_COOLDOWN_MS - (now - state.lastFailureAt);
  return remaining > 0 ? remaining : 0;
}

function syncAiRuntimeStateFromGlobals() {
  if (typeof self === 'undefined') return;
  if (typeof self.tf !== 'undefined' && typeof self.nsfwjs !== 'undefined') {
    _aiRuntimeLoaded = true;
    _aiRuntimeLoadError = '';
  }
}

// Order matters: nsfwjs.runtime.js expects `tf` to already exist.
const AI_RUNTIME_SCRIPTS = ['vendor/tfjs/tf.es2017.js', 'vendor/nsfwjs/nsfwjs.runtime.js'];

// Chrome: the MV3 service worker may only call importScripts() during its
// initial synchronous evaluation, so the runtime has to be pulled in eagerly
// at startup — it cannot be deferred to the first classify request.
function preloadAiRuntime() {
  if (typeof self === 'undefined' || typeof self.importScripts !== 'function') {
    return;
  }
  // Chrome 109+ classifies in the offscreen document, which is where the WebGL
  // context is and where the classify handler already prefers to go. The worker
  // never needs the runtime there, so importing it is 4.31 MB of TF.js pulled
  // into the worker synchronously on EVERY service-worker start — and the AI
  // image blocker is opt-in and off by default, so almost nobody who paid that
  // was using it. The comment on loadAiRuntimeViaDom() below spells out exactly
  // this cost as the reason Firefox loads lazily; Chrome simply never got the
  // same treatment.
  //
  // Older Chrome has no chrome.offscreen and genuinely needs the worker
  // fallback, and importScripts() may only run during initial synchronous
  // evaluation — so the decision has to be made here, and offscreenAvailable()
  // is synchronous.
  if (offscreenAvailable()) {
    return;
  }
  try {
    self.importScripts(...AI_RUNTIME_SCRIPTS);
    syncAiRuntimeStateFromGlobals();
    if (!_aiRuntimeLoaded) {
      if (typeof self.tf === 'undefined') {
        _aiRuntimeLoadError = 'failed to preload AI runtime: tfjs not available after preload';
      } else if (typeof self.nsfwjs === 'undefined') {
        _aiRuntimeLoadError = 'failed to preload AI runtime: nsfwjs not available after preload';
      }
    }
  } catch (err) {
    _aiRuntimeLoaded = false;
    _aiRuntimeLoadError = `failed to import AI runtime: ${getAiModelErrorMessage(err)}`;
  }
}

preloadAiRuntime();

// Firefox: there is no MV3 service worker. `background.scripts` runs in an
// event *page*, where importScripts() does not exist — so preloadAiRuntime()
// above is a no-op there and every classify/ping request used to fail with
// "AI runtime was not preloaded", which is why the AI image blocker never
// worked on Firefox. An event page does have a DOM, so load the runtime with
// <script> tags instead. Lazily, on first use: Firefox suspends idle event
// pages, and parsing the 4.5 MB TF.js bundle on every background wake-up
// would be a heavy cost for the majority of users who leave the AI blocker
// off (it is opt-in beta).
function canLoadAiRuntimeViaDom() {
  return typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    !!(document.head || document.documentElement);
}

function loadAiRuntimeScriptTag(path) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    // An extension-origin URL, so the extension CSP's script-src 'self' covers
    // it — no CSP relaxation needed.
    el.src = browserAPI.runtime.getURL(path);
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${path}`));
    (document.head || document.documentElement).appendChild(el);
  });
}

async function loadAiRuntimeViaDom() {
  // Track what already executed so a retry after a partial failure never
  // re-evaluates the multi-megabyte TF.js bundle.
  for (const path of AI_RUNTIME_SCRIPTS) {
    if (_aiRuntimeScriptsLoaded.has(path)) continue;
    await loadAiRuntimeScriptTag(path);
    _aiRuntimeScriptsLoaded.add(path);
  }
  syncAiRuntimeStateFromGlobals();
  if (_aiRuntimeLoaded) return;
  const missing = (typeof self !== 'undefined' && typeof self.tf === 'undefined')
    ? 'tfjs'
    : 'nsfwjs';
  throw new Error(`failed to load AI runtime: ${missing} not available after load`);
}

async function ensureAiRuntimeLoaded() {
  syncAiRuntimeStateFromGlobals();
  if (_aiRuntimeLoaded) return;
  if (canLoadAiRuntimeViaDom()) {
    if (!_aiRuntimeDomPromise) {
      _aiRuntimeDomPromise = loadAiRuntimeViaDom()
        .catch((err) => {
          _aiRuntimeLoadError = getAiModelErrorMessage(err);
          throw err;
        })
        // Drop the in-flight promise either way so a later ping can retry;
        // a success is already short-circuited by _aiRuntimeLoaded above.
        .finally(() => { _aiRuntimeDomPromise = null; });
    }
    await _aiRuntimeDomPromise;
    return;
  }
  if (_aiRuntimeLoadError) {
    throw new Error(_aiRuntimeLoadError);
  }
  // Neither mechanism is available: no importScripts (not a worker) and no DOM
  // (not a page). Nothing left to try — say so rather than reporting a
  // misleading model error.
  throw new Error('AI runtime unavailable: no importScripts and no DOM to load it with');
}

async function loadAiModel(options = {}) {
  const forceRetry = options && options.forceRetry === true;
  const descriptor = self.AiImageModels.resolveModel(options && options.model);
  const state = aiModelState(descriptor.id);
  if (state.model) return state.model;
  if (state.promise) return state.promise;
  const retryAfterMs = getAiModelRetryAfterMs(Date.now(), descriptor.id);
  if (state.failed && !forceRetry && retryAfterMs > 0) {
    const suffix = state.lastError ? `: ${state.lastError}` : '';
    throw new Error(`AI model cooling down after failure${suffix}`);
  }
  state.promise = (async () => {
    try {
      await ensureAiRuntimeLoaded();
      const tfLike = self.tf || null;
      if (tfLike && typeof tfLike.setBackend === 'function') {
        let backendSet = false;
        for (const backend of ['webgl', 'cpu']) {
          try {
            await tfLike.setBackend(backend);
            backendSet = true;
            break;
          } catch (_) {}
        }
        if (!backendSet && typeof tfLike.ready === 'function') {
          try { await tfLike.ready(); } catch (_) {}
        }
      }
      if (tfLike && typeof tfLike.ready === 'function') {
        try { await tfLike.ready(); } catch (_) {}
      }
      if (descriptor.kind === 'tfjs-graph-binary') {
        // Graph model: loaded directly with tf.loadGraphModel, because the
        // CSP-safe nsfwjs.runtime.js build cannot load graph models. Its
        // weights are fetched from the network on first use.
        state.model = await self.VitClassifier.load(descriptor.id);
      } else {
        // MobileNetV2 is a layers model; nsfwjs.runtime.js (the CSP-safe build
        // used here) only supports layers models, so load without options.
        state.model = await self.nsfwjs.load(
          browserAPI.runtime.getURL(descriptor.modelPath));
      }
      state.failed = false;
      state.lastError = '';
      state.lastFailureAt = 0;
      _aiModelBackend = (tfLike && typeof tfLike.getBackend === 'function' &&
        tfLike.getBackend()) || 'unknown';
      console.log('[BlockNSFW] AI Image Blocker model loaded:', descriptor.id,
        'backend:', _aiModelBackend);
      return state.model;
    } catch (err) {
      state.model = null;
      state.failed = true;
      state.lastError = getAiModelErrorMessage(err);
      state.lastFailureAt = Date.now();
      console.warn('[BlockNSFW] Failed to load NSFW model in SW:',
        descriptor.id, state.lastError);
      throw new Error(state.lastError);
    } finally {
      state.promise = null;
    }
  })();
  return state.promise;
}

async function classifyImageBytes(blobOrArrayBuffer, modelId) {
  const descriptor = self.AiImageModels.resolveModel(modelId);
  const model = await loadAiModel({ model: descriptor.id });
  let bitmap;
  const bitmapOptions = {
    resizeWidth: descriptor.inputSize,
    resizeHeight: descriptor.inputSize,
    resizeQuality: 'high'
  };
  if (blobOrArrayBuffer instanceof ArrayBuffer ||
      ArrayBuffer.isView(blobOrArrayBuffer)) {
    const blob = new Blob([blobOrArrayBuffer]);
    try {
      bitmap = await createImageBitmap(blob, bitmapOptions);
    } catch (_) {
      bitmap = await createImageBitmap(blob);
    }
  } else {
    try {
      bitmap = await createImageBitmap(blobOrArrayBuffer, bitmapOptions);
    } catch (_) {
      bitmap = await createImageBitmap(blobOrArrayBuffer);
    }
  }
  try {
    if (descriptor.kind === 'tfjs-graph-binary') {
      return await self.VitClassifier.classify(model, bitmap, descriptor.id);
    }
    const predictions = await model.classify(bitmap);
    const scores = {};
    for (const p of predictions) scores[p.className] = p.probability;
    return scores;
  } finally {
    try { bitmap.close(); } catch (_) {}
  }
}

// ============================================
// OFFSCREEN DOCUMENT (fast path: WebGL on GPU)
// ============================================
// The MV3 service worker has no WebGL and is killed on idle, so running TF.js
// there means CPU inference + repeated model reloads (slow). Chrome 109+ offers
// an offscreen document: a persistent DOM context WITH a WebGL context. We run
// the model there and relay classify/ping requests to it. When chrome.offscreen
// is unavailable (older Chrome, Firefox) we fall back to the in-SW path below.
const OFFSCREEN_URL = 'offscreen.html';
let _offscreenCreating = null;

function offscreenAvailable() {
  return typeof chrome !== 'undefined' && !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function hasOffscreenDocument() {
  try {
    if (chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(ctxs) && ctxs.length > 0;
    }
  } catch (_) {}
  return false;
}

async function ensureOffscreenDocument() {
  if (!offscreenAvailable()) return false;
  if (await hasOffscreenDocument()) return true;
  if (_offscreenCreating) { try { await _offscreenCreating; } catch (_) {} return true; }
  _offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: 'Run the on-device NSFW image classifier (TensorFlow.js + WebGL) off the main thread for speed.'
  });
  try {
    await _offscreenCreating;
  } catch (err) {
    // A concurrent create (race) is fine — the document now exists. Re-throw
    // anything else.
    if (!String(err && err.message || err).toLowerCase().includes('single offscreen')) {
      _offscreenCreating = null;
      throw err;
    }
  }
  _offscreenCreating = null;
  touchOffscreenDocument();
  return true;
}

// The offscreen document persists for the browser session once created, holding
// a live WebGL context and — by design, see offscreen.js — every model that has
// been initialised, so switching model in settings leaves both resident. That
// persistence is right while the feature is in use; nothing was releasing it
// when it stopped being used. Firefox reclaims the equivalent automatically by
// suspending its event page, so this is a Chromium-only leak.
const OFFSCREEN_IDLE_MS = 5 * 60 * 1000;
let _offscreenIdleTimer = null;

function touchOffscreenDocument() {
  if (!offscreenAvailable()) return;
  clearTimeout(_offscreenIdleTimer);
  _offscreenIdleTimer = setTimeout(closeOffscreenDocument, OFFSCREEN_IDLE_MS);
}

async function closeOffscreenDocument() {
  clearTimeout(_offscreenIdleTimer);
  _offscreenIdleTimer = null;
  if (!offscreenAvailable() || typeof chrome.offscreen.closeDocument !== 'function') return;
  // Deliberately does NOT gate on hasOffscreenDocument(): that reads
  // chrome.runtime.getContexts, which is Chrome 116+, so on 109-115 it always
  // reports false and the document would never be released — the exact leak
  // this function exists to close. Just close it and treat "there wasn't one"
  // as success; a cosmetic teardown must never break classification.
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {
    // No document, or a concurrent close won. Nothing to release either way.
  }
  _offscreenCreating = null;
}

function sendToOffscreen(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('offscreen timeout')); }
    }, timeoutMs || 20000);
    browserAPI.runtime.sendMessage({ target: 'offscreen-ai', ...payload }, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastErr = browserAPI.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message || String(lastErr)));
      resolve(res);
    });
  });
}

// A bundled model is a local file read; a model whose weights come off the
// network is not. vit384's first load pulls ~22 MB, which on a slow connection
// comfortably outlives the 30s that was fine when every model was packaged.
//
// The content script's own ping timeout (60s) can still fire during that first
// download, and that is fine: its retry sends another ping, offscreen's
// loadModel() hands back the SAME in-flight promise, so retries coalesce
// instead of starting a second download. Images simply go unfiltered until the
// weights land — the honest state, and the options page shows the progress.
const MODEL_DOWNLOAD_TIMEOUT_MS = 300000;
const MODEL_LOCAL_TIMEOUT_MS = 30000;

function modelNeedsDownload(modelId) {
  return !self.AiImageModels.resolveModel(modelId).bundled;
}

// If the selected model cannot load, fall back to the bundled one rather than
// leaving the user with NO image filtering. vit384 depends on the network for
// its first load, so "model unavailable" is a reachable everyday state (no
// connection, weights not published yet, cache evicted mid-download) — and for
// a content blocker, degrading to unfiltered is the worst possible outcome.
//
// The model that actually ran is reported back to the caller, so the content
// script tags its cache with the truth rather than with the setting. verdictFor
// dispatches on the score shape and ignores thresholds belonging to the other
// model, so a fallback verdict is computed against the correct default bars.
async function classifyWithFallback(blob, modelId) {
  const descriptor = self.AiImageModels.resolveModel(modelId);
  try {
    const scores = await classifyImageBytes(blob, descriptor.id);
    return { scores, model: descriptor.id };
  } catch (err) {
    const fallbackId = self.AiImageModels.DEFAULT_MODEL_ID;
    if (descriptor.bundled || descriptor.id === fallbackId) throw err;
    console.warn('[BlockNSFW] model', descriptor.id, 'unavailable, falling back to',
      fallbackId + ':', getAiModelErrorMessage(err));
    const scores = await classifyImageBytes(blob, fallbackId);
    return { scores, model: fallbackId, fellBackFrom: descriptor.id };
  }
}

function pingTimeoutFor(modelId) {
  return modelNeedsDownload(modelId) ? MODEL_DOWNLOAD_TIMEOUT_MS : MODEL_LOCAL_TIMEOUT_MS;
}

function classifyTimeoutFor(modelId) {
  // A classify request can be the one that triggers the initial load, so it
  // needs the same headroom.
  return modelNeedsDownload(modelId) ? MODEL_DOWNLOAD_TIMEOUT_MS : MODEL_LOCAL_TIMEOUT_MS;
}

// Storage keys
const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const DAILY_STATS_KEY = 'pblocker_daily_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const AUDIT_BLOCKED_KEY = 'pblocker_audit_blocked';
const AUDIT_DISABLED_KEY = 'pblocker_audit_disabled';
const AUDIT_MAX_ENTRIES = 1000; // Maximum entries per audit log type
const AUDIT_RETENTION_DAYS = 30;
const STREAK_START_KEY = 'pblocker_streak_start';
const LONGEST_STREAK_KEY = 'pblocker_longest_streak';
const TOP_DOMAINS_KEY = 'pblocker_top_domains';
const DAILY_HISTORY_KEY = 'pblocker_daily_history';

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  useSmartBlocking: true,
  customPatterns: [], // user patterns, wildcard supported e.g. *.example.com, example.com/path
  trustedImageDomains: [], // domains where images should never be blocked
  debugMode: false,
  searchResultTreatment: 'hide', // 'hide' | 'overlay' — web/text results only
  searchSummaryEnabled: true, // draw the "N results blocked" line on search pages
  blockCountDisplay: 'badge', // 'badge' (toolbar icon) | 'floating' (in-page pill)
  dnsFilterEnabled: false,
  dnsProvider: 'cloudflare', // see shared/dns-providers.js for the roster
  dnsCustomUrl: '', // DoH endpoint used when dnsProvider is 'custom'
  safeSearchEnabled: true,
  facebookReelsEnabled: false,
  instagramReelsEnabled: false,
  aiImageBlocker: false, // Beta — opt-in (off on fresh install)
  aiImageScanAllSites: true, // when AI image blocker is on, scan 1st-party too
  aiImageModel: 'nsfwjs', // 'nsfwjs' (bundled) | 'vit384' (downloads weights)
  aiStrictness: 'balanced',
  aiTextBlocker: false, // Beta — opt-in (off on fresh install)
  aiTextStrictness: 'balanced',
};

// Default trusted domains for images (gaming, social media, e-commerce platforms)
const DEFAULT_TRUSTED_IMAGE_DOMAINS = [
  'steampowered.com',
  'steamstatic.com',
  'steamcommunity.com',
  'store.steampowered.com',
  'cdn.akamai.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'epicgames.com',
  'unrealengine.com',
  'gog.com',
  'origin.com',
  'battle.net',
  'blizzard.com',
  'ubisoft.com',
  'ea.com',
  'nintendo.com',
  'playstation.com',
  'xbox.com',
  'microsoft.com',
  'amazon.com',
  'ebay.com',
  'walmart.com',
  'target.com',
  'bestbuy.com',
  'newegg.com',
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'discord.com',
  'reddit.com',
  'imgur.com',
  'github.com',
  'stackoverflow.com',
  'wikipedia.org',
  'wikimedia.org'
];

const DEFAULT_STATS = {
  blockedCount: 0,
  websiteBlockedCount: 0,
  imageBlockedCount: 0,
  aiImageBlockedCount: 0,
  searchResultBlockedCount: 0,
  // Recorded but not yet surfaced anywhere. content.js has always reported
  // these three; the listener had no handler for them, so they counted for
  // nothing at all. Giving them their own fields keeps the breakdown honest
  // and means a future tile on the stats page is a UI change with history
  // already behind it, rather than a counter starting from zero.
  videoBlockedCount: 0,
  iframeBlockedCount: 0,
  socialPostBlockedCount: 0,
  lastBlocked: null,
  lastWebsiteBlocked: null,
};

let defaultBlocklist = [];
let compiledPatterns = [];
let defaultBlocklistSet = new Set();

// Resolves once the blocklist + compiled patterns are loaded. shouldBlock()
// awaits this so the very first request after a cold service-worker wake-up
// cannot leak through while defaultBlocklistSet is still empty.
let resolveReady;
let initReady = new Promise((resolve) => { resolveReady = resolve; });
let isReady = false;
function markReady() {
  if (!isReady) {
    isReady = true;
    resolveReady();
  }
}

// Multi-tenant CDN parent domains that must not be parent-domain blocked.
const SHARED_CDN_PARENT_DOMAINS = new Set([
  'b-cdn.net', 'cloudfront.net', 'akamaized.net', 'akamaihd.net',
  'azureedge.net', 'azurefd.net', 'cloudflare.net', 'fastly.net',
  'fastlylb.net', 'cdn77.org', 'kxcdn.com', 'stackpathdns.com',
  'edgecastcdn.net', 'imgix.net', 'scene7.com', 'amazonaws.com',
  'digitaloceanspaces.com', 'r2.dev', 'netlify.app', 'vercel.app',
  'pages.dev', 'herokuapp.com', 'github.io', 'imagedelivery.net',
  'twimg.com', 'fbcdn.net', 'cdninstagram.com', 'gstatic.com',
  'googleapis.com', 'ggpht.com',
]);

function isSharedCDNParent(domain) {
  return SHARED_CDN_PARENT_DOMAINS.has(domain);
}

// Performance optimization: Pattern and URL caching
let patternCache = new Map(); // Cache for compiled regex patterns
let urlCheckCache = new Map(); // Cache for URL blocking decisions
let keywordCheckCache = new Map(); // Cache for hostname keyword checks
const MAX_CACHE_SIZE = 1000; // Limit cache size to prevent memory bloat
let cacheVersion = 0; // Version to invalidate caches when patterns change

// Remote blocklist configuration
// Hosted in the maintainer's codepurse/BlockNSFW repository under MIT
// (data/LICENSE). Provenance: see data/SOURCE_NOTES.txt.
const REMOTE_BLOCKLIST_URL = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/HOSTS.txt';
const BLOCKLIST_CACHE_META_KEY = 'pblocker_blocklist_meta_v2';
const BLOCKLIST_CACHE_CHUNK_PREFIX = 'pblocker_blocklist_chunk_v2_';
const BLOCKLIST_CACHE_CHUNK_SIZE = 5000;
const BLOCKLIST_CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours
// Release builds replace this token with their UTC build time. Direct source
// loads leave it at zero and use installation time as a development fallback.
const BUNDLED_BLOCKLIST_BUILT_AT = Number('__BLOCKNSFW_BUILD_TIMESTAMP_MS__') || 0;

let blocklistMeta = null;
let remoteBlocklistPromise = null;

// Remote global whitelist (false-positive overrides managed via GitHub)
// Same maintainer-owned repository as the blocklist above.
// --- Ruleset subscriptions ---------------------------------------------------
//
// A subscription is a URL the user chose, holding a list someone else maintains.
// The metadata (name, url, status) lives apart from the rules themselves so the
// options page can render the list without pulling tens of thousands of entries
// into memory to do it.
//
// Subscriptions are strictly additive: their entries can add blocks and can do
// nothing else. There is no allow form in the rule syntax, and nothing here
// touches the whitelist or the enabled flag. A remote file that could unblock a
// site would be a remote off switch on a porn blocker, which is the one thing
// this cannot become.
const SUBSCRIPTIONS_KEY = 'pblocker_subscriptions';
const SUBSCRIPTION_RULES_KEY = 'pblocker_subscription_rules';
const SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000; // once a day is plenty
const MAX_SUBSCRIPTIONS = 20;

const REMOTE_WHITELIST_URL = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/WHITELIST.txt';
const REMOTE_WHITELIST_CACHE_KEY = 'pblocker_remote_whitelist_v1';
const REMOTE_WHITELIST_META_KEY = 'pblocker_remote_whitelist_meta_v1';
let remoteWhitelistSet = new Set();
let remoteWhitelistMeta = null;
let remoteWhitelistPromise = null;

// Update checker. A small version.json lives next to HOSTS.txt/WHITELIST.txt in
// the maintainer's repo; we fetch it, compare `latest` against the installed
// manifest version, and stash the verdict in storage so the popup/options page
// can show an "update available" banner. Self-hosted (not the store APIs) so a
// single code path works identically on Chrome and Firefox. Bump version.json
// on each published release.
const REMOTE_VERSION_URL = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/version.json';
const UPDATE_INFO_KEY = 'pblocker_update_info';
const DEFAULT_UPDATE_URL = 'https://github.com/codepurse/BlockNSFW/releases';
const UPDATE_CHECK_TTL = 1000 * 60 * 60 * 12; // 12 hours
let updateCheckPromise = null;

// Prefer the store link for the running browser, falling back to a generic URL.
// Uses detectBrowserKey() (UA-based) rather than `typeof browser`, which misfires
// on Chrome — see the note there.
//
// Edge is its own key and its own store. This used to test only for Firefox and
// send everything else to chromeUrl, which would have handed Edge users a
// Chrome Web Store link they cannot update an Edge-installed extension from.
// A Chromium fork with no store of its own (Brave, Opera, Vivaldi) buckets as
// 'chrome' in detectBrowserKey and is correctly served the Chrome link.
function pickUpdateUrl(data) {
  if (!data || typeof data !== 'object') return DEFAULT_UPDATE_URL;
  const byBrowser = { firefox: data.firefoxUrl, edge: data.edgeUrl, chrome: data.chromeUrl };
  const preferred = byBrowser[detectBrowserKey()];
  if (typeof preferred === 'string' && preferred) return preferred;
  if (typeof data.url === 'string' && data.url) return data.url;
  return DEFAULT_UPDATE_URL;
}

// Fetch version.json (TTL-guarded, like the remote blocklist/whitelist) and
// write { current, latest, updateAvailable, notes, url, checkedAt } to storage.
// Returns the info object, or null on failure (callers fail silently — a failed
// check must never block or surface an error to the user).
async function checkForUpdate(options = {}) {
  const { forceRefresh = false } = options;
  if (updateCheckPromise) return updateCheckPromise;

  updateCheckPromise = (async () => {
    try {
      const { [UPDATE_INFO_KEY]: cached } = await browserAPI.storage.local.get(UPDATE_INFO_KEY);
      const isFresh = cached && cached.checkedAt &&
        (Date.now() - cached.checkedAt) < UPDATE_CHECK_TTL;
      if (isFresh && !forceRefresh) return cached;

      const current = browserAPI.runtime.getManifest().version;
      const response = await fetch(REMOTE_VERSION_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`version check failed (${response.status})`);
      const data = await response.json();
      const latest = (data && typeof data.latest === 'string') ? data.latest.trim() : '';

      const updateAvailable = !!(latest &&
        typeof VersionCompare !== 'undefined' &&
        VersionCompare.isOutdated(current, latest));

      const info = {
        current,
        latest: latest || current,
        updateAvailable,
        notes: (data && typeof data.notes === 'string') ? data.notes : '',
        url: pickUpdateUrl(data),
        checkedAt: Date.now()
      };
      await browserAPI.storage.local.set({ [UPDATE_INFO_KEY]: info });
      if (updateAvailable) {
        console.log(`BlockNSFW: update available ${current} -> ${latest}`);
      }
      return info;
    } catch (error) {
      console.warn('BlockNSFW: update check failed', error);
      return null;
    } finally {
      updateCheckPromise = null;
    }
  })();

  return updateCheckPromise;
}

// Which browser we are running in, from shared/browser-key.js (loaded above
// in Chrome, listed in `background.scripts` in Firefox). Called through a
// wrapper rather than aliased: the importScripts() above is deliberately
// failure-tolerant, and a top-level read of a missing global would abort the
// rest of this worker instead of just this one lookup.
const detectBrowserKey = () => BrowserKey.detectBrowserKey();

// Cache management functions
function clearAllCaches() {
  patternCache.clear();
  urlCheckCache.clear();
  keywordCheckCache.clear();
  cacheVersion++;
}

function limitCacheSize(cache, maxSize) {
  if (cache.size > maxSize) {
    const keysToDelete = Array.from(cache.keys()).slice(0, cache.size - maxSize);
    keysToDelete.forEach(key => cache.delete(key));
  }
}

function addToCache(cache, key, value) {
  cache.set(key, value);
  limitCacheSize(cache, MAX_CACHE_SIZE);
}

function normalizeDomainForCache(domain) {
  // Remove www. prefix and normalize for consistent caching
  return (domain || '').trim().toLowerCase().replace(/^www\./, '');
}

// Accept ASCII labels, including ACE-encoded punycode labels that begin with
// "xn--". Each label must be 1-63 chars, alphanumeric or hyphen, may not start
// or end with a hyphen. The TLD may also be a punycode TLD ("xn--...").
//
// Hoisted: this was constructed inside isLikelyDomain, which runs once per
// domain — 204,222 RegExp constructions per blocklist load, and a load happens
// on every background wake.
const DOMAIN_LABEL_PATTERN = '(?!-)(?:xn--[a-z0-9-]{2,61}|[a-z0-9-]{1,63})(?<!-)';
const LIKELY_DOMAIN_RE = new RegExp(
  `^(?:${DOMAIN_LABEL_PATTERN}\\.)+${DOMAIN_LABEL_PATTERN}$`, 'i'
);

function isLikelyDomain(candidate) {
  if (!candidate) return false;
  if (candidate.length > 253) return false;
  return LIKELY_DOMAIN_RE.test(candidate);
}

function parseHostsFile(text) {
  const domains = new Set();
  if (typeof text !== 'string' || text.length === 0) {
    return domains;
  }

  const ipPattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (!part || part.startsWith('#')) break;
      if (ipPattern.test(part) || part === '::1') continue;
      const normalized = normalizeDomainForCache(part);
      if (isLikelyDomain(normalized)) {
        domains.add(normalized);
      }
    }
  }

  return domains;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  if (!Array.isArray(items) || chunkSize <= 0) return chunks;
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function loadBlocklistMeta() {
  try {
    const { [BLOCKLIST_CACHE_META_KEY]: meta } = await browserAPI.storage.local.get(BLOCKLIST_CACHE_META_KEY);
    blocklistMeta = meta || null;
    return blocklistMeta;
  } catch (error) {
    console.warn('BlockNSFW: failed to load blocklist metadata', error);
    blocklistMeta = null;
    return null;
  }
}

function blocklistChunkKey(meta, index) {
  const generation = meta && typeof meta.generation === 'string' ? meta.generation : '';
  return generation
    ? `${BLOCKLIST_CACHE_CHUNK_PREFIX}${generation}_${index}`
    : `${BLOCKLIST_CACHE_CHUNK_PREFIX}${index}`;
}

function blocklistChunkKeys(meta) {
  if (!meta || !Number.isInteger(meta.chunkCount) || meta.chunkCount <= 0) return [];
  return Array.from({ length: meta.chunkCount }, (_, index) => blocklistChunkKey(meta, index));
}

function createBlocklistGeneration() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function removeBlocklistGeneration(meta) {
  const keys = blocklistChunkKeys(meta);
  if (keys.length > 0) await browserAPI.storage.local.remove(keys);
}

async function storeBlocklistInCache(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return null;

  const previousMeta = blocklistMeta || (await loadBlocklistMeta());
  const uniqueSet = new Set();
  for (let index = 0; index < domains.length; index++) {
    const normalized = normalizeDomainForCache(domains[index]);
    if (isLikelyDomain(normalized)) uniqueSet.add(normalized);
    // Keep a large refresh cooperative with Firefox rendering.
    if (index > 0 && index % 5000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  const uniqueDomains = Array.from(uniqueSet);

  const chunks = chunkArray(uniqueDomains, BLOCKLIST_CACHE_CHUNK_SIZE);

  const meta = {
    updatedAt: Date.now(),
    chunkCount: chunks.length,
    version: (previousMeta?.version || 0) + 1,
    generation: createBlocklistGeneration(),
    source: 'remote',
    domainCount: uniqueDomains.length
  };

  // Avoid one multi-megabyte storage serialization task. Small batches let the
  // browser render between writes; metadata is committed last so readers never
  // observe a partially written generation as current.
  for (let start = 0; start < chunks.length; start += 8) {
    const dataToStore = {};
    for (let index = start; index < Math.min(chunks.length, start + 8); index++) {
      dataToStore[blocklistChunkKey(meta, index)] = chunks[index];
    }
    await browserAPI.storage.local.set(dataToStore);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await browserAPI.storage.local.set({ [BLOCKLIST_CACHE_META_KEY]: meta });
  blocklistMeta = meta;

  // Metadata switches readers to the complete new generation atomically.
  // Cleanup is best-effort: stale data costs space, but must not invalidate an
  // otherwise successful refresh.
  if (previousMeta) {
    try {
      await removeBlocklistGeneration(previousMeta);
    } catch (error) {
      console.warn('BlockNSFW: failed to remove stale blocklist generation', error);
    }
  }
  return meta;
}

async function loadBlocklistFromCache() {
  const meta = blocklistMeta || (await loadBlocklistMeta());
  if (!meta || !meta.chunkCount) {
    return [];
  }

  const chunkKeys = blocklistChunkKeys(meta);
  const storedChunks = await browserAPI.storage.local.get(chunkKeys);
  const domains = [];

  for (let index = 0; index < chunkKeys.length; index++) {
    const key = chunkKeys[index];
    const chunk = storedChunks[key];
    if (!Array.isArray(chunk)) return [];
    // storeBlocklistInCache() normalized and validated every entry before it was
    // written, and metadata is committed last so a partial generation is never
    // read as current. Re-normalizing and re-validating 204k strings on every
    // background wake was re-verifying our own output.
    for (let j = 0; j < chunk.length; j++) {
      domains.push(chunk[j]);
    }
  }

  return domains;
}

async function fetchRemoteBlocklist() {
  const response = await fetch(REMOTE_BLOCKLIST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to download remote blocklist (${response.status})`);
  }
  const text = await response.text();
  const domainSet = parseHostsFile(text);
  return Array.from(domainSet);
}

async function ensureRemoteBlocklistUpToDate(options = {}) {
  const { forceRefresh = false } = options;
  if (remoteBlocklistPromise) {
    return remoteBlocklistPromise;
  }

  remoteBlocklistPromise = (async () => {
    try {
      const meta = blocklistMeta || (await loadBlocklistMeta());
      const isStale = !meta || !meta.updatedAt || (Date.now() - meta.updatedAt) > BLOCKLIST_CACHE_TTL || forceRefresh;

      if (!isStale && Array.isArray(defaultBlocklist) && defaultBlocklist.length > 0) {
        return { meta, domains: defaultBlocklist };
      }

      const remoteDomains = await fetchRemoteBlocklist();
      if (remoteDomains.length > 0) {
        const newMeta = await storeBlocklistInCache(remoteDomains);
        const refreshedDomains = await loadBlocklistFromCache();
        if (Array.isArray(refreshedDomains) && refreshedDomains.length > 0) {
          defaultBlocklist = refreshedDomains;
        } else {
          defaultBlocklist = remoteDomains.map(normalizeDomainForCache).filter(isLikelyDomain);
        }
        defaultBlocklistSet = new Set(defaultBlocklist);
        await rebuildCompiledPatterns();
        return { meta: newMeta, domains: defaultBlocklist };
      }

      return { meta, domains: defaultBlocklist };
    } catch (error) {
      console.warn('BlockNSFW: remote blocklist update failed', error);
      return { meta: blocklistMeta, domains: defaultBlocklist };
    } finally {
      remoteBlocklistPromise = null;
    }
  })();

  return remoteBlocklistPromise;
}

// --- Remote Global Whitelist ---
function parseWhitelistFile(text) {
  const domains = new Set();
  if (typeof text !== 'string' || text.length === 0) return domains;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const url = line.includes('://') ? new URL(line) : new URL('https://' + line);
      const normalized = normalizeDomainForCache(url.hostname);
      if (isLikelyDomain(normalized)) domains.add(normalized);
    } catch (_) {
      const normalized = normalizeDomainForCache(line);
      if (isLikelyDomain(normalized)) domains.add(normalized);
    }
  }
  return domains;
}

// --- Ruleset subscriptions: storage ------------------------------------------

async function getSubscriptions() {
  try {
    const { [SUBSCRIPTIONS_KEY]: list } = await browserAPI.storage.local.get(SUBSCRIPTIONS_KEY);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

async function setSubscriptions(list) {
  await browserAPI.storage.local.set({ [SUBSCRIPTIONS_KEY]: list });
}

async function getSubscriptionRules() {
  try {
    const { [SUBSCRIPTION_RULES_KEY]: rules } = await browserAPI.storage.local.get(SUBSCRIPTION_RULES_KEY);
    return (rules && typeof rules === 'object') ? rules : {};
  } catch (_) {
    return {};
  }
}

async function setSubscriptionRules(rules) {
  await browserAPI.storage.local.set({ [SUBSCRIPTION_RULES_KEY]: rules });
}

/**
 * Every rule from every enabled subscription, flattened. Disabled ones are left
 * on disk so switching a subscription back on does not need a re-download.
 */
async function getActiveSubscriptionEntries() {
  const [subscriptions, rules] = await Promise.all([getSubscriptions(), getSubscriptionRules()]);
  const entries = [];
  for (const subscription of subscriptions) {
    if (!subscription || subscription.enabled === false) continue;
    const own = rules[subscription.id];
    if (Array.isArray(own)) entries.push(...own);
  }
  return entries;
}

function subscriptionId(url) {
  // Derived from the URL rather than random, so adding the same list twice is
  // caught and a re-add reuses the rules already downloaded.
  return 'sub_' + String(url || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
}

// --- Ruleset subscriptions: fetching -----------------------------------------

async function fetchSubscriptionRuleset(url) {
  if (!self.Ruleset || !self.Ruleset.isHttpUrl(url)) {
    throw new Error('Only http(s) addresses can be subscribed to');
  }
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const text = await response.text();
  if (text.length > self.Ruleset.MAX_FILE_BYTES) {
    throw new Error('That file is too large to use as a ruleset');
  }

  const parsed = self.Ruleset.parseRuleset(text);
  if (parsed.entries.length === 0) {
    // An HTML error page or a wrong link parses cleanly to nothing, so this is
    // the check that catches "you pasted the GitHub page, not the raw file".
    throw new Error('No rules found at that address');
  }
  return parsed;
}

/**
 * Re-download one subscription. Failures are recorded on the subscription and
 * never throw outward: a list whose host is down must not stop the others, and
 * the rules already on disk keep working in the meantime.
 */
async function refreshSubscription(id, options = {}) {
  const { force = false } = options;
  const subscriptions = await getSubscriptions();
  const subscription = subscriptions.find((item) => item && item.id === id);
  if (!subscription) return { ok: false, error: 'Subscription not found' };

  const isStale = force || !subscription.updatedAt ||
    (Date.now() - subscription.updatedAt) > SUBSCRIPTION_TTL_MS;
  if (!isStale) return { ok: true, skipped: true };

  try {
    const parsed = await fetchSubscriptionRuleset(subscription.url);
    const rules = await getSubscriptionRules();
    rules[id] = parsed.entries;
    await setSubscriptionRules(rules);

    subscription.name = subscription.customName || parsed.name || subscription.name;
    subscription.homepage = parsed.homepage || '';
    subscription.entryCount = parsed.entries.length;
    subscription.skipped = parsed.skipped;
    subscription.truncated = !!parsed.truncated;
    subscription.updatedAt = Date.now();
    subscription.error = '';
    await setSubscriptions(subscriptions);
    await rebuildCompiledPatterns();
    return { ok: true, entryCount: parsed.entries.length, skipped: parsed.skipped };
  } catch (error) {
    subscription.error = error && error.message ? error.message : 'Update failed';
    subscription.lastErrorAt = Date.now();
    await setSubscriptions(subscriptions);
    return { ok: false, error: subscription.error };
  }
}

async function refreshAllSubscriptions(options = {}) {
  const subscriptions = await getSubscriptions();
  const results = [];
  for (const subscription of subscriptions) {
    if (!subscription || subscription.enabled === false) continue;
    results.push(await refreshSubscription(subscription.id, options));
  }
  return results;
}

async function addSubscription(url, name) {
  const trimmed = String(url || '').trim();
  if (!self.Ruleset || !self.Ruleset.isHttpUrl(trimmed)) {
    return { ok: false, error: 'Enter a full http:// or https:// address' };
  }

  const subscriptions = await getSubscriptions();
  if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
    return { ok: false, error: `You can follow up to ${MAX_SUBSCRIPTIONS} lists` };
  }

  const id = subscriptionId(trimmed);
  if (subscriptions.some((item) => item && item.id === id)) {
    return { ok: false, error: 'You already follow that list' };
  }

  const customName = String(name || '').trim().slice(0, 80);
  subscriptions.push({
    id,
    url: trimmed,
    name: customName || trimmed,
    customName,
    enabled: true,
    addedAt: Date.now(),
    updatedAt: 0,
    entryCount: 0,
    error: ''
  });
  await setSubscriptions(subscriptions);

  // Fetch immediately: a subscription that sits empty until some later refresh
  // looks broken, and this is also where a bad URL gets reported while the user
  // is still looking at the box.
  const result = await refreshSubscription(id, { force: true });
  return { ok: true, id, fetch: result };
}

async function removeSubscription(id) {
  const subscriptions = await getSubscriptions();
  const next = subscriptions.filter((item) => item && item.id !== id);
  await setSubscriptions(next);

  const rules = await getSubscriptionRules();
  delete rules[id];
  await setSubscriptionRules(rules);

  await rebuildCompiledPatterns();
  return { ok: true };
}

async function setSubscriptionEnabled(id, enabled) {
  const subscriptions = await getSubscriptions();
  const subscription = subscriptions.find((item) => item && item.id === id);
  if (!subscription) return { ok: false, error: 'Subscription not found' };
  subscription.enabled = !!enabled;
  await setSubscriptions(subscriptions);
  await rebuildCompiledPatterns();
  return { ok: true };
}

async function fetchRemoteWhitelist() {
  const response = await fetch(REMOTE_WHITELIST_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to download remote whitelist (${response.status})`);
  const text = await response.text();
  return Array.from(parseWhitelistFile(text));
}

async function loadRemoteWhitelistFromCache() {
  try {
    const result = await browserAPI.storage.local.get([REMOTE_WHITELIST_CACHE_KEY, REMOTE_WHITELIST_META_KEY]);
    const domains = result[REMOTE_WHITELIST_CACHE_KEY];
    remoteWhitelistMeta = result[REMOTE_WHITELIST_META_KEY] || null;
    if (Array.isArray(domains) && domains.length > 0) {
      remoteWhitelistSet = new Set(domains.map(normalizeDomainForCache).filter(isLikelyDomain));
      return true;
    }
  } catch (error) {
    console.warn('BlockNSFW: failed to load cached remote whitelist', error);
  }
  return false;
}

async function storeRemoteWhitelistInCache(domains) {
  const uniqueDomains = Array.from(new Set(domains.map(normalizeDomainForCache).filter(isLikelyDomain)));
  uniqueDomains.sort();
  const meta = {
    updatedAt: Date.now(),
    version: (remoteWhitelistMeta?.version || 0) + 1,
    domainCount: uniqueDomains.length
  };
  await browserAPI.storage.local.set({
    [REMOTE_WHITELIST_CACHE_KEY]: uniqueDomains,
    [REMOTE_WHITELIST_META_KEY]: meta
  });
  remoteWhitelistMeta = meta;
  return meta;
}

async function ensureRemoteWhitelistUpToDate(options = {}) {
  const { forceRefresh = false } = options;
  if (remoteWhitelistPromise) return remoteWhitelistPromise;

  remoteWhitelistPromise = (async () => {
    try {
      if (!remoteWhitelistMeta) await loadRemoteWhitelistFromCache();
      const isStale = !remoteWhitelistMeta || !remoteWhitelistMeta.updatedAt ||
        (Date.now() - remoteWhitelistMeta.updatedAt) > BLOCKLIST_CACHE_TTL || forceRefresh;

      if (!isStale && remoteWhitelistSet.size > 0) {
        return { meta: remoteWhitelistMeta, domains: Array.from(remoteWhitelistSet) };
      }

      const remoteDomains = await fetchRemoteWhitelist();
      if (remoteDomains.length > 0) {
        await storeRemoteWhitelistInCache(remoteDomains);
        remoteWhitelistSet = new Set(remoteDomains.map(normalizeDomainForCache).filter(isLikelyDomain));
      }
      console.log(`BlockNSFW: Remote whitelist loaded - ${remoteWhitelistSet.size} domains`);
      return { meta: remoteWhitelistMeta, domains: remoteDomains };
    } catch (error) {
      console.warn('BlockNSFW: remote whitelist update failed', error);
      return { meta: remoteWhitelistMeta, domains: Array.from(remoteWhitelistSet) };
    } finally {
      remoteWhitelistPromise = null;
    }
  })();

  return remoteWhitelistPromise;
}

function isInRemoteWhitelist(hostname) {
  if (remoteWhitelistSet.size === 0) return false;
  const normalized = normalizeDomainForCache(hostname);
  if (remoteWhitelistSet.has(normalized)) return true;
  const parts = normalized.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (remoteWhitelistSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// Utility: compile wildcard pattern to regex (with caching)
function patternToRegex(pattern) {
  // Check cache first
  const cacheKey = `${pattern}_${cacheVersion}`;
  if (patternCache.has(cacheKey)) {
    return patternCache.get(cacheKey);
  }
  
  // Escape regex special chars except * and ?
  const escaped = pattern
    .replace(/[.+^${}()|\[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp('^' + escaped + '$', 'i');
  
  // Cache the compiled regex
  addToCache(patternCache, cacheKey, regex);
  return regex;
}

// Escapes a user glob for use inside a larger regex: regex metacharacters
// become literals, while `*` and `?` keep their wildcard meaning. Unlike
// patternToRegex this does not anchor, so the caller can wrap it in scheme and
// path scaffolding without that scaffolding being escaped too.
function globToRegexSource(glob) {
  return String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
}

function buildHostPatterns(patterns) {
  const compiled = [];
  // Pre-allocate array size for better memory efficiency
  compiled.length = patterns.length;
  let validCount = 0;
  
  for (let i = 0; i < patterns.length; i++) {
    try {
      const p = patterns[i];
      let regex;

      // `/regex/` entries match the URL directly. `title/…/` entries need the
      // page title, which does not exist yet at navigation time, so they are
      // skipped here and enforced by the content script once the page loads.
      if (typeof KeywordPattern !== 'undefined' && KeywordPattern.compileListEntry) {
        const listEntry = KeywordPattern.compileListEntry(p);
        if (listEntry.kind === 'title') continue;
        if (listEntry.kind === 'url') {
          if (listEntry.regex) compiled[validCount++] = listEntry.regex;
          continue;
        }
      } else if (typeof p === 'string' && /^\s*(title\s*)?\/.*\/[a-z]*\s*$/i.test(p)) {
        // The helper is missing (an environment where neither importScripts nor
        // the manifest loaded it). Falling through to the glob path would escape
        // the slashes and produce a pattern that silently matches nothing — the
        // user would see no error and no blocking. Handle the entry directly
        // instead, and say so, rather than failing quietly.
        console.warn('BlockNSFW: keyword-pattern helper unavailable; compiling pattern directly:', p);
        const trimmed = p.trim();
        if (/^title/i.test(trimmed)) continue; // title patterns are page-level
        const close = trimmed.lastIndexOf('/');
        const body = trimmed.slice(1, close);
        const flags = trimmed.slice(close + 1);
        try {
          compiled[validCount++] = new RegExp(body, flags.indexOf('i') === -1 ? flags + 'i' : flags);
        } catch (err) {
          console.warn('BlockNSFW: invalid pattern skipped:', p, err);
        }
        continue;
      }

      // Build the regex from the user's glob, then add the scheme and optional
      // path as real regex syntax.
      //
      // These used to be concatenated first and escaped afterwards, which meant
      // the scheme and path scaffolding was escaped along with the user's text:
      // "example.com" compiled to /^https.:\/\/example\.com\(\/\..*\).$/ — a
      // pattern demanding a literal "(" in the URL, so it matched nothing.
      // Custom blocklist entries were therefore never blocked at navigation
      // time; only the content script caught them, after the page had begun
      // loading. Escaping the user's part alone fixes that.
      if (!/^https?:\/\//i.test(p)) {
        const slash = p.indexOf('/');
        // A leading dot (".xyz", ".example.com") names the same thing as the
        // bare form; left in, it compiled to a pattern demanding a literal
        // double dot and so matched nothing. The content script applies the
        // same rule, and the two layers have to agree.
        const hostPart = (slash >= 0 ? p.slice(0, slash) : p).replace(/^\.+/, '');
        const pathPart = slash >= 0 ? p.slice(slash) : '';
        if (!hostPart) continue;
        // A bare host covers its subdomains, matching how the content script
        // reads the same entry (host === base || host endsWith '.' + base).
        // The two layers must agree or a site blocks on one and not the other.
        const hostSrc = hostPart.startsWith('*.')
          ? '(?:.*\\.)?' + globToRegexSource(hostPart.slice(2))
          : '(?:[^/]*\\.)?' + globToRegexSource(hostPart);
        regex = new RegExp('^https?://' + hostSrc + globToRegexSource(pathPart) + '(/.*)?$', 'i');
      } else {
        regex = new RegExp('^' + globToRegexSource(p) + '(/.*)?$', 'i');
      }
      
      if (regex) {
        compiled[validCount++] = regex;
      }
    } catch (e) {
      console.warn('BlockNSFW: Invalid pattern:', patterns[i], e);
    }
  }
  
  // Trim array to actual size to save memory
  compiled.length = validCount;
  return compiled;
}

// Conservative list of adult keywords in host labels (avoid false positives like "essex").
// Match rule: whole-label or hyphen-separated only (see hostnameMatchesAdultKeywords).
// Host-only adult keyword list lives in shared/host-keywords.js so the
// service worker and the content script can share the same source of truth.
// Foreign-language hosts often use Latin transliterations (bokep/yadong/sikis/seks etc.)
// because non-Latin domains become unreadable punycode.
// We keep `ADULT_HOST_KEYWORDS` as an alias for any in-file references that
// pre-date the shared module.
const ADULT_HOST_KEYWORDS = (typeof HostBlockKeywords !== 'undefined' && HostBlockKeywords.ADULT_HOST_KEYWORDS)
  ? HostBlockKeywords.ADULT_HOST_KEYWORDS
  : [
      // Same fallback list lives in shared/host-keywords.js. Keep both in sync
      // only if a future build path can't import the shared module.
      'porn','porno','pornos','xxx','xvideos','xhamster','xnxx','redtube',
      'youporn','brazzers','chaturbate','bongacams','cam4','pornhub',
      'spankbang','tube8','youjizz','nudography','onlyfans','erome',
      'hentai','hentaihaven','rule34','seks','sikis','bokep','yadong',
      'pornoizle','tubeporn'
    ];

// Strict host matcher. The implementation lives in shared/host-keywords.js
// (matchesAdultKeywordHost) so background.js and content.js agree on the
// same whole-label / hyphen-bounded rules and the same keyword list. This
// wrapper adds a small per-hostname cache.
function hostnameMatchesAdultKeywords(hostname) {
  if (typeof keywordCheckCache !== 'undefined' && keywordCheckCache.has(hostname)) {
    return keywordCheckCache.get(hostname);
  }
  const result = (typeof HostBlockKeywords !== 'undefined' && HostBlockKeywords.matchesAdultKeywordHost)
    ? HostBlockKeywords.matchesAdultKeywordHost(hostname)
    : hostnameMatchesAdultKeywordsFallback(hostname);
  if (typeof keywordCheckCache !== 'undefined') {
    addToCache(keywordCheckCache, hostname, result);
  }
  return result;
}

// ASCII-only fallback for environments where the shared module is absent
// (e.g. when importScripts failed). Mirrors the strict matcher in
// shared/host-keywords.js.
function hostnameMatchesAdultKeywordsFallback(hostname) {
  if (!hostname) return false;
  const labels = String(hostname).split('.');
  for (const label of labels) {
    if (!label) continue;
    const lowerLabel = label.toLowerCase();
    for (const k of ADULT_HOST_KEYWORDS) {
      if (!k) continue;
      if (lowerLabel === k) return true;
      if (lowerLabel.endsWith('-' + k)) return true;
      if (lowerLabel.startsWith(k + '-')) return true;
    }
  }
  return false;
}

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await browserAPI.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(newSettings) {
  await browserAPI.storage.local.set({ [SETTINGS_KEY]: newSettings });
}

/**
 * Persist any missing defaults, but ONLY when something is actually missing.
 *
 * This used to be an unconditional `setSettings(await getSettings())` on every
 * background start. storage.local.set fires storage.onChanged whether or not
 * the value changed, and that event has two expensive subscribers: this file
 * (rebuildCompiledPatterns + checkExtensionStateChange + updateDnrRules) and
 * every content script in every open tab (loadSettings + a full
 * processContent). Firefox and Chrome both suspend an idle MV3 background, so
 * every wake-up re-ran initialization here and forced a full page re-scan in
 * each open tab — the cost scaling with how many tabs the user had open.
 *
 * A wake must be observationally silent: starting up is not a settings change.
 */
async function ensureSettingsDefaults() {
  const { [SETTINGS_KEY]: stored } = await browserAPI.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!settingsEqual(stored, merged)) {
    await browserAPI.storage.local.set({ [SETTINGS_KEY]: merged });
  }
  return merged;
}

function settingsEqual(stored, merged) {
  if (!stored || typeof stored !== 'object') return false;
  const storedKeys = Object.keys(stored);
  const mergedKeys = Object.keys(merged);
  // A key present in defaults but absent from storage must still be written,
  // which is what makes this safe for profiles that predate a new setting.
  if (storedKeys.length !== mergedKeys.length) return false;
  for (const key of mergedKeys) {
    const a = stored[key];
    const b = merged[key];
    if (a === b) continue;
    // Arrays (customPatterns, trustedImageDomains) need a value comparison.
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

async function getStats() {
  const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
  return { ...DEFAULT_STATS, ...(stats || {}) };
}

async function setStats(newStats) {
  await browserAPI.storage.local.set({ [BLOCKED_STATS_KEY]: newStats });
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: whitelist } = await browserAPI.storage.local.get(WHITELIST_KEY);
  return whitelist || [];
}

// ============================================
// AUDIT LOGGING SYSTEM
// ============================================

// ============================================
// BLOCK EVENT BATCHING
// ============================================
//
// One blocked image used to cost roughly eleven storage/IPC round-trips:
// updateStats (2 reads + 1 write), logBlockedPage (a read of a 1000-entry
// array, a filter over it, a write, then updateTopDomains' read + sort + write
// and updateDailyHistory's read + write) and bumpTabBadge (a badge read and two
// writes). None of them awaited each other, so a page that blocked forty images
// issued hundreds of concurrent transactions — and, being unserialised
// read-modify-writes on shared keys, they also lost counts.
//
// Firefox's storage.local is IndexedDB-backed and commits each set as its own
// transaction against the same disk the page is loading from, which is why this
// read as whole-machine lag rather than one slow tab.
//
// Everything accumulates in memory and commits in a single write. Batching is
// also what makes the counters correct: one reader, one writer, no interleaving.
const BLOCK_FLUSH_MS = 1500;
const BADGE_FLUSH_MS = 250;
const PENDING_AUDIT_MAX = AUDIT_MAX_ENTRIES;

const pendingBlocks = {
  stats: Object.create(null),      // stat type -> count
  audit: [],                       // {url, timestamp, reason}
  domains: Object.create(null),    // hostname -> count
  days: Object.create(null),       // YYYY-MM-DD -> count
  lastWebsiteBlocked: null,
  lastBlockedAt: null
};
const pendingBadges = new Map();   // tabId -> delta
let blockFlushTimer = null;
let badgeFlushTimer = null;
// Serialised so two flushes can never interleave their read-modify-write.
let blockFlushChain = Promise.resolve();

function hasPendingBlocks() {
  return pendingBlocks.audit.length > 0 ||
    Object.keys(pendingBlocks.stats).length > 0 ||
    Object.keys(pendingBlocks.domains).length > 0 ||
    Object.keys(pendingBlocks.days).length > 0;
}

/**
 * Record one block. Cheap and synchronous: no storage, no IPC.
 */
function queueBlockEvent(type, { url = '', title = '', reason = '', tabId, count = 1 } = {}) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  pendingBlocks.stats[type] = (pendingBlocks.stats[type] || 0) + 1;
  pendingBlocks.lastBlockedAt = new Date().toISOString();

  if (type === 'website_blocked') {
    pendingBlocks.lastWebsiteBlocked = {
      url, title, reason, timestamp: pendingBlocks.lastBlockedAt
    };
  }

  if (url) {
    pendingBlocks.audit.push({ url, timestamp: Date.now(), reason: reason || type });
    // Bounded in memory as well as on disk, so a hostile page cannot grow this
    // between flushes. The tail is what the log keeps anyway.
    if (pendingBlocks.audit.length > PENDING_AUDIT_MAX) {
      pendingBlocks.audit.splice(0, pendingBlocks.audit.length - PENDING_AUDIT_MAX);
    }
    const domain = auditDomainFor(url);
    if (domain) pendingBlocks.domains[domain] = (pendingBlocks.domains[domain] || 0) + 1;
    const day = new Date().toISOString().slice(0, 10);
    pendingBlocks.days[day] = (pendingBlocks.days[day] || 0) + 1;
  }

  if (typeof tabId === 'number' && tabId >= 0) {
    pendingBadges.set(tabId, (pendingBadges.get(tabId) || 0) + n);
    if (!badgeFlushTimer) badgeFlushTimer = setTimeout(flushBadges, BADGE_FLUSH_MS);
  }

  if (!blockFlushTimer) blockFlushTimer = setTimeout(flushBlockEvents, BLOCK_FLUSH_MS);
}

function auditDomainFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function flushBlockEvents() {
  if (blockFlushTimer) { clearTimeout(blockFlushTimer); blockFlushTimer = null; }
  blockFlushChain = blockFlushChain
    .then(commitPendingBlocks)
    .catch(error => console.error('BlockNSFW: failed to flush block events', error));
  return blockFlushChain;
}

async function commitPendingBlocks() {
  if (!hasPendingBlocks()) return;

  // Take the buffer first: anything recorded while this awaits belongs to the
  // next flush, not this one, and must not be dropped by the reset below.
  const batch = {
    stats: pendingBlocks.stats,
    audit: pendingBlocks.audit,
    domains: pendingBlocks.domains,
    days: pendingBlocks.days,
    lastWebsiteBlocked: pendingBlocks.lastWebsiteBlocked,
    lastBlockedAt: pendingBlocks.lastBlockedAt
  };
  pendingBlocks.stats = Object.create(null);
  pendingBlocks.audit = [];
  pendingBlocks.domains = Object.create(null);
  pendingBlocks.days = Object.create(null);
  pendingBlocks.lastWebsiteBlocked = null;
  pendingBlocks.lastBlockedAt = null;

  const totalEvents = Object.values(batch.stats).reduce((sum, n) => sum + n, 0);

  // ONE read and ONE write for the whole batch, where there used to be five
  // read-modify-write pairs per blocked element.
  const store = await browserAPI.storage.local.get([
    BLOCKED_STATS_KEY, DAILY_STATS_KEY, AUDIT_BLOCKED_KEY, TOP_DOMAINS_KEY, DAILY_HISTORY_KEY
  ]);

  const stats = { ...DEFAULT_STATS, ...(store[BLOCKED_STATS_KEY] || {}) };
  stats.blockedCount = (stats.blockedCount || 0) + totalEvents;
  if (batch.lastBlockedAt) stats.lastBlocked = batch.lastBlockedAt;
  if (batch.lastWebsiteBlocked) stats.lastWebsiteBlocked = batch.lastWebsiteBlocked;
  for (const [type, n] of Object.entries(batch.stats)) {
    const field = STAT_FIELD_BY_TYPE[type];
    if (field) stats[field] = (stats[field] || 0) + n;
  }

  // toDateString(), not an ISO date: popup.js compares this field against
  // `new Date().toDateString()` and treats any mismatch as a new day, so an
  // ISO key here would make the popup read zero all day.
  const today = new Date().toDateString();
  const storedDaily = store[DAILY_STATS_KEY] || {};
  const daily = storedDaily.date === today
    ? { ...storedDaily }
    : {
        date: today, blockedToday: 0, websiteBlocked: 0, imageBlocked: 0,
        imageAiBlocked: 0, searchResultBlocked: 0,
        videoBlocked: 0, iframeBlocked: 0, socialPostBlocked: 0
      };
  daily.blockedToday = (daily.blockedToday || 0) + totalEvents;
  for (const [type, n] of Object.entries(batch.stats)) {
    const field = DAILY_FIELD_BY_TYPE[type];
    if (field) daily[field] = (daily[field] || 0) + n;
  }

  const cutoff = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let auditLog = (store[AUDIT_BLOCKED_KEY] || []).concat(batch.audit)
    .filter(item => item && item.timestamp >= cutoff);
  if (auditLog.length > AUDIT_MAX_ENTRIES) auditLog = auditLog.slice(-AUDIT_MAX_ENTRIES);

  const domains = { ...(store[TOP_DOMAINS_KEY] || {}) };
  for (const [domain, n] of Object.entries(batch.domains)) {
    domains[domain] = (domains[domain] || 0) + n;
  }
  const topDomains = Object.fromEntries(
    Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 100)
  );

  const history = { ...(store[DAILY_HISTORY_KEY] || {}) };
  for (const [day, n] of Object.entries(batch.days)) {
    history[day] = (history[day] || 0) + n;
  }
  const historyCutoff = new Date();
  historyCutoff.setDate(historyCutoff.getDate() - 30);
  const historyCutoffKey = historyCutoff.toISOString().slice(0, 10);
  for (const day of Object.keys(history)) {
    if (day < historyCutoffKey) delete history[day];
  }

  await browserAPI.storage.local.set({
    [BLOCKED_STATS_KEY]: stats,
    [DAILY_STATS_KEY]: daily,
    [AUDIT_BLOCKED_KEY]: auditLog,
    [TOP_DOMAINS_KEY]: topDomains,
    [DAILY_HISTORY_KEY]: history
  });
}

// Every block type content.js can report needs an entry in BOTH maps, or the
// event lands in the grand total with no line of its own. tests/message-
// contract.test.js asserts the two maps and the listener stay in step with
// what the content script actually sends.
const STAT_FIELD_BY_TYPE = {
  website_blocked: 'websiteBlockedCount',
  image_filtered: 'imageBlockedCount',
  image_ai_filtered: 'aiImageBlockedCount',
  search_result_filtered: 'searchResultBlockedCount',
  video_filtered: 'videoBlockedCount',
  iframe_filtered: 'iframeBlockedCount',
  social_post_filtered: 'socialPostBlockedCount'
};

const DAILY_FIELD_BY_TYPE = {
  website_blocked: 'websiteBlocked',
  image_filtered: 'imageBlocked',
  image_ai_filtered: 'imageAiBlocked',
  search_result_filtered: 'searchResultBlocked',
  video_filtered: 'videoBlocked',
  iframe_filtered: 'iframeBlocked',
  social_post_filtered: 'socialPostBlocked'
};

/**
 * Apply the accumulated badge deltas, one read and one write per tab rather
 * than three API calls per blocked element. bumpTabBadge still reads the badge
 * back rather than keeping its own tally, because the worker is torn down while
 * the badge text the browser is drawing survives.
 */
async function flushBadges() {
  badgeFlushTimer = null;
  const batch = new Map(pendingBadges);
  pendingBadges.clear();
  for (const [tabId, delta] of batch) {
    await bumpTabBadge(tabId, delta);
  }
}

// Commit before the browser tears the background down, so the tail of a session
// is not lost. Both Firefox event pages and Chrome service workers fire this.
try {
  browserAPI.runtime.onSuspend.addListener(() => {
    flushBadges();
    flushBlockEvents();
  });
} catch (_) {
  // Not implemented in this build; the timers still commit during normal use.
}

// Track extension state for disable event logging
let lastExtensionState = null;
let extensionDisabledTime = null;







// Log extension state change (enable/disable)
async function logExtensionStateChange(enabled, method = 'Manual toggle') {
  try {
    const { [AUDIT_DISABLED_KEY]: disabledLog } = await browserAPI.storage.local.get(AUDIT_DISABLED_KEY);
    let log = disabledLog || [];

    const timestamp = Date.now();

    if (!enabled) {
      extensionDisabledTime = timestamp;
      await handleStreakBreak();
    }

    let duration = null;
    if (enabled && extensionDisabledTime) {
      duration = timestamp - extensionDisabledTime;
      extensionDisabledTime = null;
    }

    const entry = {
      enabled: enabled,
      timestamp: timestamp,
      method: method,
      duration: duration,
      endTimestamp: enabled && extensionDisabledTime ? timestamp : null
    };

    log.push(entry);

    const cutoffDate = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    log = log.filter(item => item.timestamp >= cutoffDate);

    if (log.length > AUDIT_MAX_ENTRIES) {
      log = log.slice(-AUDIT_MAX_ENTRIES);
    }

    await browserAPI.storage.local.set({ [AUDIT_DISABLED_KEY]: log });
  } catch (error) {
    console.error('BlockNSFW: Failed to log extension state change', error);
  }
}

async function handleStreakBreak() {
  try {
    const { [STREAK_START_KEY]: streakStart, [LONGEST_STREAK_KEY]: longestStreak } = 
      await browserAPI.storage.local.get([STREAK_START_KEY, LONGEST_STREAK_KEY]);

    if (streakStart) {
      const currentStreak = Math.floor((Date.now() - streakStart) / (24 * 60 * 60 * 1000));
      
      if (!longestStreak || currentStreak > longestStreak) {
        await browserAPI.storage.local.set({ [LONGEST_STREAK_KEY]: currentStreak });
      }

      await browserAPI.storage.local.remove(STREAK_START_KEY);
    }
  } catch (error) {
    console.error('BlockNSFW: Failed to handle streak break', error);
  }
}

async function initializeExtensionStateTracking() {
  const settings = await getSettings();
  lastExtensionState = settings.enabled;

  if (settings.enabled) {
    const { [STREAK_START_KEY]: existing } = await browserAPI.storage.local.get(STREAK_START_KEY);
    if (!existing) {
      await browserAPI.storage.local.set({ [STREAK_START_KEY]: Date.now() });
    }
  }
}

// Check for extension state changes
async function checkExtensionStateChange() {
  const settings = await getSettings();
  const currentState = settings.enabled;

  if (lastExtensionState !== null && lastExtensionState !== currentState) {
    // State changed - log it
    await logExtensionStateChange(currentState, 'Manual toggle');
  }

  lastExtensionState = currentState;
}

// ============================================
// END AUDIT LOGGING SYSTEM
// ============================================

async function cleanExpiredWhitelist() {
  const whitelist = await getWhitelist();
  const now = Date.now();
  const cleaned = whitelist.filter(item => 
    item.type === 'permanent' || (item.expiresAt && item.expiresAt > now)
  );
  
  if (cleaned.length !== whitelist.length) {
    await browserAPI.storage.local.set({ [WHITELIST_KEY]: cleaned });
  }
  
  return cleaned;
}

async function isWhitelisted(url) {
  try {
    const whitelist = await cleanExpiredWhitelist();
    if (whitelist.length === 0) return false;

    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');
    const pathname = urlObj.pathname || '/';
    // Path scoping lives in shared/validate-domain.js. If that failed to load
    // (e.g. importScripts unavailable), fall back to allowing only whole-domain
    // entries so a path-scoped entry can never accidentally allow everything.
    const pathMatches = (self.DomainValidate && self.DomainValidate.whitelistPathMatches)
      ? self.DomainValidate.whitelistPathMatches
      : (_p, storedPath) => !storedPath;

    // Use for loop for better performance and early exit
    for (let i = 0; i < whitelist.length; i++) {
      const item = whitelist[i];
      const whitelistDomain = item.domain.replace(/^www\./, '');

      // Host must match first (exact, then subdomain).
      const hostOk = hostname === whitelistDomain || hostname.endsWith('.' + whitelistDomain);
      if (!hostOk) continue;

      // A whole-domain entry (no path) allows the whole host; a path-scoped
      // entry only allows matching paths. On a path miss keep scanning — another
      // entry for the same host may still match.
      if (pathMatches(pathname, item.path)) return true;
    }

    return false;
  } catch (error) {
    console.error('BlockNSFW: Error checking whitelist', error);
    return false;
  }
}

async function loadDefaultBlocklist() {
  try {
    const cachedDomains = await loadBlocklistFromCache();
    if (Array.isArray(cachedDomains) && cachedDomains.length > 0) {
      defaultBlocklist = cachedDomains;
      defaultBlocklistSet = new Set(defaultBlocklist);
      console.log(`BlockNSFW: Loaded ${cachedDomains.length} domains from cached blocklist`);
      const meta = blocklistMeta || (await loadBlocklistMeta());
      if (meta && meta.updatedAt && (Date.now() - meta.updatedAt) > BLOCKLIST_CACHE_TTL) {
        ensureRemoteBlocklistUpToDate().catch(error => console.warn('BlockNSFW: background refresh failed', error));
      }
      return;
    }
  } catch (error) {
    console.warn('BlockNSFW: failed to load cached blocklist', error);
  }

  try {
    const res = await fetch(browserAPI.runtime.getURL('blocklist.json'));
    const list = await res.json();
    defaultBlocklist = Array.isArray(list) ? list.map(normalizeDomainForCache).filter(isLikelyDomain) : [];
    defaultBlocklistSet = new Set(defaultBlocklist);
    console.log(`BlockNSFW: Loaded ${defaultBlocklist.length} domains from packaged blocklist`);

    // A fresh release already carries a curated current snapshot. Mark it
    // fresh so installation does not immediately download and rebuild the same
    // multi-megabyte data while the first browsing pages are rendering.
    const previousMeta = blocklistMeta || (await loadBlocklistMeta());
    if (!previousMeta) {
      // Write the bundled snapshot into the chunk cache, then backdate it to the
      // build time so PR #22's deferred remote refresh still holds.
      //
      // Declaring chunkCount: 0 instead — as this did — makes
      // loadBlocklistFromCache() report "no cache", so every subsequent wake
      // fell back to fetch(blocklist.json) + JSON.parse of 4.1 MB + normalizing
      // 204k domains, while ensureRemoteBlocklistUpToDate() returned early
      // because the metadata was not stale. The chunk cache, whose entire
      // purpose is to make a wake cheap, was never populated at all.
      const meta = await storeBlocklistInCache(defaultBlocklist);
      if (meta) {
        meta.source = 'bundled';
        meta.updatedAt = BUNDLED_BLOCKLIST_BUILT_AT || Date.now();
        blocklistMeta = meta;
        await browserAPI.storage.local.set({ [BLOCKLIST_CACHE_META_KEY]: meta });
      } else {
        blocklistMeta = {
          updatedAt: BUNDLED_BLOCKLIST_BUILT_AT || Date.now(),
          chunkCount: 0,
          version: 1,
          source: 'bundled',
          domainCount: defaultBlocklist.length
        };
        await browserAPI.storage.local.set({ [BLOCKLIST_CACHE_META_KEY]: blocklistMeta });
      }
    } else {
      // Preserve the original bundled timestamp across restarts so its normal
      // TTL can expire and trigger a remote refresh.
      blocklistMeta = previousMeta;
    }
  } catch (e) {
    defaultBlocklist = [];
    defaultBlocklistSet = new Set();
    console.error('BlockNSFW: failed to load packaged blocklist', e);
  }

  ensureRemoteBlocklistUpToDate().catch(error => console.warn('BlockNSFW: remote blocklist sync deferred', error));
}

/**
 * Strip comment lines and unescape the rest before a stored list reaches any
 * matcher. Mirrors content.js — both defer to shared/keyword-pattern.js so the
 * two sides cannot disagree about what counts as a comment.
 */
function liveListEntries(list) {
  if (!Array.isArray(list)) return [];
  if (typeof KeywordPattern !== 'undefined' && KeywordPattern.effectiveEntries) {
    return KeywordPattern.effectiveEntries(list);
  }
  return list
    .map((entry) => String(entry == null ? '' : entry).trim())
    .filter((entry) => entry && entry.charAt(0) !== '#' && entry.charAt(0) !== '!');
}

async function rebuildCompiledPatterns() {
  // Clear caches when rebuilding patterns
  clearAllCaches();
  
  const settings = await getSettings();
  const patternSources = [];

  // loadDefaultBlocklist/remote refresh already own the normalized default
  // Set. Rewalking 200k+ domains here on every startup or settings change was
  // redundant and particularly costly in Firefox's extension process.
  // liveListEntries drops the user's comment lines: a '# note' compiled into a
  // host pattern would block whatever domain the note happened to mention.
  const customPatterns = liveListEntries(settings.customPatterns);
  for (let i = 0; i < customPatterns.length; i++) {
    if (customPatterns[i]) patternSources.push(customPatterns[i]);
  }

  // Subscribed lists compile into the same set the user's own entries do. They
  // can only ever add to it: nothing downstream of here can remove a block.
  const subscribed = await getActiveSubscriptionEntries();
  for (let i = 0; i < subscribed.length; i++) {
    if (subscribed[i]) patternSources.push(subscribed[i]);
  }

  const uniquePatterns = [...new Set(patternSources)];
  compiledPatterns = buildHostPatterns(uniquePatterns);
  
  console.log(
    `BlockNSFW: Compiled ${compiledPatterns.length} URL patterns with ${defaultBlocklistSet.size} host entries`
  );
}

function urlMatchesCompiled(urlStr) {
  // Early exit optimization - use for loop instead of some() for better performance
  for (let i = 0; i < compiledPatterns.length; i++) {
    if (compiledPatterns[i].test(urlStr)) {
      return true;
    }
  }
  return false;
}

function isHttpUrl(urlStr) {
  return urlStr.startsWith('http://') || urlStr.startsWith('https://');
}

function isTrustedImageDomain(urlStr, trustedDomains) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    
    // Check against default trusted domains
    for (const domain of DEFAULT_TRUSTED_IMAGE_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    
    // Check against user-configured trusted domains
    for (const domain of trustedDomains) {
      const cleanDomain = domain.toLowerCase().replace(/^www\./, '');
      const cleanHostname = hostname.replace(/^www\./, '');
      if (cleanHostname === cleanDomain || cleanHostname.endsWith('.' + cleanDomain)) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

function isUrlInDefaultBlocklist(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    const normalized = normalizeDomainForCache(hostname);
    if (!normalized) return false;
    
    // Exact match (fastest)
    if (defaultBlocklistSet.has(normalized)) {
      return true;
    }
    
    // Parent-domain matching, skipping shared CDN parents
    const labels = normalized.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      if (isSharedCDNParent(candidate)) continue;
      if (defaultBlocklistSet.has(candidate)) {
        return true;
      }
    }

  } catch (error) {
    // Ignore parsing errors and treat as not blocked
  }
  return false;
}

// DNS-over-HTTPS filtering. The roster of resolvers, the wireformat codec and
// the tri-state query live in shared/dns-providers.js; this half owns caching,
// failover between two providers, and not hammering a provider that is down.
const dnsCache = new Map();
const DNS_CACHE_TTL = 3600000; // 1 hour
const DNS_CACHE_MAX = 2000;
const DNS_TIMEOUT_MS = 3000;

// A resolver that is unreachable or rate-limiting us would otherwise add a full
// DNS_TIMEOUT_MS stall to every navigation, because nothing remembers that the
// last twenty lookups all timed out. After this many consecutive no-answers we
// stop asking it until the cooldown expires and let the partner carry the load.
const DNS_PROVIDER_FAILURE_LIMIT = 3;
const DNS_PROVIDER_COOLDOWN_MS = 300000; // 5 minutes
const dnsProviderHealth = new Map(); // providerId -> { failures, mutedUntil }

// Two different custom endpoints both answer to the id 'custom', so keying on
// the id alone would serve one resolver's verdicts for the other. Presets keep
// their short id; a custom one is identified by its endpoint.
function dnsProviderKey(provider) {
  return provider.custom ? `custom|${provider.doh}` : provider.id;
}

function dnsCacheKey(providerId, hostname) {
  // Keyed by provider: two resolvers disagree about plenty of domains, so a
  // verdict from the old provider must not survive the user switching.
  return `${providerId}|${hostname}`;
}

function isDnsCacheBlocked(providerId, hostname) {
  const key = dnsCacheKey(providerId, hostname);
  const entry = dnsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    dnsCache.delete(key);
    return undefined;
  }
  return entry.blocked;
}

function rememberDnsVerdict(providerId, hostname, blocked) {
  dnsCache.set(dnsCacheKey(providerId, hostname), {
    blocked,
    expiresAt: Date.now() + DNS_CACHE_TTL,
  });
  if (dnsCache.size > DNS_CACHE_MAX) {
    const oldest = dnsCache.keys().next().value;
    dnsCache.delete(oldest);
  }
}

function isDnsProviderMuted(providerId) {
  const health = dnsProviderHealth.get(providerId);
  if (!health || !health.mutedUntil) return false;
  if (Date.now() >= health.mutedUntil) {
    dnsProviderHealth.delete(providerId); // cooldown served, give it another go
    return false;
  }
  return true;
}

function noteDnsProviderResult(providerId, answered) {
  if (answered) {
    dnsProviderHealth.delete(providerId);
    return;
  }
  const health = dnsProviderHealth.get(providerId) || { failures: 0, mutedUntil: 0 };
  health.failures += 1;
  if (health.failures >= DNS_PROVIDER_FAILURE_LIMIT) {
    health.mutedUntil = Date.now() + DNS_PROVIDER_COOLDOWN_MS;
    health.failures = 0;
  }
  dnsProviderHealth.set(providerId, health);
}

// Ask one provider, respecting its cache entry and its cooldown. Returns the
// same tri-state as queryProvider: true / false / null (no answer).
async function askDnsProvider(provider, hostname) {
  if (!provider) return null;
  const key = dnsProviderKey(provider);
  const cached = isDnsCacheBlocked(key, hostname);
  if (cached !== undefined) return cached;
  if (isDnsProviderMuted(key)) return null;

  const verdict = await self.DnsProviders.queryProvider(provider, hostname, DNS_TIMEOUT_MS);
  noteDnsProviderResult(key, verdict !== null);
  if (verdict !== null) rememberDnsVerdict(key, hostname, verdict);
  return verdict;
}

/**
 * Can a public resolver meaningfully answer for this hostname?
 *
 * No, for anything that does not exist in public DNS: `localhost`, a bare
 * intranet label, a reserved local TLD (`app.test`, `nas.local`), a private or
 * loopback address, or an IP literal of any kind. Those all come back NXDOMAIN,
 * and interpret() in shared/dns-providers.js reads NXDOMAIN as "this domain is
 * filtered" — which is correct for a resolver that sinkholes by refusing to
 * answer, and catastrophic here: with DNS Protection on it blocked every local
 * development server on every load, and every intranet host with it.
 *
 * The shared predicate is mirrored in a fallback because importScripts can fail
 * (see the top of this file). Guessing "not checkable" when the helper is
 * missing is the safe direction: the cost is one skipped DNS lookup, where the
 * cost of the opposite is a browser that cannot reach localhost.
 */
function isDnsCheckableHost(hostname) {
  const helpers = self.HostnameNormalize;
  if (helpers && helpers.isLocalHostname && helpers.isIpLiteral) {
    return !helpers.isLocalHostname(hostname) && !helpers.isIpLiteral(hostname);
  }
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
  if (!host || !host.includes('.')) return false;
  if (host.includes(':')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  return !/\.(?:localhost|local|test|example|invalid|internal|home\.arpa)$/.test(host);
}

/**
 * Is this hostname filtered by the user's chosen DNS resolver?
 *
 * Consults the selected provider, and on a *no-answer* (timeout, HTTP error,
 * SERVFAIL) falls through to a second provider on a different network. A plain
 * "not blocked" is an answer and ends the lookup — we only fail over when
 * nobody answered, otherwise the fallback would get a veto over the primary's
 * verdict and the user's provider choice would mean nothing.
 *
 * Returns null when neither provider answers, so the caller can tell "both
 * resolvers say this is fine" apart from "nobody answered" and decline to
 * cache the latter. Treating a failed lookup as a clean bill of health is how
 * a five-second outage turns into a domain that stays unblocked all session.
 */
async function checkDnsFilter(hostname, providerId, customUrl) {
  if (!self.DnsProviders) return null;
  // Never ask about a name public DNS cannot have a record for; see
  // isDnsCheckableHost. Answered false rather than null because "no DNS
  // filter blocks this" is a definite verdict for a local name, and the
  // caller should cache it as one instead of re-deciding every navigation.
  if (!isDnsCheckableHost(hostname)) return false;

  const primary = self.DnsProviders.resolveProvider(providerId, customUrl);
  const primaryVerdict = await askDnsProvider(primary, hostname);
  if (primaryVerdict !== null) return primaryVerdict;

  const fallback = self.DnsProviders.getFallbackProvider(primary.id);
  return await askDnsProvider(fallback, hostname);
}

async function shouldBlock(urlStr) {
  if (!isHttpUrl(urlStr)) return false;

  // Cold-start safety: if the service worker just woke up and the blocklist
  // hasn't finished loading, wait for init to complete before deciding.
  // After the first ready-resolve this branch is a single boolean check.
  if (!isReady) {
    await initReady;
  }

  // AGGRESSIVE CACHING OPTIMIZATION: Check URL cache first (with cache version for invalidation)
  const cacheKey = `${urlStr}_${cacheVersion}`;
  const cachedResult = urlCheckCache.get(cacheKey);
  if (cachedResult !== undefined) {
    return cachedResult;
  }
  
  const u = new URL(urlStr);
  // never block extension pages
  if (u.protocol === 'moz-extension:' || u.protocol === 'chrome-extension:') {
    urlCheckCache.set(cacheKey, false);
    return false;
  }

  // Check whitelist first - if whitelisted, never block
  if (await isWhitelisted(urlStr)) {
    urlCheckCache.set(cacheKey, false);
    return false;
  }

  // Check remote global whitelist (managed via GitHub)
  if (isInRemoteWhitelist(u.hostname)) {
    urlCheckCache.set(cacheKey, false);
    return false;
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    urlCheckCache.set(cacheKey, false);
    return false;
  }

  let shouldBlockResult = false;
  
  const hostname = u.hostname.toLowerCase();
  if (isUrlInDefaultBlocklist(urlStr)) {
    shouldBlockResult = true;
  } else if (!shouldBlockResult && urlMatchesCompiled(urlStr)) {
    shouldBlockResult = true;
  } else if (!shouldBlockResult && settings.useSmartBlocking && hostnameMatchesAdultKeywords(hostname)) {
    shouldBlockResult = true;
  }

  // DNS-over-HTTPS check via the user's chosen filtering resolver (runs only
  // if nothing else caught it).
  let dnsAnswered = true;
  if (!shouldBlockResult && settings.dnsFilterEnabled) {
    try {
      const verdict = await checkDnsFilter(hostname, settings.dnsProvider, settings.dnsCustomUrl);
      if (verdict === null) dnsAnswered = false;
      else shouldBlockResult = verdict;
    } catch (_) {
      // DNS failure should never break browsing
      dnsAnswered = false;
    }
  }

  // Cache the result aggressively — but never cache a "not blocked" that only
  // means the resolvers were unreachable, or a brief outage would whitelist the
  // domain for the rest of this service worker's life.
  if (dnsAnswered) {
    urlCheckCache.set(cacheKey, shouldBlockResult);
    limitCacheSize(urlCheckCache, MAX_CACHE_SIZE);
  }
  return shouldBlockResult;
}

function handleBlock(urlStr, type = 'blocked', reason = 'Pattern match') {
  // Audit logging is for page-level blocks only, as before: passing no url for
  // the other types is what keeps them out of the log.
  const auditable = type === 'website_blocked' || type === 'blocked';
  queueBlockEvent(type, { url: auditable ? urlStr : '', reason });
}

// Message listener for content script communications
// --- Toolbar badge: what this tab blocked -----------------------------------
// Ambient proof the extension is working even when nothing visible happens,
// which is the job the per-result card used to do on search pages.

const BADGE_CAP = 99;
const BADGE_CAP_TEXT = '99+';

/**
 * Read the badge back from the browser rather than keeping a per-tab tally in a
 * variable. Under MV3 the service worker is torn down after ~30s idle, which
 * would reset a Map while the badge text itself survives — the count would jump
 * from "12" to "1" on the next block. The badge is its own source of truth.
 */
// The display preference is read once and cached: bumpTabBadge is called for
// every blocked image on a scrolling page, and a storage round-trip per block
// would be a lot of churn for a setting that changes once in a blue moon.
let cachedBlockCountDisplay = null;

async function getBlockCountDisplay() {
  if (cachedBlockCountDisplay) return cachedBlockCountDisplay;
  try {
    const settings = await getSettings();
    cachedBlockCountDisplay = settings.blockCountDisplay === 'floating' ? 'floating' : 'badge';
  } catch (_) {
    cachedBlockCountDisplay = 'badge';
  }
  return cachedBlockCountDisplay;
}

async function bumpTabBadge(tabId, by) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  // With the count in the page there must be nothing on the icon, or the same
  // blocks get reported twice in two places.
  if (await getBlockCountDisplay() !== 'badge') return;
  const increment = Number.isFinite(by) && by > 0 ? Math.floor(by) : 1;
  try {
    const current = await browserAPI.action.getBadgeText({ tabId });
    if (current === BADGE_CAP_TEXT) return; // already capped; stop counting
    const total = (parseInt(current, 10) || 0) + increment;
    await browserAPI.action.setBadgeText({
      tabId,
      text: total > BADGE_CAP ? BADGE_CAP_TEXT : String(total)
    });
    await browserAPI.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
  } catch (_) {
    // Badge support varies (and getBadgeText is unavailable on some Firefox
    // versions). Never let a cosmetic counter break the block that triggered it.
  }
}

/**
 * Wipe every tab's badge — used when the count moves into the page, so a number
 * left on the icon does not sit there permanently reporting a stale total.
 */
async function clearAllTabBadges() {
  try {
    const tabs = await browserAPI.tabs.query({});
    for (const tab of tabs) clearTabBadge(tab.id);
  } catch (_) {
    // tabs.query unavailable; the badges will clear on their next navigation.
  }
}

function clearTabBadge(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    const result = browserAPI.action.setBadgeText({ tabId, text: '' });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {}
}

// A committed navigation starts a fresh count. Two signals, because neither is
// available everywhere: `changeInfo.url` catches history-driven navigation (how
// search engines switch verticals) but is withheld from Firefox without the
// "tabs" permission, which this extension does not request; `status === 'loading'`
// needs no permission but only fires on a real page load.
try {
  browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo) return;
    if (typeof changeInfo.url === 'string' || changeInfo.status === 'loading') {
      clearTabBadge(tabId);
    }
  });
} catch (_) {
  // tabs.onUpdated unavailable in this build; the badge just accumulates.
}

// The page a block happened on: the content script reports it, but a message
// without one still has the sender's own URL.
function senderUrl(message, sender) {
  if (typeof message?.url === 'string' && message.url) return message.url;
  if (typeof sender?.url === 'string' && sender.url) return sender.url;
  return '';
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // A message that is not an object at all reached `message.type` below and
  // threw inside the listener, which in Chrome surfaces only as a rejected
  // send on the far side. Anything without a string type is not ours.
  if (!message || typeof message.type !== 'string') {
    // Except offscreen traffic, which is addressed by `target` and handled in
    // the offscreen document rather than here.
    return false;
  }
  // Messages addressed to the offscreen document are handled there, not here.
  if (message.target === 'offscreen-ai') return false;
  // The block notifications are the hot path — one message per blocked image
  // on a page that can hold hundreds. They only touch memory here; the storage
  // write happens once per batch. See queueBlockEvent.
  if (message.type === 'image_filtered') {
    queueBlockEvent('image_filtered', {
      url: senderUrl(message, sender),
      reason: 'Image filtered',
      tabId: sender?.tab?.id
    });
    sendResponse({ success: true });
  } else if (message.type === 'image_ai_filtered') {
    queueBlockEvent('image_ai_filtered', {
      url: senderUrl(message, sender),
      reason: 'AI image filtered',
      tabId: sender?.tab?.id
    });
    sendResponse({ success: true });
  } else if (message.type === 'website_blocked') {
    queueBlockEvent('website_blocked', {
      url: message.url,
      title: message.title,
      reason: message.reason || 'Pattern match',
      tabId: sender?.tab?.id
    });
    console.log(`BlockNSFW: Website blocked - ${message.url} (${message.reason})`);
    sendResponse({ success: true });
  } else if (message.type === 'search_result_filtered') {
    // The pass reports how many results it blocked; the badge counts all of
    // them, while the stats record the pass as a single event.
    queueBlockEvent('search_result_filtered', {
      url: senderUrl(message, sender),
      reason: 'Search results filtered',
      tabId: sender?.tab?.id,
      count: typeof message.count === 'number' ? message.count : 1
    });
    sendResponse({ success: true });
  } else if (message.type === 'video_filtered') {
    // content.js has always sent this; nothing here received it, so a blocked
    // video counted for nothing — not the badge, not the totals, not the
    // audit log. The in-page pill counted it (COUNTED_BLOCK_TYPES includes
    // 'video'), which is why the pill and the toolbar disagreed.
    queueBlockEvent('video_filtered', {
      url: senderUrl(message, sender),
      reason: 'Video filtered',
      tabId: sender?.tab?.id,
      count: typeof message.count === 'number' ? message.count : 1
    });
    sendResponse({ success: true });
  } else if (message.type === 'iframe_filtered') {
    // Sent with the frame's `src` rather than a count, so the page URL comes
    // from the sender. Same gap as video_filtered above.
    queueBlockEvent('iframe_filtered', {
      url: senderUrl(message, sender),
      reason: 'Embedded frame filtered',
      tabId: sender?.tab?.id
    });
    sendResponse({ success: true });
  } else if (message.type === 'social_post_filtered') {
    // Like the search pass, this reports how many posts one sweep hid: the
    // badge counts each post, the stats record the sweep once.
    queueBlockEvent('social_post_filtered', {
      url: senderUrl(message, sender),
      reason: 'Social posts filtered',
      tabId: sender?.tab?.id,
      count: typeof message.count === 'number' ? message.count : 1
    });
    sendResponse({ success: true });
  } else if (message.type === 'subscription_prefill' && typeof message.url === 'string') {
    // Opens Settings with the address filled in. Deliberately does not
    // subscribe: a link on a web page must never be able to add a list by
    // itself, only offer one.
    (async () => {
      try {
        if (!self.Ruleset || !self.Ruleset.isHttpUrl(message.url)) {
          sendResponse({ ok: false });
          return;
        }
        const optionsUrl = browserAPI.runtime.getURL('options.html') +
          '?subscribe=' + encodeURIComponent(message.url);
        await browserAPI.tabs.create({ url: optionsUrl });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'subscription_list') {
    (async () => {
      try {
        sendResponse({ success: true, subscriptions: await getSubscriptions() });
      } catch (error) {
        sendResponse({ success: false, error: error.message, subscriptions: [] });
      }
    })();
    return true;
  } else if (message.type === 'subscription_add') {
    (async () => {
      try {
        sendResponse(await addSubscription(message.url, message.name));
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'subscription_remove') {
    (async () => {
      try {
        sendResponse(await removeSubscription(message.id));
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'subscription_toggle') {
    (async () => {
      try {
        sendResponse(await setSubscriptionEnabled(message.id, message.enabled));
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'subscription_refresh') {
    (async () => {
      try {
        if (message.id) {
          sendResponse(await refreshSubscription(message.id, { force: true }));
        } else {
          const results = await refreshAllSubscriptions({ force: true });
          sendResponse({ ok: true, results });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'check_blocklist_hosts' && Array.isArray(message.hosts)) {
    (async () => {
      try {
        if (!isReady) await initReady;
        const hosts = message.hosts.slice(0, 1000);
        const blockedHosts = [];
        for (const rawHost of hosts) {
          const host = normalizeDomainForCache(rawHost);
          if (!host) continue;
          if (isUrlInDefaultBlocklist(`https://${host}/`)) blockedHosts.push(host);
        }
        sendResponse({ success: true, blockedHosts });
      } catch (error) {
        sendResponse({ success: false, blockedHosts: [], error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'get_update_info') {
    // Popup/options ask for the latest update verdict. Returns the cached info
    // immediately if fresh, otherwise refreshes (TTL-guarded). `forceRefresh`
    // backs a manual "check now" action.
    (async () => {
      try {
        const info = await checkForUpdate({ forceRefresh: message.forceRefresh === true });
        sendResponse({ success: true, info });
      } catch (error) {
        sendResponse({ success: false, error: error && error.message });
      }
    })();
    return true;
  } else if (message.type === 'check_dns_filter' && typeof message.hostname === 'string') {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.dnsFilterEnabled) {
          sendResponse({ blocked: false });
          return;
        }
        const blocked = await checkDnsFilter(message.hostname, settings.dnsProvider, settings.dnsCustomUrl);
        sendResponse({ blocked: blocked === true });
      } catch (_) {
        sendResponse({ blocked: false });
      }
    })();
    return true;
  } else if (message.type === 'should_block_url' && typeof message.url === 'string') {
    (async () => {
      try {
        if (!isReady) await initReady;
        const blocked = await shouldBlock(message.url);
        sendResponse({ success: true, blocked });
      } catch (error) {
        console.error('BlockNSFW: should_block_url failed', error);
        sendResponse({ success: false, blocked: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'refresh_remote_blocklist') {
    (async () => {
      try {
        const [blockResult] = await Promise.all([
          ensureRemoteBlocklistUpToDate({ forceRefresh: true }),
          ensureRemoteWhitelistUpToDate({ forceRefresh: true })
        ]);
        sendResponse({ success: true, meta: blockResult.meta, count: blockResult.domains?.length || 0 });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  } else if (message.type === 'ai_classify_image' && (message.data || message.src)) {
    (async () => {
      // Fast path: classify in the offscreen document on WebGL (GPU). If it
      // fails for any reason, fall back to the service-worker path so images
      // still get blocked (just slower).
      if (message.src && offscreenAvailable()) {
        try {
          await ensureOffscreenDocument();
          const requested = self.AiImageModels.resolveModel(message.model);
          let res = await sendToOffscreen({
            op: 'classify', src: message.src, model: requested.id
          }, classifyTimeoutFor(requested.id));
          let servedBy = requested.id;
          if ((!res || !res.success) && !requested.bundled) {
            // See classifyWithFallback: never degrade to unfiltered.
            const fallbackId = self.AiImageModels.DEFAULT_MODEL_ID;
            console.warn('[BlockNSFW] offscreen', requested.id, 'classify failed,',
              'falling back to', fallbackId + ':', res && res.error);
            res = await sendToOffscreen({
              op: 'classify', src: message.src, model: fallbackId
            }, classifyTimeoutFor(fallbackId));
            servedBy = fallbackId;
          }
          if (!res || !res.success) {
            throw new Error(res && res.error ? res.error : 'offscreen classify failed');
          }
          sendResponse({ success: true, scores: res.scores, model: servedBy });
          return;
        } catch (offErr) {
          console.warn('[BlockNSFW] offscreen classify failed, falling back to SW:',
            offErr && offErr.message || offErr);
        }
      }
      // Service-worker fallback (older Chrome/Firefox, or offscreen failure).
      try {
        let blob;
        if (message.data) {
          const arr = message.data;
          blob = new Blob([arr instanceof ArrayBuffer ? arr : new Uint8Array(arr)],
            { type: message.mimeType || 'image/jpeg' });
        } else {
          const resp = await fetch(message.src, {
            credentials: 'omit',
            cache: 'force-cache',
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          blob = await resp.blob();
        }
        const result = await classifyWithFallback(blob, message.model);
        sendResponse({ success: true, scores: result.scores, model: result.model });
      } catch (error) {
        console.warn('[BlockNSFW] SW classify failed:', error && error.message || error);
        sendResponse({ success: false, error: error.message || String(error) });
      }
    })();
    return true;
  } else if (message.type === 'ai_ping_model') {
    (async () => {
      // Warm up the offscreen model when available; fall back to the SW model.
      const requested = self.AiImageModels.resolveModel(message.model);
      const fallbackId = self.AiImageModels.DEFAULT_MODEL_ID;
      // Try the selected model, then the bundled one. A ping is the gate the
      // content script waits on before it will classify anything, so a ping
      // that reports "not ready" means the page goes completely unfiltered.
      // Getting *a* working classifier ready matters more than getting the
      // preferred one.
      const candidates = requested.bundled ? [requested.id] : [requested.id, fallbackId];
      // Why the SELECTED model failed, kept even when a fallback succeeds.
      // Without this the options page can see "ready" and no error at all, so
      // its download button appears to do nothing — the caller cannot tell
      // "downloaded" from "a different model is filling in".
      let requestedError = '';

      if (offscreenAvailable()) {
        try {
          await ensureOffscreenDocument();
          for (const candidateId of candidates) {
            const res = await sendToOffscreen({
              op: 'ping',
              forceRetry: message.forceRetry === true,
              model: candidateId
            }, pingTimeoutFor(candidateId));
            if (res && res.ready) {
              sendResponse({
                ready: true,
                backend: res.backend,
                model: candidateId,
                fellBackFrom: candidateId === requested.id ? null : requested.id,
                requestedError: candidateId === requested.id ? '' : requestedError
              });
              return;
            }
            const why = (res && res.error) || 'model not ready';
            if (candidateId === requested.id) requestedError = why;
            console.warn('[BlockNSFW] offscreen model not ready:', candidateId, why);
          }
          throw new Error('no model ready in offscreen document');
        } catch (offErr) {
          console.warn('[BlockNSFW] offscreen model ping failed, falling back to SW:',
            offErr && offErr.message || offErr);
        }
      }
      try {
        let readyId = null;
        let lastErr = null;
        for (const candidateId of candidates) {
          try {
            await loadAiModel({
              forceRetry: message.forceRetry === true,
              model: candidateId
            });
            readyId = candidateId;
            break;
          } catch (err) {
            lastErr = err;
            if (candidateId === requested.id) {
              requestedError = getAiModelErrorMessage(err);
            }
            console.warn('[BlockNSFW] SW model load failed:', candidateId,
              getAiModelErrorMessage(err));
          }
        }
        if (!readyId) throw lastErr || new Error('no model could be loaded');
        sendResponse({
          ready: true,
          backend: _aiModelBackend,
          model: readyId,
          fellBackFrom: readyId === requested.id ? null : requested.id,
          requestedError: readyId === requested.id ? '' : requestedError
        });
      } catch (error) {
        console.warn('[BlockNSFW] SW model load failed:', error && error.message || error);
        sendResponse({
          ready: false,
          error: error.message || String(error),
          retryAfterMs: getAiModelRetryAfterMs(Date.now(), message.model)
        });
      }
    })();
    return true;
  } else if (message.type === 'ai_model_status') {
    // Used by the options page to say whether a model's weights are already
    // local, and to show download progress while they are not.
    (async () => {
      const descriptor = self.AiImageModels.resolveModel(message.model);
      if (descriptor.bundled) {
        sendResponse({ success: true, model: descriptor.id, cached: true, bundled: true });
        return;
      }
      if (offscreenAvailable()) {
        try {
          await ensureOffscreenDocument();
          const res = await sendToOffscreen(
            { op: 'model_status', model: descriptor.id }, 15000);
          if (res && res.success) { sendResponse({ ...res, bundled: false }); return; }
        } catch (_) {}
      }
      try {
        const [cached, topology] = await Promise.all([
          self.VitClassifier.isCached(descriptor.id),
          self.VitClassifier.topologyStatus(descriptor.id)
        ]);
        sendResponse({
          success: true,
          model: descriptor.id,
          cached,
          bundled: false,
          available: topology.available,
          error: topology.error
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
      }
    })();
    return true;
  } else if (message.type === 'ai_clear_model_weights') {
    (async () => {
      const descriptor = self.AiImageModels.resolveModel(message.model);
      _aiModels.delete(descriptor.id);
      let cleared = false;
      if (offscreenAvailable()) {
        try {
          await ensureOffscreenDocument();
          const res = await sendToOffscreen(
            { op: 'clear_weights', model: descriptor.id }, 15000);
          cleared = !!(res && res.cleared);
        } catch (_) {}
      }
      if (!cleared) {
        try {
          cleared = await self.VitClassifier.clearCachedWeights(descriptor.id);
        } catch (_) {}
      }
      sendResponse({ success: true, cleared });
    })();
    return true;
  }
  // Nothing matched. Returning true here held the port open for a response
  // that was never going to come, so every unhandled message — which, until
  // the three handlers above were added, meant every blocked video, frame and
  // social post — left a channel dangling until the sender timed out and
  // logged "The message port closed before a response was received".
  //
  // The async branches above each return true for themselves; the synchronous
  // ones have already called sendResponse, and a synchronous response is
  // delivered whatever this returns.
  return false;
});

// ============================================
// SAFE SEARCH + YOUTUBE RESTRICTED MODE (DNR)
// ============================================
// Uses declarativeNetRequest dynamic rules to force family-safe parameters on
// major search engines and to set YouTube's documented Restricted Mode request
// header (https://support.google.com/a/answer/6214622). URL rewrites apply to
// main-frame navigations; header rules can also cover the engines' API calls.

const SAFE_SEARCH_RULE_IDS = [
  10001, 10002, 10003, 10004, 10005, 10006, 10007,
  // AOL Search (10008), Presearch (10009)
  10008, 10009,
  // DuckDuckGo non-JavaScript frontends (10011)
  10011,
  // Yandex Family-mode request cookie (10012)
  10012,
  // Set-Cookie injection for cookie-based engines
  10020, 10021, 10022,
  // Block direct access to safesearch settings pages on cookie-based engines
  10030, 10031, 10032,
  // API-endpoint rewrites for SPA engines that ignore URL params on the frontend
  10040, 10041, 10042, 10043
];
const YOUTUBE_RESTRICT_RULE_IDS = [10010];
// Network-level image/media block for the user's own blocked sites (see
// buildCustomImageBlockRules). One rule carries every eligible domain.
const CUSTOM_IMAGE_BLOCK_RULE_IDS = [10050];
// Dynamic-rule conditions have a bounded domain list; the curated blocklist
// (200k+ hosts) could never fit here, but a user's own list realistically will.
const CUSTOM_IMAGE_BLOCK_MAX_DOMAINS = 1000;
const ALL_DNR_RULE_IDS = [
  ...SAFE_SEARCH_RULE_IDS,
  ...YOUTUBE_RESTRICT_RULE_IDS,
  ...CUSTOM_IMAGE_BLOCK_RULE_IDS
];

function buildSafeSearchRules() {
  const mkRedirect = (id, regexFilter, params) => ({
    id,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        transform: {
          queryTransform: {
            addOrReplaceParams: params.map(([key, value]) => ({ key, value }))
          }
        }
      }
    },
    condition: {
      regexFilter,
      resourceTypes: ['main_frame']
    }
  });

  // Unlike Google/Bing's SafeSearch VIPs, DuckDuckGo and Brave expose real,
  // browsable safe endpoints. Rewriting the host at the network layer gives us
  // the useful part of their documented DNS CNAME enforcement without needing
  // access to the browser's DNS resolver.
  const mkSafeHostRedirect = (id, regexFilter, host, params) => ({
    id,
    priority: 3,
    action: {
      type: 'redirect',
      redirect: {
        transform: {
          scheme: 'https',
          host,
          queryTransform: {
            addOrReplaceParams: params.map(([key, value]) => ({ key, value }))
          }
        }
      }
    },
    condition: {
      // Each caller's source regex deliberately excludes its target host so a
      // navigation cannot enter a redirect loop.
      regexFilter,
      resourceTypes: ['main_frame']
    }
  });

  // Cookie value used to force SafeSearch on engines whose toggle is cookie-backed.
  // Appended via Set-Cookie response header injection (see buildSafeSearchCookieRules).
  const mkSetCookie = (id, requestDomains, cookieValue) => ({
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'set-cookie', operation: 'append', value: cookieValue }
      ]
    },
    condition: {
      requestDomains,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest']
    }
  });

  // Add a provider preference to the outgoing Cookie header without replacing
  // unrelated login/session cookies. This is stronger than response-side
  // Set-Cookie injection: the very first search request already sees it.
  const mkAppendRequestCookie = (id, requestDomains, regexFilter, cookieValue) => ({
    id,
    priority: 3,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'cookie', operation: 'append', value: cookieValue }
      ]
    },
    condition: {
      requestDomains,
      regexFilter,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest']
    }
  });

  // Block direct navigation to settings pages where the user could disable SafeSearch.
  // Sends them back to the engine root so they cannot flip the toggle off.
  const mkBlockSettings = (id, regexFilter, redirectUrl) => ({
    id,
    priority: 2,
    action: {
      type: 'redirect',
      redirect: { url: redirectUrl }
    },
    condition: {
      regexFilter,
      resourceTypes: ['main_frame']
    }
  });

  return [
    // Google (all TLDs: .com, .co.uk, .com.ph, etc.)
    mkRedirect(10001, '^https?://(www\\.)?google\\.[a-z.]+/search\\?', [['safe', 'active']]),
    // Bing web, image, video and news verticals
    mkRedirect(10002, '^https?://(www\\.)?bing\\.com/(search|images/search|videos/search|news/search)\\?', [['adlt', 'strict']]),
    // DuckDuckGo's dedicated safe host is stronger than its kp preference:
    // it is always strict and removes the control that can turn filtering off.
    mkSafeHostRedirect(10003, String.raw`^https?://(www\.)?duckduckgo\.com/`,
      'safe.duckduckgo.com', [['kp', '1']]),
    // Keep the non-JavaScript variants on their intended layouts while
    // replacing any explicit kp=-1/kp=-2 override before the request is sent.
    mkRedirect(10011, String.raw`^https?://(html|lite)\.duckduckgo\.com/(html|lite)?/?\?`, [['kp', '1']]),
    // Yahoo (including AOL portal traffic routed through Yahoo's /yhs/search)
    mkRedirect(10004, String.raw`^https?://([a-z0-9.-]+\.)?search\.yahoo\.com/(search|yhs/search)`, [['vm', 'r']]),
    // Brave also exposes a browsable, locked safe endpoint. Its documented
    // forcesafe.search.brave.com DNS target resolves/redirects to this host.
    mkSafeHostRedirect(10005, String.raw`^https?://search\.brave\.com/`,
      'safe.search.brave.com', [['safesearch', 'strict']]),
    // Ecosia web, image, video and news verticals. Its published strict DNS
    // target is DNS-only, so a visible host redirect would break search.
    mkRedirect(10006, '^https?://(www\\.)?ecosia\\.org/(search|images|videos|news)\\?', [['safesearch', 'strict']]),
    // Qwant page URLs — `www.qwant.com` uses `s=2` for strict mode in the UI
    mkRedirect(10007, String.raw`^https?://(www\.)?qwant\.com/(\?|search\?|images\?|videos\?|news\?)(.*&)?q=`, [['s', '2']]),
    // AOL Search — Yahoo backend uses `vm=r` for strict mode
    mkRedirect(10008, String.raw`^https?://search\.aol\.(com|co\.uk|co\.[a-z]+)/aol/search\?`, [['vm', 'r']]),
    // Presearch — supplements the cookie-based enforcement below
    mkRedirect(10009, String.raw`^https?://(www\.)?presearch\.com/(search|images|videos|news)\?`, [['safe', 'true']]),

    // Yandex stores its documented Family mode in the composite `yp` cookie as
    // `<expiry>.sp.family:2`. Append it after any existing preference so the
    // server uses Family mode on the first web/image/video request. The rule is
    // rebuilt on browser startup, keeping the internal one-year expiry fresh.
    mkAppendRequestCookie(10012, [
      'yandex.com', 'yandex.ru', 'yandex.ua', 'yandex.by', 'yandex.kz',
      'yandex.com.am', 'yandex.com.tr', 'yandex.com.ge', 'yandex.uz',
      'yandex.az', 'yandex.tj', 'yandex.ee', 'yandex.tm', 'yandex.fr',
      'yandex.md', 'yandex.eu', 'yandex.co.il', 'yandex.lv', 'yandex.lt',
      'ya.ru'
    ], String.raw`^https?://(www\.)?(yandex\.(com(\.am|\.tr|\.ge)?|co\.il|ru|ua|by|kz|uz|az|tj|ee|tm|fr|md|eu|lv|lt)|ya\.ru)/(search|images|video|tune/search)(/|\?|$)`,
    `yp=${Math.floor(Date.now() / 1000) + 31536000}.sp.family%3A2`),

    // ---- Cookie-based enforcement (response Set-Cookie injection) ----
    // Presearch SafeSearch is stored in `use_safe_search` cookie (SearXNG ref).
    mkSetCookie(10020, ['presearch.com', 'www.presearch.com'],
      'use_safe_search=true; Path=/; Max-Age=31536000; Secure; SameSite=Lax'),
    // Qwant stores SafeSearch preference in cookies; force strict (=2).
    mkSetCookie(10021, ['qwant.com', 'www.qwant.com'],
      'safesearch=2; Path=/; Max-Age=31536000; Secure; SameSite=Lax'),
    // AOL portal / Yahoo backend keep SafeSearch in `vm` cookie.
    mkSetCookie(10022, ['search.aol.com', 'search.aol.co.uk', 'search.yahoo.com'],
      'vm=r; Path=/; Max-Age=31536000; Secure; SameSite=Lax'),

    // ---- Lock down settings/preferences pages so the toggle cannot be disabled ----
    mkBlockSettings(10030, String.raw`^https?://search\.aol\.[a-z.]+/aol/settings`,
      'https://search.aol.com/aol/webhome'),
    mkBlockSettings(10031, String.raw`^https?://(www\.)?presearch\.com/(settings|account/settings)`,
      'https://presearch.com/'),
    mkBlockSettings(10032, String.raw`^https?://(www\.)?qwant\.com/settings`,
      'https://www.qwant.com/'),

    // ---- API-endpoint SafeSearch enforcement ----
    // Qwant's www frontend is an SPA — the URL bar param is mostly UI state.
    // Real backend filter switch is `safesearch=2` on api.qwant.com/v*/search/*
    // calls, while page URLs (including lite.qwant.com) use `s=2`.
    {
      id: 10040,
      priority: 2,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: { addOrReplaceParams: [{ key: 'safesearch', value: '2' }] }
          }
        }
      },
      condition: {
        regexFilter: String.raw`^https?://api\.qwant\.com/v\d+/search/`,
        resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame']
      }
    },
    {
      id: 10041,
      priority: 2,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: { addOrReplaceParams: [{ key: 's', value: '2' }] }
          }
        }
      },
      condition: {
        regexFilter: String.raw`^https?://lite\.qwant\.com/`,
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest']
      }
    },
    // Presearch SPA also fetches /api/* — pin safe=true there too.
    {
      id: 10042,
      priority: 2,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: { addOrReplaceParams: [{ key: 'safe', value: 'true' }] }
          }
        }
      },
      condition: {
        regexFilter: String.raw`^https?://(www\.)?presearch\.com/(api|results)`,
        resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame']
      }
    },
    // AOL Search API/XHR endpoints — Yahoo backend uses vm=r
    {
      id: 10043,
      priority: 2,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: { addOrReplaceParams: [{ key: 'vm', value: 'r' }] }
          }
        }
      },
      condition: {
        regexFilter: String.raw`^https?://search\.aol\.[a-z.]+/aol/(search|api)`,
        resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame']
      }
    }
  ];
}

// Reduce the user's customPatterns to hostnames usable as a DNR
// `requestDomains` condition. requestDomains already matches subdomains, so
// `*.example.com` and `example.com` collapse to the same entry.
//
// Deliberately skipped:
//   - path-scoped patterns (`example.com/gallery`) — a host-wide image block
//     would be broader than the user asked for; content.js still handles them.
//   - patterns with an embedded wildcard (`ex*.com`) — no requestDomains
//     equivalent.
//   - whitelisted domains — an active allow entry outranks the pattern.
function customPatternsToImageBlockDomains(patterns, whitelistedDomains = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];

  // A leading dot is stripped along with a trailing one: ".xyz" is the same
  // entry as "xyz", and left alone it reached requestDomains as the literal
  // ".xyz" — not a domain, and enough to invalidate the single rule every other
  // blocked host shares.
  const clean = (value) => String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  const excluded = new Set(whitelistedDomains.map(clean).filter(Boolean));
  const domains = new Set();

  for (const raw of patterns) {
    const pattern = clean(raw);
    if (!pattern || pattern.includes('/')) continue;

    const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (!host || host.includes('*')) continue;
    // A whole-TLD entry is deliberately excluded here. requestDomains takes
    // domains, not suffixes, and a rule blocking every image request under a
    // TLD is far broader than a network-level rule should be. The content
    // script still hides those images page-side, which is where the user can
    // see what happened.
    if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) continue;
    if (excluded.has(host)) continue;

    domains.add(host);
    if (domains.size >= CUSTOM_IMAGE_BLOCK_MAX_DOMAINS) break;
  }

  return [...domains];
}

// Blocking a site should also stop its images from surfacing elsewhere —
// hotlinked into forums, embedded in feeds, or opened full-size from an image
// search result. content.js hides the search thumbnails (which are served by
// the engine's own CDN, so DNR can't see them); this stops every request that
// does reach the blocked host. See issue #23.
function buildCustomImageBlockRules(requestDomains) {
  if (!Array.isArray(requestDomains) || requestDomains.length === 0) return [];

  return [{
    id: CUSTOM_IMAGE_BLOCK_RULE_IDS[0],
    priority: 2,
    action: { type: 'block' },
    condition: {
      requestDomains,
      // Sub-resources only — navigation still routes through the blocked page
      // so the user gets the usual explanation instead of a browser error.
      resourceTypes: ['image', 'media']
    }
  }];
}

async function getActiveWhitelistDomains() {
  try {
    const { [WHITELIST_KEY]: whitelist } = await browserAPI.storage.local.get(WHITELIST_KEY);
    if (!Array.isArray(whitelist)) return [];
    const now = Date.now();
    return whitelist
      .filter(item => item && item.domain && !(item.type === 'temporary' && item.expiresAt && item.expiresAt <= now))
      .map(item => item.domain);
  } catch (_) {
    return [];
  }
}

async function updateDnrRules() {
  try {
    if (!browserAPI.declarativeNetRequest || typeof browserAPI.declarativeNetRequest.updateDynamicRules !== 'function') {
      console.warn('BlockNSFW: declarativeNetRequest API not available; skipping dynamic rules');
      return;
    }

    const settings = await getSettings();
    const addRules = [];
    if (settings.safeSearchEnabled) addRules.push(...buildSafeSearchRules());
    // Rule id 10010 stays in ALL_DNR_RULE_IDS so any previously-set rule is removed.

    if (settings.enabled) {
      const imageBlockDomains = customPatternsToImageBlockDomains(
        liveListEntries(settings.customPatterns),
        await getActiveWhitelistDomains()
      );
      addRules.push(...buildCustomImageBlockRules(imageBlockDomains));
    }

    await browserAPI.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ALL_DNR_RULE_IDS,
      addRules
    });

    console.log(`BlockNSFW: Dynamic rules updated (${addRules.length} active)`);
  } catch (error) {
    console.error('BlockNSFW: failed to update dynamic rules', error);
  }
}

// Init. Firefox can run the background script and dispatch onInstalled at the
// same time for a temporary/fresh install. Share one initialization promise so
// the 4 MB blocklist is parsed and indexed once.
let backgroundInitializationPromise = null;

function initializeBackground() {
  if (backgroundInitializationPromise) return backgroundInitializationPromise;
  backgroundInitializationPromise = (async () => {
    await ensureSettingsDefaults();
    await loadDefaultBlocklist();
    await rebuildCompiledPatterns();
    await initializeExtensionStateTracking();
    await updateDnrRules();
    ensureRemoteWhitelistUpToDate().catch(e => console.warn('BlockNSFW: initial whitelist sync failed', e));
    // Not forced: each subscription re-downloads only once its own day is up.
    // Deliberately not awaited — a slow or dead list host must not hold up
    // initialisation, and the rules already on disk are in use meanwhile.
    refreshAllSubscriptions().catch(e => console.warn('BlockNSFW: subscription sync failed', e));
    checkForUpdate().catch(e => console.warn('BlockNSFW: initial update check failed', e));
    console.log('BlockNSFW: Background initialized for Manifest V3');
  })().finally(markReady);
  return backgroundInitializationPromise;
}

browserAPI.runtime.onInstalled.addListener(async (details) => {
  try {
    await initializeBackground();

    // The remote announcement banner is gone; drop the two keys it wrote so
    // they do not sit in every user's local storage forever.
    try {
      await browserAPI.storage.local.remove([
        'pblocker_announcement_info',
        'pblocker_announcement_dismissed'
      ]);
    } catch (_) {}

    // Fresh install only: open the first-run onboarding wizard once. Updates
    // keep using the in-page "What's New" card, so we don't nag on every bump.
    if (details && details.reason === 'install') {
      try {
        const flag = await browserAPI.storage.local.get('pblocker_onboarding_completed');
        if (!flag || !flag.pblocker_onboarding_completed) {
          await browserAPI.tabs.create({ url: browserAPI.runtime.getURL('onboarding.html') });
        }
      } catch (e) {
        console.warn('BlockNSFW: onboarding open failed', e);
      }
    }
    console.log('BlockNSFW: Extension installed/updated - Manifest V3 compatible');
  } catch (error) {
    console.error('BlockNSFW: installation initialization failed', error);
  }
});

// When service worker starts
(async function init() {
  try {
    await initializeBackground();
  } catch (error) {
    console.error('BlockNSFW: service worker initialization failed', error);
  }
})();

// React to settings changes
browserAPI.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) {
    // Drop the cached badge/pill preference so the next block reads the new one.
    const previousDisplay = cachedBlockCountDisplay;
    cachedBlockCountDisplay = null;
    if (previousDisplay === 'badge' && await getBlockCountDisplay() === 'floating') {
      await clearAllTabBadges();
    }
    await rebuildCompiledPatterns();
    // Check if enabled state changed
    await checkExtensionStateChange();
    // Re-apply safe-search rules and the custom-site image block if the
    // relevant toggles or the user's blocked-site list changed
    await updateDnrRules();
    // Turning the AI image blocker off should release the offscreen document's
    // WebGL context and resident models now, not in five minutes.
    try {
      const settings = await getSettings();
      if (settings.aiImageBlocker !== true) await closeOffscreenDocument();
    } catch (_) {}
    console.log('BlockNSFW: Settings updated - patterns rebuilt');
  }
  // Clear URL caches when whitelist changes (patterns don't need rebuilding)
  if (changes[WHITELIST_KEY]) {
    urlCheckCache.clear();
    cacheVersion++;
    // A new allow entry must lift the image block for that domain
    await updateDnrRules();
  }
});
