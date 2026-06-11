/* BlockNSFW background service worker */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Shared browser-safe hostname normalization helpers (RFC 3492 punycode
// decoder, IDN-aware variant helper). See shared/hostname.js.
try {
  if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
    self.importScripts('shared/hostname.js');
    self.importScripts('shared/host-keywords.js');
  }
} catch (_) {
  // shared/hostname.js or shared/host-keywords.js could not be loaded
  // (e.g. test environment). The helpers are optional; ASCII-only checks
  // still work via ADULT_HOST_KEYWORDS.
}

// --- AI Image Blocker: TF.js + NSFW.js-compatible runtime in the SW ----------
// The service worker owns the model so host-page CSP never applies to the
// classifier runtime.
let _aiModel = null;
let _aiModelPromise = null;
let _aiModelFailed = false;
let _aiRuntimeLoaded = false;
let _aiRuntimeLoadError = '';
let _aiModelLastError = '';
let _aiModelLastFailureAt = 0;
const AI_MODEL_RETRY_COOLDOWN_MS = 5000;
const AI_MODEL_INPUT_SIZE = 224;

function getAiModelErrorMessage(error) {
  return String(error && error.message || error || 'unknown error');
}

function getAiModelRetryAfterMs(now = Date.now()) {
  if (!_aiModelFailed || !_aiModelLastFailureAt) return 0;
  const remaining = AI_MODEL_RETRY_COOLDOWN_MS - (now - _aiModelLastFailureAt);
  return remaining > 0 ? remaining : 0;
}

function syncAiRuntimeStateFromGlobals() {
  if (typeof self === 'undefined') return;
  if (typeof self.tf !== 'undefined' && typeof self.nsfwjs !== 'undefined') {
    _aiRuntimeLoaded = true;
    _aiRuntimeLoadError = '';
  }
}

function preloadAiRuntime() {
  if (typeof self === 'undefined' || typeof self.importScripts !== 'function') {
    return;
  }
  try {
    self.importScripts('vendor/tfjs/tf.es2017.js', 'vendor/nsfwjs/nsfwjs.runtime.js');
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

async function ensureAiRuntimeLoaded() {
  syncAiRuntimeStateFromGlobals();
  if (_aiRuntimeLoaded) return;
  if (_aiRuntimeLoadError) {
    throw new Error(_aiRuntimeLoadError);
  }
  throw new Error('AI runtime was not preloaded');
}

async function loadAiModel(options = {}) {
  const forceRetry = options && options.forceRetry === true;
  if (_aiModel) return _aiModel;
  if (_aiModelPromise) return _aiModelPromise;
  const retryAfterMs = getAiModelRetryAfterMs();
  if (_aiModelFailed && !forceRetry && retryAfterMs > 0) {
    const suffix = _aiModelLastError ? `: ${_aiModelLastError}` : '';
    throw new Error(`AI model cooling down after failure${suffix}`);
  }
  _aiModelPromise = (async () => {
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
      _aiModel = await self.nsfwjs.load(browserAPI.runtime.getURL('nsfwjs/'));
      _aiModelFailed = false;
      _aiModelLastError = '';
      _aiModelLastFailureAt = 0;
      console.log('[BlockNSFW] AI Image Blocker model loaded.');
      return _aiModel;
    } catch (err) {
      _aiModel = null;
      _aiModelFailed = true;
      _aiModelLastError = getAiModelErrorMessage(err);
      _aiModelLastFailureAt = Date.now();
      console.warn('[BlockNSFW] Failed to load NSFW model in SW:',
        _aiModelLastError);
      throw new Error(_aiModelLastError);
    } finally {
      _aiModelPromise = null;
    }
  })();
  return _aiModelPromise;
}

async function classifyImageBytes(blobOrArrayBuffer) {
  const model = await loadAiModel();
  let bitmap;
  const bitmapOptions = {
    resizeWidth: AI_MODEL_INPUT_SIZE,
    resizeHeight: AI_MODEL_INPUT_SIZE,
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
  const predictions = await model.classify(bitmap);
  try { bitmap.close(); } catch (_) {}
  const scores = {};
  for (const p of predictions) scores[p.className] = p.probability;
  return scores;
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
  dnsFilterEnabled: false,
  safeSearchEnabled: true,
  facebookReelsEnabled: false,
  instagramReelsEnabled: false,
  aiImageBlocker: true,
  aiTextBlocker: true,
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

// Optimized trie-based domain matching with pre-compilation for maximum performance
class OptimizedDomainTrie {
  constructor() {
    this.root = Object.create(null); // Faster than Map for character keys
    this.precompiled = null; // Pre-compiled lookup structure
    this.precompiledVersion = 0;
    this._domainCount = 0; // O(1) size tracker for hot-path gating
    this.stats = {
      searches: 0,
      hits: 0,
      precompiledSearches: 0,
      precompiledHits: 0
    };
  }
  
  // Insert a domain in reverse order for efficient matching
  insert(domain) {
    const reversed = domain.split('.').reverse().join('.');
    let node = this.root;
    
    for (const char of reversed) {
      if (!node[char]) {
        node[char] = Object.create(null);
      }
      node = node[char];
    }
    if (!node['*']) {
      this._domainCount++;
    }
    node['*'] = true; // Mark as blocked domain
    
    // Invalidate pre-compiled cache
    this.precompiled = null;
    this.precompiledVersion++;
  }
  
  // Batch insert multiple domains for better performance
  batchInsert(domains) {
    if (!Array.isArray(domains)) return;
    
    for (const domain of domains) {
      if (typeof domain === 'string' && domain.includes('.')) {
        this.insert(domain);
      }
    }
  }
  
  // Check if domain or any parent domain is blocked
  search(domain) {
    this.stats.searches++;
    
    // Try pre-compiled lookup first for maximum speed
    if (this.precompiled) {
      this.stats.precompiledSearches++;
      const result = this.precompiled[domain];
      if (result !== undefined) {
        this.stats.precompiledHits++;
        return result;
      }
    }
    
    // Fallback to standard trie search
    const reversed = domain.split('.').reverse().join('.');
    let node = this.root;
    
    for (const char of reversed) {
      if (!node[char]) {
        this.stats.hits++;
        return false;
      }
      node = node[char];
      
      // Check if current level is blocked
      if (node['*']) {
        this.stats.hits++;
        return true;
      }
    }
    
    this.stats.hits++;
    return false;
  }
  
  // Pre-compile the trie for instant lookups
  precompile() {
    const lookup = Object.create(null);
    
    const compileNode = (node, currentPath = '') => {
      if (node['*']) {
        // Add the reversed path (which is the actual domain) to lookup
        const domain = currentPath.split('').reverse().join('');
        lookup[domain] = true;
      }
      
      for (const char in node) {
        if (char !== '*') {
          compileNode(node[char], currentPath + char);
        }
      }
    };
    
    compileNode(this.root);
    this.precompiled = lookup;
    return this.precompiled;
  }
  
  // Auto-precompile when trie reaches certain size
  autoPrecompile(minSize = 1000) {
    if (!this.precompiled && this.estimateSize() >= minSize) {
      return this.precompile();
    }
    return this.precompiled;
  }
  
  // Estimate memory usage of the trie
  estimateSize() {
    let count = 0;
    const countNodes = (node) => {
      for (const key in node) {
        count++;
        if (typeof node[key] === 'object' && node[key] !== null) {
          countNodes(node[key]);
        }
      }
    };
    countNodes(this.root);
    return count;
  }

  // O(1) size accessor used by the hot path. Without this getter, callers
  // that probed `domainTrie.size` always saw `undefined` and silently bypassed
  // the trie lookup branch entirely.
  get size() {
    return this._domainCount;
  }
  
  // Clear the trie
  clear() {
    this.root = Object.create(null);
    this.precompiled = null;
    this.precompiledVersion++;
    this._domainCount = 0;
    this.stats = {
      searches: 0,
      hits: 0,
      precompiledSearches: 0,
      precompiledHits: 0
    };
  }
  
  // Get performance statistics
  getStats() {
    return {
      ...this.stats,
      size: this.estimateSize(),
      precompiled: !!this.precompiled,
      precompiledVersion: this.precompiledVersion
    };
  }
}

// Initialize trie with blocklist
let domainTrie = new OptimizedDomainTrie();

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

function filterSharedCDNParents(hosts) {
  return hosts.filter(h => !isSharedCDNParent(h));
}

// Performance optimization: Pattern and URL caching
let patternCache = new Map(); // Cache for compiled regex patterns
let urlCheckCache = new Map(); // Cache for URL blocking decisions
let keywordCheckCache = new Map(); // Cache for hostname keyword checks
let preCompiledDomainPatterns = new Map(); // Pre-compiled domain patterns for instant matching
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

let blocklistMeta = null;
let remoteBlocklistPromise = null;

// Remote global whitelist (false-positive overrides managed via GitHub)
// Same maintainer-owned repository as the blocklist above.
const REMOTE_WHITELIST_URL = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/WHITELIST.txt';
const REMOTE_WHITELIST_CACHE_KEY = 'pblocker_remote_whitelist_v1';
const REMOTE_WHITELIST_META_KEY = 'pblocker_remote_whitelist_meta_v1';
let remoteWhitelistSet = new Set();
let remoteWhitelistMeta = null;
let remoteWhitelistPromise = null;

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

function isLikelyDomain(candidate) {
  if (!candidate) return false;
  if (candidate.length > 253) return false;
  // Accept ASCII labels, including ACE-encoded punycode labels that begin with
  // "xn--". Each label must be 1-63 chars, alphanumeric or hyphen, may not
  // start or end with a hyphen. The TLD may also be a punycode TLD ("xn--...").
  const label = '(?!-)(?:xn--[a-z0-9-]{2,61}|[a-z0-9-]{1,63})(?<!-)';
  const domainPattern = new RegExp(`^(?:${label}\\.)+${label}$`, 'i');
  return domainPattern.test(candidate);
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

async function removeStaleBlocklistChunks(keepCount) {
  if (!blocklistMeta || typeof blocklistMeta.chunkCount !== 'number') return;
  if (blocklistMeta.chunkCount <= keepCount) return;
  const keysToRemove = [];
  for (let index = keepCount; index < blocklistMeta.chunkCount; index++) {
    keysToRemove.push(`${BLOCKLIST_CACHE_CHUNK_PREFIX}${index}`);
  }
  if (keysToRemove.length > 0) {
    await browserAPI.storage.local.remove(keysToRemove);
  }
}

async function storeBlocklistInCache(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return null;

  const previousMeta = blocklistMeta || (await loadBlocklistMeta());
  const uniqueDomains = Array.from(new Set(domains.map(normalizeDomainForCache))).filter(isLikelyDomain);
  uniqueDomains.sort();

  const chunks = chunkArray(uniqueDomains, BLOCKLIST_CACHE_CHUNK_SIZE);
  const dataToStore = {};
  chunks.forEach((chunk, index) => {
    dataToStore[`${BLOCKLIST_CACHE_CHUNK_PREFIX}${index}`] = chunk;
  });

  const meta = {
    updatedAt: Date.now(),
    chunkCount: chunks.length,
    version: (previousMeta?.version || 0) + 1,
    source: 'remote',
    domainCount: uniqueDomains.length
  };

  dataToStore[BLOCKLIST_CACHE_META_KEY] = meta;

  await browserAPI.storage.local.set(dataToStore);
  await removeStaleBlocklistChunks(chunks.length);

  blocklistMeta = meta;
  return meta;
}

async function loadBlocklistFromCache() {
  const meta = blocklistMeta || (await loadBlocklistMeta());
  if (!meta || !meta.chunkCount) {
    return [];
  }

  const chunkKeys = Array.from({ length: meta.chunkCount }, (_, index) => `${BLOCKLIST_CACHE_CHUNK_PREFIX}${index}`);
  const storedChunks = await browserAPI.storage.local.get(chunkKeys);
  const domains = [];

  for (let index = 0; index < chunkKeys.length; index++) {
    const key = chunkKeys[index];
    const chunk = storedChunks[key];
    if (Array.isArray(chunk)) {
      for (let j = 0; j < chunk.length; j++) {
        const normalized = normalizeDomainForCache(chunk[j]);
        if (isLikelyDomain(normalized)) {
          domains.push(normalized);
        }
      }
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

function buildHostPatterns(patterns) {
  const compiled = [];
  // Pre-allocate array size for better memory efficiency
  compiled.length = patterns.length;
  let validCount = 0;
  
  for (let i = 0; i < patterns.length; i++) {
    try {
      const p = patterns[i];
      let regex;
      // If pattern does not include scheme, allow both http and https
      if (!/^https?:\/\//i.test(p)) {
        regex = patternToRegex('https?://'+ (p.startsWith('*.') ? '(?:.*\\.)?' + p.slice(2) : p).replace(/^\*\./, '(?:.*\\.)?') + '(/.*)?');
      } else {
        regex = patternToRegex(p);
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

async function getStats() {
  const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
  return { ...DEFAULT_STATS, ...(stats || {}) };
}

async function setStats(newStats) {
  await browserAPI.storage.local.set({ [BLOCKED_STATS_KEY]: newStats });
}

async function updateStats(type = 'blocked', details = {}) {
  try {
    // Update total stats
    const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
    const newStats = stats || { blockedCount: 0, websiteBlockedCount: 0, imageBlockedCount: 0, searchResultBlockedCount: 0, lastBlocked: null, lastWebsiteBlocked: null };
    newStats.blockedCount++;
    newStats.lastBlocked = new Date().toISOString();
    
    // Update counters based on type
    switch (type) {
      case 'website_blocked':
        newStats.websiteBlockedCount++;
        newStats.lastWebsiteBlocked = {
          url: details.url,
          title: details.title,
          reason: details.reason,
          timestamp: new Date().toISOString()
        };
        break;
      case 'image_filtered':
        newStats.imageBlockedCount++;
        break;
      case 'image_ai_filtered':
        newStats.aiImageBlockedCount++;
        break;
      case 'search_result_filtered':
        newStats.searchResultBlockedCount++;
        break;
    }
    
    // Update daily stats
    const { [DAILY_STATS_KEY]: dailyStats } = await browserAPI.storage.local.get(DAILY_STATS_KEY);
    const today = new Date().toDateString();
    let newDailyStats = dailyStats || { date: today, blockedToday: 0, websiteBlocked: 0, imageBlocked: 0, searchResultBlocked: 0 };
    
    // Reset daily stats if it's a new day
    if (newDailyStats.date !== today) {
      newDailyStats = { date: today, blockedToday: 0, websiteBlocked: 0, imageBlocked: 0, searchResultBlocked: 0 };
    }
    
    newDailyStats.blockedToday++;
    
    switch (type) {
      case 'website_blocked':
        newDailyStats.websiteBlocked++;
        break;
      case 'image_filtered':
        newDailyStats.imageBlocked++;
        break;
      case 'image_ai_filtered':
        newDailyStats.imageAiBlocked = (newDailyStats.imageAiBlocked || 0) + 1;
        break;
      case 'search_result_filtered':
        newDailyStats.searchResultBlocked++;
        break;
    }
    
    // Save both stats
    await browserAPI.storage.local.set({
      [BLOCKED_STATS_KEY]: newStats,
      [DAILY_STATS_KEY]: newDailyStats
    });
    
  } catch (error) {
    console.error('BlockNSFW: Error updating stats', error);
  }
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: whitelist } = await browserAPI.storage.local.get(WHITELIST_KEY);
  return whitelist || [];
}

// ============================================
// AUDIT LOGGING SYSTEM
// ============================================

// Track extension state for disable event logging
let lastExtensionState = null;
let extensionDisabledTime = null;

// Log a blocked page to audit log
async function logBlockedPage(url, reason = 'Pattern match') {
  try {
    const { [AUDIT_BLOCKED_KEY]: blockedLog } = await browserAPI.storage.local.get(AUDIT_BLOCKED_KEY);
    let log = blockedLog || [];

    const entry = {
      url: url,
      timestamp: Date.now(),
      reason: reason
    };

    log.push(entry);

    const cutoffDate = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    log = log.filter(item => item.timestamp >= cutoffDate);

    if (log.length > AUDIT_MAX_ENTRIES) {
      log = log.slice(-AUDIT_MAX_ENTRIES);
    }

    await browserAPI.storage.local.set({ [AUDIT_BLOCKED_KEY]: log });

    await updateTopDomains(url);
    await updateDailyHistory();
  } catch (error) {
    console.error('BlockNSFW: Failed to log blocked page', error);
  }
}

async function updateTopDomains(url) {
  try {
    let domain;
    try {
      const urlObj = new URL(url);
      domain = urlObj.hostname.replace(/^www\./, '');
    } catch (_) {
      return;
    }

    if (!domain) return;

    const { [TOP_DOMAINS_KEY]: topDomains } = await browserAPI.storage.local.get(TOP_DOMAINS_KEY);
    const domains = topDomains || {};
    domains[domain] = (domains[domain] || 0) + 1;

    const sortedDomains = Object.entries(domains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);
    
    const limitedDomains = {};
    sortedDomains.forEach(([key, value]) => {
      limitedDomains[key] = value;
    });

    await browserAPI.storage.local.set({ [TOP_DOMAINS_KEY]: limitedDomains });
  } catch (error) {
    console.error('BlockNSFW: Failed to update top domains', error);
  }
}

async function updateDailyHistory() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { [DAILY_HISTORY_KEY]: history } = await browserAPI.storage.local.get(DAILY_HISTORY_KEY);
    const dailyHistory = history || {};
    
    dailyHistory[today] = (dailyHistory[today] || 0) + 1;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().slice(0, 10);
    
    Object.keys(dailyHistory).forEach(date => {
      if (date < cutoffDate) {
        delete dailyHistory[date];
      }
    });

    await browserAPI.storage.local.set({ [DAILY_HISTORY_KEY]: dailyHistory });
  } catch (error) {
    console.error('BlockNSFW: Failed to update daily history', error);
  }
}

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
    
    // Use for loop for better performance and early exit
    for (let i = 0; i < whitelist.length; i++) {
      const item = whitelist[i];
      const whitelistDomain = item.domain.replace(/^www\./, '');
      
      // Exact match check first (most common case)
      if (hostname === whitelistDomain) return true;
      
      // Subdomain check
      if (hostname.endsWith('.' + whitelistDomain)) {
        return true;
      }
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
  } catch (e) {
    defaultBlocklist = [];
    defaultBlocklistSet = new Set();
    console.error('BlockNSFW: failed to load packaged blocklist', e);
  }

  ensureRemoteBlocklistUpToDate().catch(error => console.warn('BlockNSFW: remote blocklist sync deferred', error));
}

async function rebuildCompiledPatterns() {
  // Clear caches when rebuilding patterns
  clearAllCaches();
  
  const settings = await getSettings();
  const patternSources = [];
  const hostEntries = [];

  if (Array.isArray(defaultBlocklist)) {
    for (let i = 0; i < defaultBlocklist.length; i++) {
      const entry = defaultBlocklist[i];
      if (!entry) continue;
      if (entry.includes('*')) {
        patternSources.push(entry);
        continue;
      }
      const normalized = normalizeDomainForCache(entry);
      if (isLikelyDomain(normalized)) {
        hostEntries.push(normalized);
      }
    }
  }

  defaultBlocklistSet = new Set(hostEntries);
  
  // Rebuild trie WITHOUT shared CDN parent domains
  domainTrie = new OptimizedDomainTrie();
  domainTrie.batchInsert(filterSharedCDNParents(hostEntries));

  // Pre-compile domain patterns for instant matching
  preCompiledDomainPatterns = new Map();
  hostEntries.forEach(domain => {
    try {
      // Create optimized regex for exact domain matching
      const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^(www\\.)?${escapedDomain}$`, 'i');
      preCompiledDomainPatterns.set(domain, regex);
    } catch (e) {
      console.error('BlockNSFW: Failed to pre-compile domain pattern', domain, e);
    }
  });

  if (Array.isArray(settings.customPatterns)) {
    for (let i = 0; i < settings.customPatterns.length; i++) {
      const pattern = settings.customPatterns[i];
      if (pattern) {
        patternSources.push(pattern);
      }
    }
  }

  const uniquePatterns = [...new Set(patternSources)];
  compiledPatterns = buildHostPatterns(uniquePatterns);
  
  console.log(
    `BlockNSFW: Compiled ${compiledPatterns.length} URL patterns with ${defaultBlocklistSet.size} host entries and ${preCompiledDomainPatterns.size} pre-compiled domain patterns`
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

    // Trie with shared-CDN guard
    if (domainTrie.size > 0 && domainTrie.search(normalized)) {
      if (isSharedCDNParent(normalized)) return false;
      let realMatch = defaultBlocklistSet.has(normalized);
      if (!realMatch) {
        for (let i = 1; i < labels.length - 1; i++) {
          const candidate = labels.slice(i).join('.');
          if (defaultBlocklistSet.has(candidate)) {
            realMatch = !isSharedCDNParent(candidate);
            if (realMatch) break;
          }
        }
      }
      if (realMatch) return true;
    }
  } catch (error) {
    // Ignore parsing errors and treat as not blocked
  }
  return false;
}

// DNS-over-HTTPS filtering via Cloudflare for Families
const dnsCache = new Map();
const DNS_CACHE_TTL = 3600000; // 1 hour
const DNS_CACHE_MAX = 2000;
const DNS_DOH_URL = 'https://family.cloudflare-dns.com/dns-query';
const DNS_TIMEOUT_MS = 3000;

function isDnsCacheBlocked(hostname) {
  const entry = dnsCache.get(hostname);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    dnsCache.delete(hostname);
    return undefined;
  }
  return entry.blocked;
}

async function checkDnsFilter(hostname) {
  const cached = isDnsCacheBlocked(hostname);
  if (cached !== undefined) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);

    const res = await fetch(
      `${DNS_DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      return false;
    }

    const data = await res.json();

    // Status 3 = NXDOMAIN (domain blocked by the family filter)
    // Status 0 but Answer with 0.0.0.0 = sinkholed / blocked
    let blocked = data.Status === 3;
    if (!blocked && data.Status === 0 && Array.isArray(data.Answer)) {
      blocked = data.Answer.some(
        (a) => a.type === 1 && (a.data === '0.0.0.0' || a.data === '127.0.0.1')
      );
    }

    dnsCache.set(hostname, { blocked, expiresAt: Date.now() + DNS_CACHE_TTL });
    if (dnsCache.size > DNS_CACHE_MAX) {
      const oldest = dnsCache.keys().next().value;
      dnsCache.delete(oldest);
    }

    return blocked;
  } catch (_) {
    return false;
  }
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
  
  // Use pre-compiled domain patterns for instant matching when possible
  const hostname = u.hostname.toLowerCase();
  const normalizedHost = normalizeDomainForCache(hostname);
  
  // Check pre-compiled domain patterns first (fastest path)
  for (const [domain, regex] of preCompiledDomainPatterns) {
    if (regex.test(normalizedHost)) {
      shouldBlockResult = true;
      break;
    }
  }
  
  if (!shouldBlockResult && isUrlInDefaultBlocklist(urlStr)) {
    shouldBlockResult = true;
  } else if (!shouldBlockResult && urlMatchesCompiled(urlStr)) {
    shouldBlockResult = true;
  } else if (!shouldBlockResult && settings.useSmartBlocking && hostnameMatchesAdultKeywords(hostname)) {
    shouldBlockResult = true;
  }

  // DNS-over-HTTPS check via Cloudflare for Families (runs only if nothing else caught it)
  if (!shouldBlockResult && settings.dnsFilterEnabled) {
    try {
      shouldBlockResult = await checkDnsFilter(hostname);
    } catch (_) {
      // DNS failure should never break browsing
    }
  }
  
  // Cache the result aggressively
  urlCheckCache.set(cacheKey, shouldBlockResult);
  limitCacheSize(urlCheckCache, MAX_CACHE_SIZE);
  return shouldBlockResult;
}

async function handleBlock(urlStr, type = 'blocked', reason = 'Pattern match') {
  // update stats using new updateStats function
  await updateStats(type);
  
  // Log to audit system for website blocks
  if (type === 'website_blocked' || type === 'blocked') {
    await logBlockedPage(urlStr, reason);
  }
}

// Message listener for content script communications
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'image_filtered') {
    updateStats('image_filtered');
    try {
      const url = typeof message.url === 'string' ? message.url : (typeof sender?.url === 'string' ? sender.url : '');
      if (url) logBlockedPage(url, 'Image filtered');
    } catch (_) {}
    sendResponse({ success: true });
  } else if (message.type === 'image_ai_filtered') {
    updateStats('image_ai_filtered');
    try {
      const url = typeof message.url === 'string'
        ? message.url
        : (typeof sender !== 'undefined' && sender && sender.url ? sender.url : '');
      if (url) logBlockedPage(url, 'AI image filtered');
    } catch (_) {}
    sendResponse({ success: true });
  } else if (message.type === 'website_blocked') {
    updateStats('website_blocked', {
      url: message.url,
      title: message.title,
      reason: message.reason
    });
    // Log to audit system
    logBlockedPage(message.url, message.reason || 'Pattern match');
    console.log(`BlockNSFW: Website blocked - ${message.url} (${message.reason})`);
    sendResponse({ success: true });
  } else if (message.type === 'search_result_filtered') {
    updateStats('search_result_filtered');
    try {
      const url = typeof message.url === 'string' ? message.url : (typeof sender?.url === 'string' ? sender.url : '');
      if (url) logBlockedPage(url, 'Search results filtered');
    } catch (_) {}
    sendResponse({ success: true });
  } else if (message.type === 'get_blocklist_snapshot') {
    (async () => {
      try {
        if (!Array.isArray(defaultBlocklist) || defaultBlocklist.length === 0) {
          await loadDefaultBlocklist();
          await rebuildCompiledPatterns();
        }
        await ensureRemoteBlocklistUpToDate();
        const meta = blocklistMeta || (await loadBlocklistMeta());
        sendResponse({
          success: true,
          blocklist: Array.isArray(defaultBlocklist) ? [...defaultBlocklist] : [],
          meta
        });
      } catch (error) {
        console.error('BlockNSFW: failed to provide blocklist snapshot', error);
        sendResponse({ success: false, error: error.message });
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
        const blocked = await checkDnsFilter(message.hostname);
        sendResponse({ blocked });
      } catch (_) {
        sendResponse({ blocked: false });
      }
    })();
    return true;
  } else if (message.type === 'should_block_url' && typeof message.url === 'string') {
    (async () => {
      try {
        await ensureRemoteBlocklistUpToDate();
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
        const scores = await classifyImageBytes(blob);
        sendResponse({ success: true, scores });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
      }
    })();
    return true;
  } else if (message.type === 'ai_ping_model') {
    (async () => {
      try {
        await loadAiModel({ forceRetry: message.forceRetry === true });
        sendResponse({ ready: true });
      } catch (error) {
        sendResponse({
          ready: false,
          error: error.message || String(error),
          retryAfterMs: getAiModelRetryAfterMs()
        });
      }
    })();
    return true;
  }
  return true; // Keep message channel open for async response
});

// ============================================
// SAFE SEARCH + YOUTUBE RESTRICTED MODE (DNR)
// ============================================
// Uses declarativeNetRequest dynamic rules to force family-safe parameters on
// major search engines and to set YouTube's documented Restricted Mode request
// header (https://support.google.com/a/answer/6214622). Rules only apply to
// main_frame navigations so the user's URL bar / history stays accurate.

const SAFE_SEARCH_RULE_IDS = [
  10001, 10002, 10003, 10004, 10005, 10006, 10007,
  // AOL Search (10008), Presearch (10009)
  10008, 10009,
  // Set-Cookie injection for cookie-based engines
  10020, 10021, 10022,
  // Block direct access to safesearch settings pages on cookie-based engines
  10030, 10031, 10032,
  // API-endpoint rewrites for SPA engines that ignore URL params on the frontend
  10040, 10041, 10042, 10043
];
const YOUTUBE_RESTRICT_RULE_IDS = [10010];
const ALL_DNR_RULE_IDS = [...SAFE_SEARCH_RULE_IDS, ...YOUTUBE_RESTRICT_RULE_IDS];

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
    // Bing
    mkRedirect(10002, '^https?://(www\\.)?bing\\.com/search\\?', [['adlt', 'strict']]),
    // DuckDuckGo (search is served from root ?q= and from /?q=)
    mkRedirect(10003, '^https?://(www\\.|duckduckgo\\.com|html\\.duckduckgo\\.com|safe\\.duckduckgo\\.com)/\\?', [['kp', '1']]),
    // Yahoo (including AOL portal traffic routed through Yahoo's /yhs/search)
    mkRedirect(10004, String.raw`^https?://([a-z0-9.-]+\.)?search\.yahoo\.com/(search|yhs/search)`, [['vm', 'r']]),
    // Brave Search
    mkRedirect(10005, '^https?://search\\.brave\\.com/search\\?', [['safesearch', 'strict']]),
    // Ecosia
    mkRedirect(10006, '^https?://(www\\.)?ecosia\\.org/search\\?', [['safesearch', 'strict']]),
    // Qwant page URLs — `www.qwant.com` uses `s=2` for strict mode in the UI
    mkRedirect(10007, String.raw`^https?://(www\.)?qwant\.com/(\?|search\?|images\?|videos\?|news\?)(.*&)?q=`, [['s', '2']]),
    // AOL Search — Yahoo backend uses `vm=r` for strict mode
    mkRedirect(10008, String.raw`^https?://search\.aol\.(com|co\.uk|co\.[a-z]+)/aol/search\?`, [['vm', 'r']]),
    // Presearch — supplements the cookie-based enforcement below
    mkRedirect(10009, String.raw`^https?://(www\.)?presearch\.com/search\?`, [['safe', 'true']]),

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

async function updateSafeSearchRules() {
  try {
    if (!browserAPI.declarativeNetRequest || typeof browserAPI.declarativeNetRequest.updateDynamicRules !== 'function') {
      console.warn('BlockNSFW: declarativeNetRequest API not available; skipping safe-search rules');
      return;
    }

    const settings = await getSettings();
    const addRules = [];
    if (settings.safeSearchEnabled) addRules.push(...buildSafeSearchRules());
    // Rule id 10010 stays in ALL_DNR_RULE_IDS so any previously-set rule is removed.

    await browserAPI.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ALL_DNR_RULE_IDS,
      addRules
    });

    console.log(`BlockNSFW: Safe-search rules updated (${addRules.length} active)`);
  } catch (error) {
    console.error('BlockNSFW: failed to update safe-search rules', error);
  }
}

// Init
browserAPI.runtime.onInstalled.addListener(async () => {
  try {
    const settings = await getSettings();
    await setSettings(settings); // ensure defaults saved
    await loadDefaultBlocklist();
    await rebuildCompiledPatterns();
    await initializeExtensionStateTracking();
    await updateSafeSearchRules();
    ensureRemoteWhitelistUpToDate().catch(e => console.warn('BlockNSFW: initial whitelist sync failed', e));
    console.log('BlockNSFW: Extension installed/updated - Manifest V3 compatible');
  } finally {
    markReady();
  }
});

// When service worker starts
(async function init() {
  try {
    const settings = await getSettings();
    await setSettings(settings); // ensure defaults saved
    await loadDefaultBlocklist();
    await rebuildCompiledPatterns();
    await initializeExtensionStateTracking();
    await updateSafeSearchRules();
    ensureRemoteWhitelistUpToDate().catch(e => console.warn('BlockNSFW: whitelist sync failed', e));
    console.log('BlockNSFW: Service worker initialized for Manifest V3');
  } finally {
    markReady();
  }
})();

// React to settings changes
browserAPI.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) {
    await rebuildCompiledPatterns();
    // Check if enabled state changed
    await checkExtensionStateChange();
    // Re-apply safe-search / YouTube restricted rules if those toggles flipped
    await updateSafeSearchRules();
    console.log('BlockNSFW: Settings updated - patterns rebuilt');
  }
  // Clear URL caches when whitelist changes (patterns don't need rebuilding)
  if (changes[WHITELIST_KEY]) {
    urlCheckCache.clear();
    cacheVersion++;
  }
});
