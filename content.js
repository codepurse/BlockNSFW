/* BlockNSFW content script - comprehensive content filtering */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Yandex serves Search from several regional domains. Keep the list explicit:
// a broad `hostname.includes('yandex.')` check would also trust lookalike hosts.
const YANDEX_SEARCH_BASE_DOMAINS = [
  'yandex.com.am', 'yandex.com.tr', 'yandex.com.ge', 'yandex.co.il',
  'yandex.com', 'yandex.ru', 'yandex.ua', 'yandex.by', 'yandex.kz',
  'yandex.uz', 'yandex.az', 'yandex.tj', 'yandex.ee', 'yandex.tm',
  'yandex.fr', 'yandex.md', 'yandex.eu', 'yandex.lv', 'yandex.lt', 'ya.ru'
];

function getYandexSearchBaseDomain(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return YANDEX_SEARCH_BASE_DOMAINS.find(domain => host === domain || host === `www.${domain}`) || '';
}

function isYandexSearchHost(hostname) {
  return !!getYandexSearchBaseDomain(hostname);
}

function isYandexSafeSearchPath(pathname, search = '') {
  const path = String(pathname || '/').toLowerCase();
  return path === '/'
    ? new URLSearchParams(search).has('text')
    : ['/search', '/images', '/video', '/tune/search'].some(prefix =>
        path === prefix || path.startsWith(`${prefix}/`));
}

function updateYandexFamilyCookieValue(currentValue, expiresAt) {
  const blocks = String(currentValue || '')
    .split('#')
    .filter(block => block && !/\.sp\.family/i.test(block));
  blocks.push(`${expiresAt}.sp.family%3A2`);
  return blocks.join('#');
}

// ----------------------------------------------------------------------------
// SafeSearch side-effect enforcement for cookie-backed engines.
// Runs at document_start so the page's first request already sees the
// enforced cookie/localStorage state. DNR rules (background.js) handle the
// URL-parameter side; this script handles cookies + settings-page lockdown.
// ----------------------------------------------------------------------------
(function enforceSafeSearchSideEffects() {
  try {
    const u = new URL(location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const host = (u.hostname || '').toLowerCase().replace(/^www\./, '');
    const path = u.pathname || '/';
    const isYandexSearchPage = isYandexSearchHost(u.hostname) &&
      isYandexSafeSearchPath(path, u.search);

    const settingsKey = 'pblocker_settings';
    const isAolYahooHost = (hostname) => /(^|\.)search\.aol\./.test(hostname) || hostname === 'search.yahoo.com';
    const isAolYahooSearchPath = (pathname) => pathname.startsWith('/aol/search') || pathname.startsWith('/yhs/search') || pathname.startsWith('/search');
    const logAolSafeSearchAudit = (stage) => {
      if (!isAolYahooHost(u.hostname.toLowerCase())) return;
      try {
        const params = new URL(location.href).searchParams;
        const cookies = {};
        document.cookie.split(';').forEach((part) => {
          const trimmed = part.trim();
          if (!trimmed) return;
          const eqIndex = trimmed.indexOf('=');
          const key = eqIndex === -1 ? trimmed : trimmed.slice(0, eqIndex);
          const value = eqIndex === -1 ? '' : trimmed.slice(eqIndex + 1);
          if (key === 'vm') {
            cookies[key] = value;
          }
        });
        console.log('BlockNSFW AOL SafeSearch audit', {
          stage,
          href: location.href,
          urlVm: params.get('vm'),
          cookieVm: cookies.vm || null
        });
      } catch (error) {
        console.warn('BlockNSFW: AOL SafeSearch audit failed', error);
      }
    };
    const normalizeAolUrl = (rawUrl) => {
      try {
        const nextUrl = new URL(rawUrl, location.href);
        if (!isAolYahooHost(nextUrl.hostname.toLowerCase())) return null;
        if (!isAolYahooSearchPath(nextUrl.pathname)) return null;
        if (nextUrl.searchParams.get('vm') === 'r') return null;
        nextUrl.searchParams.set('vm', 'r');
        return nextUrl.toString();
      } catch {
        return null;
      }
    };
    const installAolStrictGuards = () => {
      if (!isAolYahooHost(u.hostname.toLowerCase())) return;
      if (globalThis.__pblockerAolStrictGuardsInstalled) return;
      globalThis.__pblockerAolStrictGuardsInstalled = true;

      const patchHistoryMethod = (methodName) => {
        try {
          const originalMethod = history[methodName];
          if (typeof originalMethod !== 'function') return;
          history[methodName] = function patchedHistory(state, title, urlArg) {
            const nextUrl = typeof urlArg === 'string' ? normalizeAolUrl(urlArg) || urlArg : urlArg;
            if (nextUrl !== urlArg && typeof nextUrl === 'string') {
              console.log(`BlockNSFW: AOL history.${methodName} vm -> r`, { from: urlArg, to: nextUrl });
            }
            return originalMethod.call(this, state, title, nextUrl);
          };
        } catch (error) {
          console.warn(`BlockNSFW: failed to patch AOL history.${methodName}`, error);
        }
      };

      const forceVmInput = (form) => {
        if (!(form instanceof HTMLFormElement)) return;
        let actionUrl;
        try {
          actionUrl = new URL(form.getAttribute('action') || location.href, location.href);
        } catch {
          return;
        }
        if (!isAolYahooHost(actionUrl.hostname.toLowerCase())) return;
        if (!isAolYahooSearchPath(actionUrl.pathname)) return;
        let vmInput = form.querySelector('input[name="vm"]');
        if (!vmInput) {
          vmInput = document.createElement('input');
          vmInput.type = 'hidden';
          vmInput.name = 'vm';
          form.appendChild(vmInput);
        }
        if (vmInput.value !== 'r') {
          vmInput.value = 'r';
          console.log('BlockNSFW: AOL form vm -> r');
        }
      };

      patchHistoryMethod('pushState');
      patchHistoryMethod('replaceState');

      document.addEventListener('submit', (event) => {
        forceVmInput(event.target);
      }, true);

      const patchExistingForms = () => {
        document.querySelectorAll('form').forEach(forceVmInput);
      };
      patchExistingForms();
      try {
        new MutationObserver(patchExistingForms).observe(document.documentElement, {
          subtree: true,
          childList: true
        });
      } catch (error) {
        console.warn('BlockNSFW: failed to observe AOL forms', error);
      }
    };
    const enforce = () => {
      const setCookie = (name, value) => {
        try {
          const isSecure = location.protocol === 'https:';
          const parts = u.hostname.split('.');
          const baseDomain = parts.length >= 2 ? '.' + parts.slice(-2).join('.') : u.hostname;
          const attrs = 'Path=/; Max-Age=31536000; SameSite=Lax' + (isSecure ? '; Secure' : '');
          document.cookie = `${name}=${value}; ${attrs}`;
          document.cookie = `${name}=${value}; Domain=${baseDomain}; ${attrs}`;
        } catch (_) {}
      };

      // Lock down SafeSearch settings/preferences pages → bounce back to home
      if (/(^|\.)search\.aol\./.test(u.hostname.toLowerCase()) && path.startsWith('/aol/settings')) {
        try { window.stop(); } catch (_) {}
        location.replace('https://search.aol.com/aol/webhome');
        return;
      }
      if (host.endsWith('presearch.com') && (path === '/settings' || path.startsWith('/settings/') || path.startsWith('/account/settings'))) {
        try { window.stop(); } catch (_) {}
        location.replace('https://presearch.com/');
        return;
      }
      if (host.endsWith('qwant.com') && path.startsWith('/settings')) {
        try { window.stop(); } catch (_) {}
        location.replace('https://www.qwant.com/');
        return;
      }

      if (host.endsWith('presearch.com')) {
        setCookie('use_safe_search', 'true');
      }
      if (host.endsWith('qwant.com')) {
        // Qwant stores prefs in a single JSON cookie + localStorage. Pin both.
        setCookie('safesearch', '2');
        try {
          localStorage.setItem('safeSearch', '2');
          // Qwant's React store reads `_pcd_user_prefs` / `qwant_prefs` style
          // keys; pin every common variant defensively.
          const prefKeys = ['safeSearch', 'safesearch', 'adultContentFilter', 'adult_content_filter'];
          prefKeys.forEach(k => { try { localStorage.setItem(k, 'strict'); } catch (_) {} });
        } catch (_) {}
        injectQwantUiLockdown();
      }
      if (isAolYahooHost(u.hostname.toLowerCase())) {
        setCookie('vm', 'r');
        installAolStrictGuards();
        logAolSafeSearchAudit('document_start');
        // Belt-and-suspenders: if the current AOL search URL has vm != r
        // (e.g. vm=p permissive or vm=i moderate), rewrite the URL in-place
        // so the user lands on strict regardless of DNR rule timing.
        if (isAolYahooSearchPath(path)) {
          try {
            const strictUrl = normalizeAolUrl(location.href);
            if (strictUrl) {
              try { window.stop(); } catch (_) {}
              console.log('BlockNSFW: AOL URL hard-rewrite vm -> r', { from: location.href, to: strictUrl });
              location.replace(strictUrl);
              return;
            }
          } catch (error) {
            console.warn('BlockNSFW: AOL URL hard-rewrite failed', error);
          }
        }
      }
      if (isYandexSearchPage) {
        // This is Yandex's current persisted representation of Family mode,
        // verified against /tune/search. DNR also appends the same value to the
        // first outgoing request; this stored copy keeps client-side state and
        // subsequent form/API code aligned with what the server received.
        try {
          const baseDomain = getYandexSearchBaseDomain(u.hostname);
          const expiresAt = Math.floor(Date.now() / 1000) + 31536000;
          const ypCookie = document.cookie.split(';').find(part => part.trim().startsWith('yp='));
          const currentValue = ypCookie ? ypCookie.trim().slice(3) : '';
          const value = updateYandexFamilyCookieValue(currentValue, expiresAt);
          document.cookie = `yp=${value}; Domain=.${baseDomain}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
        } catch (_) {}
        // Only observe the settings document; running a whole-document
        // MutationObserver on Yandex's live search results would be needless
        // work on every result appended by the SPA.
        if (path.startsWith('/tune/search')) injectYandexUiLockdown();
      }
    };

    // Hide the "Filter adult content" row in Qwant's settings modal so the
    // dropdown cannot be reached, and continuously force any matched <select>
    // back to strict (=2) if the SPA re-renders it.
    const injectQwantUiLockdown = () => {
      const styleId = 'pblocker-qwant-lockdown';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          [data-testid*="safesearch" i],
          [data-testid*="adult" i],
          [aria-label*="adult content" i],
          [aria-label*="safesearch" i],
          [class*="SafeSearch" i],
          [class*="AdultContent" i] {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }

      const forceStrict = () => {
        const selects = document.querySelectorAll('select');
        selects.forEach(sel => {
          const opts = Array.from(sel.options || []);
          const looksLikeSafeSearch = opts.some(o => /strict|moderate|off/i.test(o.textContent || ''))
            && opts.length <= 5;
          if (!looksLikeSafeSearch) return;
          const strictOpt = opts.find(o => /strict/i.test(o.textContent || '') || o.value === '2' || o.value === 'strict');
          if (strictOpt && sel.value !== strictOpt.value) {
            sel.value = strictOpt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          sel.disabled = true;
        });
      };

      const run = () => { try { forceStrict(); } catch (_) {} };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else {
        run();
      }
      try {
        new MutationObserver(run).observe(document.documentElement, {
          subtree: true, childList: true
        });
      } catch (_) {}
    };

    // Yandex's settings page offers free, mild and family values under the
    // stable `filter_search_results` field. Keep Family selected and make the
    // weaker choices unreachable while SafeSearch enforcement is enabled.
    const injectYandexUiLockdown = () => {
      const forceFamily = () => {
        const radios = document.querySelectorAll('input[name="filter_search_results"]');
        radios.forEach(radio => {
          const isFamily = radio.value === 'family';
          radio.checked = isFamily;
          radio.disabled = true;
          if (!isFamily) {
            const row = radio.closest('li, label');
            if (row) row.style.display = 'none';
          }
        });
      };

      const run = () => { try { forceFamily(); } catch (_) {} };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else {
        run();
      }
      try {
        new MutationObserver(run).observe(document.documentElement, {
          subtree: true, childList: true
        });
      } catch (_) {}
    };

    // Only run on relevant hosts to keep startup cost ~zero elsewhere.
    const relevant = host.endsWith('presearch.com')
      || host.endsWith('qwant.com')
      || isAolYahooHost(u.hostname.toLowerCase())
      || isYandexSearchPage;
    if (!relevant) return;

    Promise.resolve(browserAPI.storage.local.get([settingsKey])).then((res) => {
      const s = (res && res[settingsKey]) || {};
      if (s.enabled === false) return;
      if (s.safeSearchEnabled === false) return;
      enforce();
      if (isAolYahooHost(u.hostname.toLowerCase())) {
        setTimeout(() => logAolSafeSearchAudit('post_enforce_750ms'), 750);
        globalThis.addEventListener('load', () => logAolSafeSearchAudit('window_load'), { once: true });
      }
    }).catch(() => {});
  } catch (_) {}
})();

// Configuration and state management
let isEnabled = true;
let useSmartBlocking = true;
let customKeywordList = [];
// Rules from subscribed lists. Held apart from the user's own patterns and in
// two shapes on purpose: a published list is mostly bare domains and can run to
// tens of thousands of lines, so those go in a Set for an O(1) host test, and
// only the wildcard and regex entries stay in a list that has to be walked. The
// walk happens per image and per search result, which is exactly the path that
// made pages crawl in 1.7.0.
let subscriptionHostSet = new Set();
let subscriptionPatterns = [];

// User-defined blocked sites (settings.customPatterns). Kept at module scope so
// the image/search-result filters can honour them, not just page navigation.
let customBlockPatterns = [];
let imageFilterLevel = 'strict';
// Full blocklist snapshots contain 200k+ domains and are prohibitively
// expensive to clone and rebuild in every Firefox content-script realm. Keep a
// bounded per-page host verdict cache and ask the background in batches instead.
const backgroundBlocklistHostCache = new Map();
const pendingBackgroundHostChecks = new Map();
let backgroundHostCheckTimer = null;
const BACKGROUND_HOST_CACHE_MAX = 5000;
let trustedDomains = [];
let isProcessing = false;
let observer = null;
let imageObserver = null;
let mediaObserver = null; // Observer for videos/media
let debugMode = false; // Verbose logging disabled by default
let blockedTriggered = false;
let facebookReelsEnabled = false;
let instagramReelsEnabled = false;

// Custom blocked page settings
let blockedPageType = 'default'; // 'default', 'custom', 'plain_html'
let customBlockedPageUrl = ''; // URL for custom blocked page
let plainBlockedPageHtml = '';

// How a blocked web result is presented: removed outright ('hide') or replaced
// with a card in place ('overlay'). Applies to web/text results only — image and
// video results are always removed, because the card is a full-width flex row
// with a 40px avatar and a badge, and a 200px grid tile cannot hold it. That is
// also the case a user reported as too noisy once the verticals were filtered.
let searchResultTreatment = 'hide'; // 'hide' | 'overlay'
// Whether the "N results blocked" summary line is drawn at all. Some users want
// no on-page footprint whatsoever.
let searchSummaryEnabled = true;

// Running total of results blocked on the current search, and the search it
// belongs to. The incremental pass reports deltas — DuckDuckGo builds its
// results row by row — so the summary has to accumulate rather than overwrite.
// Keyed by search identity rather than reset on navigation: DuckDuckGo switches
// verticals with pushState, which fires no popstate for us to listen to.
let pageBlockedCount = 0;
let pageBlockedCountKey = '';

// Where the running block count is shown: on the toolbar icon, or as a pill in
// the corner of the page. The toolbar badge is the platform's own idiom and
// cannot collide with the page, but Chrome hides unpinned extension icons behind
// the puzzle-piece menu — where a badge is invisible, and no API can pin it for
// the user. The in-page pill is the fallback for exactly that case.
let blockCountDisplay = 'badge'; // 'badge' | 'floating'
// Hosts blocked on this page and how often, for the pill's detail panel.
let pageBlockedEntries = new Map();
let pageBlockedTotal = 0;
let pageBlockedEntriesKey = '';
let floatingCounterExpanded = false;

// AI Text Blocker (multilingual hashed char-n-gram classifier). The model is a
// pure-JS linear model in shared/text-classifier-core.js (global TextClassifier),
// loaded from text-model.json. No TF.js / no eval -> safe in the content script.
let aiTextBlocker = true;
let aiTextStrictness = 'balanced';
let textModel = null;
let textModelReady = false;
let textModelLoading = false;
let textModelFailed = false; // give up after one failed load; never retry-hammer
let textScanPending = false; // a scan wanted to run before the model finished loading
const FACEBOOK_REELS_STYLE_ID = 'pblocker-facebook-reels-style';
const INSTAGRAM_REELS_STYLE_ID = 'pblocker-instagram-reels-style';

// Reddit NSFW checking
let redditNSFWCache = new Map(); // Cache for Reddit subreddit NSFW status
const REDDIT_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Performance optimization: Debouncing and caching
const DEBOUNCE_DELAY = 100;
const BATCH_SIZE = 10;
let processQueue = [];
// Incremental processing for search results to avoid full-page reprocessing
let pendingResults = new Set();
// Incremental processing for social posts to avoid full-page reprocessing
let pendingSocial = new Set();
// Elements whose media (img/video/iframe) discovery is deferred off the
// synchronous MutationObserver callback and coalesced into an idle batch, so a
// burst of mutations (e.g. a streaming chat re-rendering its message on every
// token) can't pin the main thread.
let pendingMediaNodes = new Set();
let mediaDiscoveryScheduled = false;
// True when any page-text feature (keyword "smart blocking" or the AI text
// classifier) is on. When false we skip all page-text scanning work entirely,
// including the per-mutation text reads that used to run unconditionally.
let anyTextFeatureOn = true;
// Cached result of the (async) whitelist check for the current page, refreshed
// by processContent. Lets the synchronous MutationObserver honor the whitelist
// so a user-trusted site is a real escape hatch — no scanning, no per-mutation
// work — instead of only processContent respecting it.
let pageWhitelisted = false;

// Adult content detection keywords (used for domain/site name lookups).
// These are site names, so they are matched as standalone tokens via
// indexOfSiteToken() below — never as bare substrings. See shared/token-match.js.
const ADULT_CONTENT_KEYWORDS = [
  'pornhub', 'xvideos', 'xhamster', 'xnxx', 'redtube', 'youporn',
  'brazzers', 'chaturbate', 'onlyfans', 'bongacams',
  'spankbang', 'tube8', 'youjizz', 'erome', 'tnaflix'
];

// Context-aware keyword detection configuration
const ADULT_CONTEXT_KEYWORDS = [
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', 'fetish', 'erotic'
];

// Multilingual STRONG adult-signal keywords. Substring match (no word boundary)
// because CJK / Thai / Arabic / Devanagari scripts have no whitespace tokenization
// and JS `\b` is ASCII-only.
//
// CURATION RULES (to minimize false positives):
//   1. Only adult-industry-specific terms; no general vulgar words that appear
//      in news / literature / casual speech / dictionaries.
//   2. Prefer multi-character phrases over single tokens.
//   3. Reject any term that is a substring of a common word in its language
//      (e.g. "анал" inside "анализ", "scopare" = "to sweep" in Italian).
//   4. Reject single names/slurs that occur as surnames or pet names.
// One hit = block, so list MUST stay tight. When in doubt, leave it out and
// rely on HOSTS.txt + DNS family filter for the unknown-domain catch.
const MULTILINGUAL_ADULT_KEYWORDS = [
  // === Chinese (Simplified + Traditional) ===
  '色情', '情色',
  '成人片', '成人影片', '成人视频', '成人視頻', '成人网站', '成人網站',
  '黄色片', '黃色片', '黄色网站', '黃色網站',
  '三级片', '三級片',
  '无码视频', '無碼視頻', '无码片', '無碼片',
  'av女优', 'av女優',
  '裸聊直播', '约炮平台', '約炮平台',

  // === Japanese ===
  'エロ動画', 'エロ画像', 'アダルト動画', 'アダルトビデオ',
  'ポルノ動画', 'ポルノ画像',
  'エッチ動画', 'セックス動画',
  'ハメ撮り', '無修正動画', 'AV女優', 'av女優',

  // === Korean ===
  '야동', '야설',
  '성인사이트', '성인동영상', '성인비디오',
  '포르노', '한국야동', '일본야동',
  '떡방', '벗방', '조개모아',

  // === Russian / Ukrainian / Belarusian ===
  // NOTE: skip "анал" alone — substring of "анализ" / "анальный" gets analytics pages.
  //       skip "эротика" — legit literary genre on book sites.
  //       skip "шлюха" — appears in news/literature.
  'порно', 'порнуха', 'порнушка', 'порнография',
  'порновидео', 'порнофильм', 'порно онлайн',
  'хентай', 'порево',
  'секс видео', 'секс фото', 'секс чат',
  'анальный секс', 'анал порно',

  // === Arabic ===
  // Skip "إباحية" alone — used in religious/political "permissibility" sense.
  // Skip "عاهرة" — appears in literature.
  'افلام سكس', 'افلام إباحية', 'سكس عربي',
  'مقاطع سكس', 'فيديو سكس',

  // === Thai ===
  // Skip vulgar singles ("เย็ด", "หี", "ควย") — appear in casual social media.
  'หนังโป๊', 'หนังโป', 'คลิปโป๊', 'คลิปหลุด', 'โป๊เปลือย',
  'หนังเอ๊ก', 'หนังx',

  // === Vietnamese ===
  // Skip "khiêu dâm" / "địt nhau" — news/legal usage of khiêu dâm; vulgar singles.
  'phim sex', 'phim người lớn', 'phim nguoi lon', 'phim sex viet',
  'phim khiêu dâm',

  // === Indonesian / Malay ===
  // Skip vulgar singles ("memek", "kontol", "ngentot") — appear in slang/news.
  'video bokep', 'film bokep', 'bokep indo', 'bokep jepang',
  'situs bokep',

  // === Hindi (Devanagari) ===
  // Skip "अश्लील" / "नंगी" alone — Hindi news headlines on obscenity laws / crime.
  'सेक्सी वीडियो', 'देसी सेक्स', 'सेक्स वीडियो',
  'पॉर्न वीडियो', 'अश्लील वीडियो',

  // === Tagalog / Filipino ===
  // Skip "pekpek" / "malibog na" — too colloquial, can appear in casual text.
  'kantot', 'kantutan', 'jakulan',

  // === Turkish ===
  // Skip "sikiş" alone — could appear in linguistic articles. Phrase-only.
  'porno izle', 'sikiş izle', 'türk porno', 'türk sikiş',

  // === German ===
  // Skip "muschi" (also a common cat name), "ficken" (dictionaries), "pornos" alone.
  'pornofilm', 'pornofilme', 'pornos kostenlos', 'porno kostenlos',
  'geile titten', 'nackte frauen', 'gratis porno',

  // === French ===
  // Skip "baise" (also "kiss"), "salope" (casual/songs), "enculée" (vulgar single).
  'porno gratuit', 'film porno', 'porno français', 'films pornos',

  // === Italian ===
  // Skip "scopare" (also "to sweep"!), "figa" (slang), "pompino" (vulgar single).
  'porno gratis', 'film porno', 'porno italiano', 'video porno',

  // === Spanish ===
  // Skip "follando" / "tetona" — folla- has botanical meaning.
  'porno gratis', 'porno español', 'pornografía', 'videos porno',
  'peliculas porno',

  // === Portuguese ===
  // Skip "buceta" / "siririca" / "peituda" — vulgar singles.
  'pornô grátis', 'pornografia', 'porno brasileiro', 'videos porno',
  'filme pornô',

  // === Polish ===
  // Skip "cipa" / "kutas" (latter is a Polish surname).
  'porno za darmo', 'ostre porno', 'darmowe porno', 'filmy porno',

  // === Czech / Slovak ===
  // Skip "kunda" — vulgar single.
  'porno zdarma', 'české porno', 'porno videa',
];

// Lowercased once for fast substring scanning.
const MULTILINGUAL_ADULT_KEYWORDS_LOWER = MULTILINGUAL_ADULT_KEYWORDS.map(k => k.toLowerCase());

function containsMultilingualAdultKeyword(lowerText) {
  if (!lowerText) return null;
  for (let i = 0; i < MULTILINGUAL_ADULT_KEYWORDS_LOWER.length; i++) {
    const kw = MULTILINGUAL_ADULT_KEYWORDS_LOWER[i];
    if (lowerText.includes(kw)) return MULTILINGUAL_ADULT_KEYWORDS[i];
  }
  return null;
}

const SAFE_CONTEXT_KEYWORDS = [
  'help', 'healing', 'recovery', 'quit', 'freedom', 'overcome', 'overcoming',
  'stop', 'avoid', 'resist', 'prevention', 'support', 'supportive',
  'counseling', 'counselling', 'therapy', 'mentor', 'faith',
  'church', 'christian', 'muslim', 'family', 'awareness', 'education', 'protect',
  'protection', 'accountability', 'addiction', 'treatment', 'group', 'responsible'
];

const RISK_CONTEXT_KEYWORDS = [
  'free', 'video', 'videos', 'watch', 'stream', 'streaming', 'download', 'live',
  'cam', 'cams', 'chat', 'pics', 'pictures', 'gallery', 'galleries', 'tube',
  'clips', 'gif', 'gifs', 'collection', 'hd', 'uncensored', 'explicit'
];

const CONTEXT_WINDOW = 80;
const BLOCKLIST_META_KEY = 'pblocker_blocklist_meta_v2';
const IMAGE_FILTER_LEVELS = {
  STRICT: 'strict',
  MODERATE: 'moderate',
  LENIENT: 'lenient'
};

const STRICT_IMAGE_KEYWORD_REGEX = /\b(porn|xxx|nude|naked|erotic|nsfw|sex|adult|fetish)\b/i;
const MODERATE_IMAGE_KEYWORD_REGEX = /\b(porn|porno|xxx|nsfw|nude|naked|erotic|hentai|onlyfans|sexcam|sex-tape|camgirl)\b/i;
const LENIENT_IMAGE_KEYWORD_REGEX = /\b(porn|porno|xxx|hentai|redtube|xvideos|xnxx|youporn|brazzers|chaturbate|spankbang|onlyfans)\b/i;

const MODERATE_CONTEXT_TERMS = [
  'porn', 'porno', 'xxx', 'nsfw', 'nude', 'naked', 'hentai', 'erotic', 'onlyfans', 'camgirl', 'sex cam'
];

const SMART_HOST_CACHE_MAX = 2000;
const smartHostKeywordCache = new Map();

// Instant block: minimal default host list for zero-latency matching
// Duplicates blocklist.json intentionally to avoid fetch delay at document_start
const DEFAULT_BLOCKLIST_HOSTS_EARLY = [
  'pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com', 'redtube.com',
  'youporn.com', 'spankbang.com', 'tube8.com', 'youjizz.com', 'brazzers.com',
  'chaturbate.com', 'bongacams.com', 'cam4.com', 'adultfriendfinder.com',
  'fapdu.com', 'hentaidb.com', 'rule34.xxx', 'erome.com', 'onlyfans.com',
  'tnaflix.com', 'porn.com', 'eporner.com', 'pornone.com', 'sunporno.com',
  'provideos.com', 'myfreecams.com', 'xvideos2.com', 'porntube.com',
  'xmegadrive.com', 'nuvid.com'
];

// Known-safe entertainment / media CDN domains that serve movie posters, album art, etc.
// Images from these hosts should never be blocked by path-keyword heuristics alone.
const KNOWN_SAFE_IMAGE_CDNS = new Set([
  'a.ltrbxd.com', 's.ltrbxd.com', 'image.tmdb.org',  // Letterboxd / TMDB
  'upload.wikimedia.org', 'commons.wikimedia.org',     // Wikipedia
  'images-na.ssl-images-amazon.com', 'm.media-amazon.com', // Amazon / IMDb
  'ia.media-imdb.com', 'flxt.tmsimg.com',             // IMDb / Rotten Tomatoes
  'cdn.myanimelist.net',                                // MyAnimeList
  'images.justwatch.com',                              // JustWatch
  'occ-0-2794-2219.1.nflxso.net',                     // Netflix CDN (varies)
  'pisces.bbystatic.com',                              // Best Buy
  'img.youtube.com', 'i.ytimg.com',                    // YouTube thumbnails
  'mosaic.scdn.co', 'i.scdn.co',                      // Spotify
  'lastfm.freetls.fastly.net',                         // Last.fm
  'static.metacritic.com',                             // Metacritic
  'cdn.arstechnica.net',                               // Ars Technica
  'cdn.vox-cdn.com',                                   // Vox Media
  'static01.nyt.com',                                  // NYT
  'wp.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com',   // WordPress CDN
  'cdn.shopify.com',                                   // Shopify
  'store.storeimages.cdn-apple.com',                   // Apple
  'lh3.googleusercontent.com',                         // Google user content
  'res.cloudinary.com',                                // Cloudinary
  'imagedelivery.net',                                 // Cloudflare Images
  'cdn.britannica.com',                                // Britannica
  'media.cnn.com',                                     // CNN
  'media.npr.org',                                     // NPR
  'static.reuters.com',                                // Reuters
  'dims.apnews.com',                                   // AP News
  'media.wired.com',                                   // Wired
  'assets.bwbx.io',                                    // Bloomberg
  'i.insider.com',                                     // Business Insider
  'cdn.cnn.com',                                       // CNN CDN
]);

// Default trusted image domains -- e-commerce, gaming, social, education.
// Merged from background.js so the content script can use them directly.
const DEFAULT_TRUSTED_IMAGE_DOMAINS_LIST = [
  'steampowered.com', 'steamstatic.com', 'steamcommunity.com',
  'steamcdn-a.akamaihd.net', 'epicgames.com', 'gog.com',
  'battle.net', 'blizzard.com', 'ubisoft.com', 'ea.com',
  'nintendo.com', 'playstation.com', 'xbox.com', 'microsoft.com',
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com',
  'bestbuy.com', 'newegg.com', 'etsy.com', 'wayfair.com',
  'youtube.com', 'youtu.be', 'twitch.tv', 'discord.com',
  'reddit.com', 'imgur.com', 'github.com', 'stackoverflow.com',
  'wikipedia.org', 'wikimedia.org', 'bbc.com', 'bbc.co.uk',
  'cnn.com', 'reuters.com', 'apnews.com', 'npr.org',
  'nytimes.com', 'washingtonpost.com', 'theguardian.com',
  'forbes.com', 'bloomberg.com', 'wired.com',
];

// Terms that indicate benign/legitimate use of otherwise-ambiguous keywords
// (e.g. "nude lipstick", "adult bike helmet", "sex education").
const BENIGN_IMAGE_CONTEXT = new Set([
  'color', 'colour', 'shade', 'palette', 'lipstick', 'makeup', 'cosmetic',
  'foundation', 'blush', 'eyeshadow', 'fashion', 'clothing', 'dress',
  'heel', 'shoe', 'size', 'price', 'buy', 'cart', 'shop', 'product',
  'review', 'rating', 'brand', 'style', 'wear', 'outfit',
  'skincare', 'beauty', 'cream', 'lotion', 'perfume', 'fragrance',
  'education', 'study', 'research', 'report', 'article', 'policy',
  'health', 'medical', 'science', 'textbook', 'course', 'class',
  'identity', 'orientation', 'rights', 'law', 'legislation',
  'movie', 'film', 'show', 'series', 'season', 'episode', 'book',
  'album', 'song', 'artist', 'game', 'player', 'team', 'sport',
  'juice', 'smoothie', 'recipe', 'drink', 'food', 'restaurant',
  'bike', 'helmet', 'children', 'kids', 'family', 'toothbrush',
  'guard', 'pass', 'play', 'coach', 'score', 'league', 'championship',
]);

// Keywords split into confidence tiers for path/URL matching.
// High-confidence terms are unambiguously adult; ambiguous terms have
// common benign usage in e-commerce, news, and education.
const HIGH_CONFIDENCE_PATH_KEYWORDS = /\b(porn|porno|pornography|xxx|hentai|nsfw|erotic|fetish)\b/i;
const AMBIGUOUS_PATH_KEYWORDS = /\b(nude|naked|sex|adult)\b/i;

// Query strings go through shared/url-scan.js so a site's own adult-filter
// switch reads as a control instead of as content: 4get's `?nsfw=no` means the
// filter is ON, yet a raw scan of the query blocked the page. If that module is
// missing, fall back to the path alone — scanning the query raw is exactly the
// false positive the module exists to prevent.
function buildUrlScanText(urlLike, opts) {
  if (typeof UrlScan !== 'undefined' && UrlScan.buildUrlScanText) {
    return UrlScan.buildUrlScanText(urlLike, opts);
  }
  try {
    const u = typeof urlLike === 'string' ? new URL(urlLike, window.location.href) : urlLike;
    let path = (u && u.pathname) || '';
    try { path = decodeURIComponent(path); } catch (_) {}
    return path;
  } catch (_) {
    return '';
  }
}

const MAX_TEXT_LENGTH = 8000;

function normalizeHost(host) {
  return (host || '').replace(/^www\./, '').toLowerCase();
}

function isKnownSafeImageHost(imgUrl) {
  if (!imgUrl) return false;
  try {
    const imgHost = normalizeHost(new URL(imgUrl, window.location.href).hostname);
    // Direct match against built-in safe CDN set
    if (KNOWN_SAFE_IMAGE_CDNS.has(imgHost)) return true;
    // First-party check: image on the same (sub)domain as the page
    const pageHost = normalizeHost(window.location.hostname);
    if (imgHost === pageHost) return true;
    // Subdomain of page host (e.g. images.example.com on example.com)
    if (imgHost.endsWith('.' + pageHost) || pageHost.endsWith('.' + imgHost)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

let _cleanPageHostCache = null;

function isCleanPageHost() {
  if (_cleanPageHostCache !== null) return _cleanPageHostCache;
  try {
    const host = normalizeHost(window.location.hostname);
    if (!host) { _cleanPageHostCache = true; return true; }
    if (isHostInDefaultBlocklist(host)) { _cleanPageHostCache = false; return false; }
    if (matchesAdultKeywordHost(host)) { _cleanPageHostCache = false; return false; }
    if (isLikelyAdultHostEarly(host)) { _cleanPageHostCache = false; return false; }
    _cleanPageHostCache = true;
    return true;
  } catch (_) {
    _cleanPageHostCache = true;
    return true;
  }
}

function normalizeImageFilterLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === IMAGE_FILTER_LEVELS.MODERATE || value === IMAGE_FILTER_LEVELS.LENIENT) {
    return value;
  }
  return IMAGE_FILTER_LEVELS.STRICT;
}

/**
 * Drop comment lines and unescape the rest before anything matches against a
 * user list. Comments live in the same array as entries, so this has to happen
 * at every point a stored list reaches matching code — a '# note' compiled as a
 * pattern would block whatever it happened to mention.
 */
function liveListEntries(list) {
  if (!Array.isArray(list)) return [];
  if (typeof KeywordPattern !== 'undefined' && KeywordPattern.effectiveEntries) {
    return KeywordPattern.effectiveEntries(list);
  }
  // Fallback if the shared module failed to load: still refuse to treat a
  // comment as an entry, since that is the harmful direction.
  return list
    .map((entry) => String(entry == null ? '' : entry).trim())
    .filter((entry) => entry && entry.charAt(0) !== '#' && entry.charAt(0) !== '!');
}

/**
 * Flatten the enabled subscriptions into the two shapes the matcher uses. A
 * disabled subscription keeps its rules on disk but contributes none, so
 * switching it back on costs nothing.
 */
function loadSubscriptionRules(subscriptions, rulesById) {
  subscriptionHostSet = new Set();
  subscriptionPatterns = [];
  if (!Array.isArray(subscriptions) || !rulesById || typeof rulesById !== 'object') return;

  const entries = [];
  for (const subscription of subscriptions) {
    if (!subscription || subscription.enabled === false) continue;
    const own = rulesById[subscription.id];
    if (Array.isArray(own)) entries.push(...own);
  }
  if (!entries.length) return;

  const split = (typeof Ruleset !== 'undefined' && Ruleset.splitEntries)
    ? Ruleset.splitEntries(entries)
    : { hosts: [], patterns: entries };
  subscriptionHostSet = new Set(split.hosts);
  subscriptionPatterns = split.patterns;
}

function normalizeSearchResultTreatment(treatment) {
  return String(treatment || '').toLowerCase() === 'overlay' ? 'overlay' : 'hide';
}

function normalizeBlockCountDisplay(display) {
  return String(display || '').toLowerCase() === 'floating' ? 'floating' : 'badge';
}

function getImageKeywordRegexForLevel(level) {
  const normalized = normalizeImageFilterLevel(level);
  if (normalized === IMAGE_FILTER_LEVELS.LENIENT) return LENIENT_IMAGE_KEYWORD_REGEX;
  if (normalized === IMAGE_FILTER_LEVELS.MODERATE) return MODERATE_IMAGE_KEYWORD_REGEX;
  return STRICT_IMAGE_KEYWORD_REGEX;
}

function hasImageKeywordsForLevel(text, level) {
  if (!text || typeof text !== 'string') return false;
  return getImageKeywordRegexForLevel(level).test(text.toLowerCase());
}

function hasModerateContextSignals(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (let i = 0; i < MODERATE_CONTEXT_TERMS.length; i++) {
    if (lower.includes(MODERATE_CONTEXT_TERMS[i])) return true;
  }
  return false;
}

// --- Local hosts ----------------------------------------------------------
// Loopback, private ranges, the reserved local TLDs and bare intranet labels:
// names that mean something only on this machine or this network. Mirrors
// isLocalHostname / isIpLiteral in shared/hostname.js, with an inline fallback
// for the case where that module did not load.

function hostIsLocal(host) {
  const helpers = (typeof HostnameNormalize !== 'undefined') ? HostnameNormalize : null;
  if (helpers && helpers.isLocalHostname) return helpers.isLocalHostname(host);
  const h = normalizeHost(host).replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
  if (!h) return false;
  if (h.includes(':')) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  if (!h.includes('.')) return true;
  if (/^(?:0|10|127)\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return true;
  return /\.(?:localhost|local|test|example|invalid|internal|home\.arpa)$/.test(h);
}

function hostIsIpLiteral(host) {
  const helpers = (typeof HostnameNormalize !== 'undefined') ? HostnameNormalize : null;
  if (helpers && helpers.isIpLiteral) return helpers.isIpLiteral(host);
  const h = normalizeHost(host).replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
  if (!h) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
  return h.includes(':') && /^[0-9a-f:.]+$/.test(h);
}

/**
 * Is the page itself on a local host?
 *
 * This gates the three heuristic scans below — page metadata, page body text,
 * and the AI text classifier. Those infer what an *unknown* site is about from
 * a handful of keywords, and localhost is not an unknown site: it is whatever
 * the person at this keyboard is building. The inference is wrong there often
 * enough to be worse than useless. checkPageMetadata blocks on a single
 * keyword anywhere in the title or seven meta tags, so every dev page whose
 * metadata mentioned adult content was blocked on sight -- including the pages
 * of a tool for blocking it -- and `localhost` could not even be whitelisted,
 * so there was no way out.
 *
 * Deliberately NOT exempted: the user's own custom blocklist and title
 * patterns (they typed those, which is an instruction rather than a guess) and
 * AI image classification (it judges the picture in front of it rather than
 * guessing from a word). A public IP literal is not local either -- it can
 * serve anything -- which is why this asks hostIsLocal and not hostIsIpLiteral.
 *
 * Memoized: the page's host cannot change without a navigation, and the scans
 * ask on every pass.
 */
let _localPageCache = null;

function isLocalPage() {
  if (_localPageCache === null) {
    try {
      _localPageCache = hostIsLocal(window.location.hostname);
    } catch (_) {
      _localPageCache = false;
    }
  }
  return _localPageCache;
}

// Can a public resolver meaningfully answer for this hostname?
//
// No, for anything public DNS has no record of: `localhost`, a bare intranet
// label, a reserved local TLD (`app.test`, `nas.local`), a private or loopback
// address, or an IP literal of any kind (nothing can look up an address).
//
// Those all come back NXDOMAIN, and the block detector reads NXDOMAIN as
// "filtered" (see shared/dns-providers.js), so with DNS Protection on every
// local development server was redirected to the blocked page on every single
// load. The background worker refuses these too -- this check just saves the
// round trip. Mirrors isDnsCheckableHost in background.js.
function isDnsCheckableHost(host) {
  return !hostIsLocal(host) && !hostIsIpLiteral(host);
}

function hostMatchesDomain(host, domain) {
  const d = normalizeHost(domain);
  const h = normalizeHost(host);
  return h === d || h.endsWith('.' + d);
}

function getBlockedRedirectUrl(targetUrl, reason, settings, detail) {
  const pageType = (settings && settings.blockedPageType) ? settings.blockedPageType : blockedPageType;
  const customUrl = (settings && typeof settings.customBlockedPageUrl === 'string') ? settings.customBlockedPageUrl : customBlockedPageUrl;
  const plainHtml = (settings && typeof settings.plainBlockedPageHtml === 'string') ? settings.plainBlockedPageHtml : plainBlockedPageHtml;

  // Optional context so the blocked page can show *why* it triggered:
  //   detail.matched -> term(s) the block keyed on (keyword list, or the words
  //                     that most influenced the AI classifier)
  //   detail.score   -> AI classifier probability in [0,1]
  detail = detail || {};
  const matchedList = Array.isArray(detail.matched) ? detail.matched : (detail.matched ? [detail.matched] : []);
  let extraParams = '';
  if (matchedList.length > 0) {
    extraParams += '&matched=' + encodeURIComponent(matchedList.join(', '));
  }
  if (typeof detail.score === 'number' && isFinite(detail.score)) {
    extraParams += '&score=' + encodeURIComponent(detail.score.toFixed(2));
  }

  if (pageType === 'custom' && customUrl) {
    return customUrl +
      (customUrl.includes('?') ? '&' : '?') +
      'url=' + encodeURIComponent(targetUrl) +
      '&reason=' + encodeURIComponent(reason) +
      extraParams;
  }

  const base = browserAPI.runtime.getURL('blocked.html');
  if (pageType === 'plain_html' && plainHtml && plainHtml.trim()) {
    return base +
      '?mode=plain_html' +
      '&url=' + encodeURIComponent(targetUrl) +
      '&reason=' + encodeURIComponent(reason) +
      extraParams;
  }

  return base +
    '?url=' + encodeURIComponent(targetUrl) +
    '&reason=' + encodeURIComponent(reason) +
    extraParams;
}

function isHostInDefaultBlocklist(host) {
  const h = normalizeHost(host);

  if (backgroundBlocklistHostCache.get(h) === true) return true;

  for (let i = 0; i < DEFAULT_BLOCKLIST_HOSTS_EARLY.length; i++) {
    if (hostMatchesDomain(h, DEFAULT_BLOCKLIST_HOSTS_EARLY[i])) return true;
  }
  return false;
}

function matchesAdultKeywordHost(host) {
  if (!useSmartBlocking) return false;
  const h = normalizeHost(host);
  if (!h) return false;

  const cached = smartHostKeywordCache.get(h);
  if (cached !== undefined) return cached;

  // Delegate to the shared strict host matcher so the content script and the
  // service worker use the same keyword list and the same whole-label /
  // hyphen-bounded matching rules. Falls back to the local ADULT_CONTENT_KEYWORDS
  // list if the shared module failed to load.
  let result = false;
  if (typeof HostBlockKeywords !== 'undefined' && HostBlockKeywords.matchesAdultKeywordHost) {
    result = HostBlockKeywords.matchesAdultKeywordHost(h);
  } else {
    // Local fallback mirrors the shared strict matcher using the page-text
    // ADULT_CONTENT_KEYWORDS list (used for path/title scanning too).
    const labels = h.split('.');
    outer: for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!label) continue;
      for (let j = 0; j < ADULT_CONTENT_KEYWORDS.length; j++) {
        const k = ADULT_CONTENT_KEYWORDS[j];
        if (!k) continue;
        if (label === k) { result = true; break outer; }
        if (label.startsWith(k) && (label.length === k.length || label[k.length] === '-')) {
          result = true; break outer;
        }
        if (label.endsWith(k) && label.length > k.length && label[label.length - k.length - 1] === '-') {
          result = true; break outer;
        }
      }
    }
  }

  smartHostKeywordCache.set(h, result);
  if (smartHostKeywordCache.size > SMART_HOST_CACHE_MAX) {
    const firstKey = smartHostKeywordCache.keys().next().value;
    smartHostKeywordCache.delete(firstKey);
  }
  return result;
}

// Compiled `/url/` and `title/…/` blocklist entries, keyed by raw text.
// Compiling runs a timing probe, so it must not repeat per scan.
let customPatternRegexCache = new Map();

function resetCustomPatternCache() {
  customPatternRegexCache = new Map();
}

function customPatternCompiled(raw) {
  if (customPatternRegexCache.has(raw)) return customPatternRegexCache.get(raw);
  let compiled = { kind: 'wildcard', regex: null };
  try {
    if (typeof KeywordPattern !== 'undefined' && KeywordPattern.compileListEntry) {
      compiled = KeywordPattern.compileListEntry(raw);
    }
  } catch (_) {
    compiled = { kind: 'wildcard', regex: null };
  }
  customPatternRegexCache.set(raw, compiled);
  return compiled;
}

// Does the page title match a `title/…/` entry? Titles are only known once the
// page has loaded, so this is page-level only — navigation blocking cannot see
// them.
function customPatternsMatchTitle(title, patterns) {
  if (!title || !Array.isArray(patterns) || patterns.length === 0) return false;
  for (let i = 0; i < patterns.length; i++) {
    const raw = (patterns[i] || '').trim();
    if (!raw) continue;
    const compiled = customPatternCompiled(raw);
    if (compiled.kind === 'title' && compiled.regex && compiled.regex.test(title)) return true;
  }
  return false;
}

// The host a blocklist entry is really about: normalizeHost for the www./case
// handling every host goes through, plus the leading-dot rule that lets ".xyz"
// and "xyz" name the same thing. Falls back to normalizeHost alone if the
// shared module did not load, which keeps existing entries working.
function blockHostBase(value) {
  const stripped = (typeof self !== 'undefined' && self.DomainValidate && self.DomainValidate.normalizeBlockHost)
    ? self.DomainValidate.normalizeBlockHost(value)
    : String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return normalizeHost(stripped);
}

function customPatternsMatchHost(urlStr, host, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const h = normalizeHost(host);
  // Host-only wildcard patterns like *.example.com or example.com[/path]
  for (let i = 0; i < patterns.length; i++) {
    const p = (patterns[i] || '').trim();
    if (!p) continue;

    // `/regex/` entries match the whole URL; `title/…/` entries are handled by
    // customPatternsMatchTitle and must not be treated as hostnames here.
    const compiled = customPatternCompiled(p);
    if (compiled.kind === 'url') {
      if (compiled.regex && urlStr && compiled.regex.test(urlStr)) return true;
      continue;
    }
    if (compiled.kind === 'title') continue;
    // Extract host part before first slash
    const slashIdx = p.indexOf('/');
    const pHost = slashIdx >= 0 ? p.slice(0, slashIdx) : p;
    // Support leading wildcard subdomain
    if (pHost.startsWith('*.')) {
      const base = blockHostBase(pHost.slice(2));
      if (base && (h === base || h.endsWith('.' + base))) return true;
    } else {
      // A leading dot (".xyz", ".example.com") is the same entry as the bare
      // form, since a bare host already covers its subdomains. Without this it
      // matched nothing at all, without saying so.
      const base = blockHostBase(pHost);
      if (base && (h === base || h.endsWith('.' + base))) return true;
    }
    // If path was provided, do a loose URL match as a fallback
    if (slashIdx >= 0) {
      const escaped = p
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      try {
        const re = new RegExp(escaped, 'i');
        if (re.test(urlStr)) return true;
      } catch (_) {}
    }
  }
  return false;
}

// Does this URL/host match one of the user's own blocked-site patterns?
// Thin wrapper over customPatternsMatchHost so the image and search-result
// filters can consult the user's list the same way navigation blocking does.
function matchesCustomBlockPattern(urlStr, host) {
  if (customBlockPatterns.length &&
      customPatternsMatchHost(urlStr, host, customBlockPatterns)) {
    return true;
  }
  return matchesSubscriptionRule(urlStr, host);
}

/**
 * The same question asked of subscribed lists. Bare hosts are answered from a
 * Set — the overwhelmingly common case, and the reason a 30,000-line list does
 * not slow every image on the page — before falling back to walking whatever
 * wildcards and regexes the list also carries.
 */
function matchesSubscriptionRule(urlStr, host) {
  if (subscriptionHostSet.size) {
    const h = normalizeHost(host);
    if (h) {
      if (subscriptionHostSet.has(h)) return true;
      // A rule for example.com covers its subdomains, matching how a bare host
      // behaves everywhere else in the extension.
      let index = h.indexOf('.');
      while (index !== -1) {
        const parent = h.slice(index + 1);
        if (!parent.includes('.')) break;
        if (subscriptionHostSet.has(parent)) return true;
        index = h.indexOf('.', index + 1);
      }
    }
  }
  if (!subscriptionPatterns.length) return false;
  return customPatternsMatchHost(urlStr, host, subscriptionPatterns);
}

function isLikelyAdultHostEarly(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  const safeHostTokens = [
    'help', 'recovery', 'quit', 'addiction', 'support', 'therapy', 'counseling', 'counselling', 'treatment',
    'awareness', 'education', 'protect', 'protection', 'accountability'
  ];
  if (safeHostTokens.some(t => h.includes(t))) return false;
  const adultHostTokens = ['porn', 'porno', 'pornography', 'xxx', 'nsfw', 'hentai'];
  return adultHostTokens.some(t => h.includes(t));
}

function isLikelyAdultPathEarly(urlStr) {
  try {
    const path = buildUrlScanText(urlStr);
    return /\b(porn|porno|pornography|xxx|nsfw|hentai|nude|naked|erotic)\b/i.test(path);
  } catch (_) {
    return false;
  }
}

function getLocalBlockReasonKey(urlStr, normalizedHost, options = {}) {
  const {
    customPatterns = [],
    useSmartBlockingEnabled = useSmartBlocking,
    includeCustomPatterns = true,
    includePathSignals = false,
    preferInstantCodes = false
  } = options;

  if (isHostInDefaultBlocklist(normalizedHost)) {
    return preferInstantCodes ? 'instant_host_match' : 'default_blocklist';
  }

  if (includeCustomPatterns && customPatternsMatchHost(urlStr, normalizedHost, customPatterns)) {
    return 'custom_blocklist';
  }

  const smartMatch = useSmartBlockingEnabled && (
    matchesAdultKeywordHost(normalizedHost) ||
    isLikelyAdultHostEarly(normalizedHost) ||
    (includePathSignals && isLikelyAdultPathEarly(urlStr))
  );

  if (smartMatch) {
    return preferInstantCodes ? 'instant_keyword_match' : 'smart_filter';
  }

  return null;
}

function getBlockedReasonLabel(reasonKey) {
  switch (reasonKey) {
    case 'dns_blocked':
      return 'Blocked by DNS filter';
    case 'custom_blocklist':
      return 'Blocked by custom blocklist';
    case 'default_blocklist':
    case 'instant_host_match':
      return 'Blocked by built-in blocklist';
    case 'smart_filter':
    case 'instant_keyword_match':
      return 'Blocked by smart keyword filter';
    case 'metadata_scan':
      return 'Blocked by metadata scan';
    case 'page_text_scan':
      return 'Blocked by page text scan';
    case 'ai_text_scan':
      return 'Blocked by AI text classifier';
    case 'search_query':
      return 'Blocked explicit search query';
    case 'reddit_nsfw':
      return 'Reddit NSFW subreddit';
    default:
      return 'Adult content detected';
  }
}

// One-click subscribe links.
//
// List authors publish a button pointing at uBlacklist's redirect page,
// https://ublacklist.github.io/rulesets/subscribe?url=<url-encoded-url>. Since
// the ruleset format is the same, those links work here too: the address is
// lifted out and handed to Settings, which asks before doing anything with it.
//
// This only reads a query parameter off a page the user deliberately clicked
// through to. Nothing is subscribed without a further click in Settings, so a
// page cannot add a list by linking at one.
(function handleSubscribeLink() {
  try {
    const host = window.location.hostname.toLowerCase();
    if (host !== 'ublacklist.github.io') return;
    if (!/^\/rulesets\/subscribe\/?$/.test(window.location.pathname)) return;

    const target = new URLSearchParams(window.location.search).get('url');
    if (!target || !/^https?:\/\//i.test(target)) return;

    browserAPI.runtime.sendMessage({ type: 'subscription_prefill', url: target });
  } catch (_) {
    // Never let this interfere with the page.
  }
})();

// Run an instant host-level check at document_start to avoid page flash
(function instantBlockEarly() {
  try {
    const urlStr = window.location.href;
    const host = window.location.hostname;
    const normalizedHost = normalizeHost(host);

    // Do not act on extension pages (defensive, though content scripts don't run there)
    if (urlStr.startsWith('chrome-extension://') || urlStr.startsWith('moz-extension://')) return;
    if (isExtensionStorePage()) return;

    // Continue with async checks for other blocking mechanisms
    (async function asyncBlockCheck() {
      try {
        // Read settings, whitelist, and temporary disable
        const result = await browserAPI.storage.local.get([
          'pblocker_settings',
          'pblocker_whitelist',
          'pblocker_temp_disable_until',
          'pblocker_remote_whitelist_v1'
        ]);
        const settings = result.pblocker_settings || { enabled: true, useSmartBlocking: true, customPatterns: [] };
        // Respect temporary disable
        const tempUntil = result.pblocker_temp_disable_until;
        if (typeof tempUntil === 'number' && Date.now() < tempUntil) return;
        if (!settings.enabled) return;

        const redirectNow = (reasonKey, notifyReasonLabel) => {
          try {
            browserAPI.runtime.sendMessage({
              type: 'website_blocked',
              url: urlStr,
              title: document.title,
              reason: notifyReasonLabel
            });
          } catch (_) {}
          try { window.stop(); } catch (_) {}
          const blockedUrl = getBlockedRedirectUrl(urlStr, reasonKey, settings);
          window.location.replace(blockedUrl);
        };

        // Respect whitelist (including temporary expiration + optional path scope)
        const whitelist = Array.isArray(result.pblocker_whitelist) ? result.pblocker_whitelist : [];
        const now = Date.now();
        const pathname = location.pathname || '/';
        const pathMatches = (self.DomainValidate && self.DomainValidate.whitelistPathMatches)
          ? self.DomainValidate.whitelistPathMatches
          : (_p, storedPath) => !storedPath;
        for (let i = 0; i < whitelist.length; i++) {
          const item = whitelist[i];
          // Skip expired temporary entries
          if (item.type === 'temporary' && item.expiresAt && item.expiresAt <= now) continue;
          if (hostMatchesDomain(normalizedHost, item.domain) && pathMatches(pathname, item.path)) {
            return; // Whitelisted -> allow
          }
        }

        // Respect remote global whitelist
        const remoteWL = result.pblocker_remote_whitelist_v1 || [];
        for (let i = 0; i < remoteWL.length; i++) {
          if (hostMatchesDomain(normalizedHost, remoteWL[i])) return;
        }

        const instantReasonKey = getLocalBlockReasonKey(urlStr, normalizedHost, {
          customPatterns: liveListEntries(settings.customPatterns),
          useSmartBlockingEnabled: settings.useSmartBlocking,
          includeCustomPatterns: false,
          includePathSignals: true,
          preferInstantCodes: true
        });
        if (instantReasonKey) {
          redirectNow(instantReasonKey, getBlockedReasonLabel(instantReasonKey));
          return;
        }

        // Preserve local custom/smart reasons without waiting for the default
        // list; those checks use settings and the small built-in early list.
        const localReasonKey = getLocalBlockReasonKey(urlStr, normalizedHost, {
          customPatterns: liveListEntries(settings.customPatterns),
          useSmartBlockingEnabled: settings.useSmartBlocking
        });
        if (localReasonKey) {
          redirectNow(localReasonKey, getBlockedReasonLabel(localReasonKey));
          return;
        }

        // The full list has 200k+ entries. Asking the background for one URL is
        // much cheaper than cloning that list and rebuilding its indexes in
        // every page's content-script realm (especially under Firefox).
        const backgroundVerdict = await sendRuntimeMessageForResponse({
          type: 'should_block_url',
          url: urlStr
        });
        if (backgroundVerdict && backgroundVerdict.blocked) {
          redirectNow('default_blocklist', getBlockedReasonLabel('default_blocklist'));
          return;
        }

        // DNS-over-HTTPS check via background, against whichever filtering
        // resolver the user picked in settings (see shared/dns-providers.js).
        // Local hosts are excluded: public DNS has no record for them, and a
        // no-record answer reads as a block. See isDnsCheckableHost.
        if (settings.dnsFilterEnabled && isDnsCheckableHost(normalizedHost)) {
          try {
            const dnsResult = await new Promise((resolve) => {
              browserAPI.runtime.sendMessage(
                { type: 'check_dns_filter', hostname: normalizedHost },
                (response) => resolve(response)
              );
            });
            if (dnsResult && dnsResult.blocked) {
              redirectNow('dns_blocked', 'Blocked by DNS filter');
            }
          } catch (_) {
            // DNS check failed — fail open
          }
        }
      } catch (err) {
        // Fail-open: do nothing on errors
        if (debugMode) {
          try { console.log('BlockNSFW: async block error', err); } catch (_) {}
        }
      }
    })(); // Call the async function immediately
  } catch (err) {
    // Fail-open: do nothing on errors
    if (debugMode) {
      try { console.log('BlockNSFW: instant block error', err); } catch (_) {}
    }
  }
})();

// Search engine specific selectors - targeting only actual search results
const SEARCH_SELECTORS = {
  google: {
    // Use simpler, more reliable selectors for individual results
    containers: '.g, .rc, .MjjYud',
    // Where the "N results blocked" summary goes — inserted before this node,
    // so it sits above the result list the way uBlacklist's line does. First
    // match wins; if none match, the parent of the first result is used.
    resultsAnchor: '#rso, #search',
    images: 'img[data-src], img[src*="googleusercontent"], .rg_i img',
    // Context selectors for image search
    imageContext: {
      container: '.isv-r, div[jsname]', 
      text: '.H8Rx8c, .VFACy, .fxgdke, a[role="link"] div'
    }
  },
  bing: {
    containers: '.b_algo',
    resultsAnchor: '#b_results',
    images: '.img_cont img, .mimg img',
    imageContext: {
      container: '.iuscp, .imgpt',
      text: '.tit, .inflnk, .infsd'
    }
  },
  duckduckgo: {
    // DuckDuckGo's verticals are React with hashed class names ("GVdWSyhoW1SZ…")
    // that change on every deploy, so nothing here may key on a class. The
    // stable hooks are the data-testid attributes on each vertical and the
    // semantic tags inside them: web/video results are <article>, image results
    // are <figure>. The `.tile--*`/`.result` selectors are the pre-React layout,
    // kept so older self-hosted instances still filter.
    // The All tab carries inline images/videos modules — rows of thumbnails for
    // the same query — that no result selector reached. Each result row is an
    // <li data-layout="…">, which names what the row holds ("organic", "images",
    // "videos", "about", "related_searches"), so the two verticals can be taken
    // without touching the knowledge panel or the related-search row.
    containers: '[data-testid="result"], [data-testid="zci-videos"] article, li[data-layout="images"], li[data-layout="videos"], .nrn-react-div, .result, .web-result, .react-results--main .result',
    // Each result article sits alone in its own <li>; hiding the list item
    // rather than the article keeps the replacement card outside the result's
    // wrapping <a>, which would otherwise stay clickable.
    resultRoot: 'li',
    resultsAnchor: '[data-testid="mainline"], .react-results--main, #links',
    // The knowledge panel is a result too, but it is several hundred words of
    // reference prose rather than a snippet, and the heuristic term lists
    // misread that much text. It is therefore judged on explicit signals only:
    // a blocklisted link, or a word from the user's own list.
    explicitOnlyContainers: 'li[data-layout="about"]',
    images: '[data-testid="zci-images"] figure img, .tile--img img, .module--images img',
    imageContext: {
      container: '[data-testid="zci-images"] figure, [data-testid="zci-images"] button, .tile--img',
      // The figure carries the source page title (h3[title] and the thumbnail's
      // own alt) plus the source domain in a <p>; related-search chips carry
      // their label in a bare <div>.
      text: 'figcaption, h3, p, div, .tile__title, .tile__body',
      // Blocking only the <img> would leave the caption — and therefore the
      // blocked word itself — on screen, so hide the whole tile.
      tile: '[data-testid="zci-images"] figure'
    }
  },
  brave: {
    containers: '#results .snippet[data-type="web"], .snippet[data-type="web"]',
    resultsAnchor: '#results',
    images: '.image-result img',
    imageContext: {
      container: '.image-result',
      text: '.image-metadata-source, .image-metadata-title'
    }
  },
  yahoo: {
    containers: '.algo, .dd',
    resultsAnchor: '#web, #results, .searchCenterMiddle',
    images: '.img img',
    imageContext: {
      container: 'li',
      text: '.title, .url'
    }
  },
  yandex: {
    // Keep selectors broad enough for different Yandex result layouts,
    // but still anchored to organic result containers.
    containers: '.serp-item, li.serp-item, .Organic, .organic, .main__result',
    resultsAnchor: '#search-result, .main__content, .serp-list',
    images: '.serp-item img, .ImagesContent img, .MMImage img',
    imageContext: {
      container: '.serp-item, .ImagesContent-Item, .MMImage, .Organic',
      text: '.OrganicTitle-Link, .OrganicTitle, .Snippet, .TextContainer, .Path, a[aria-label]'
    }
  }
};

// Social site specific selectors - target post containers (not whole feeds)
const SOCIAL_SELECTORS = {
  reddit: {
    // New Reddit uses data-testid post containers; include classic .Post as fallback
    containers: 'div[data-testid="post-container"], article[data-testid="post-container"], .Post'
  },
  twitter: {
    // Twitter/X tweet articles
    containers: 'article[data-testid="tweet"], article[data-testid="tweetResult"]'
  },
  mastodon: {
    // Mastodon instances commonly use article.status or status__wrapper
    containers: 'article.status, div.status__wrapper, article[role="article"]'
  }
};

// Utility functions
function log(message, ...args) {
  const isError = typeof message === 'string' && message.toLowerCase().startsWith('error');
  if (!debugMode && !isError) {
    return;
  }
  const prefix = 'BlockNSFW:';
  if (isError) {
    console.error(`${prefix} ${message}`, ...args);
  } else {
    console.log(`${prefix} ${message}`, ...args);
  }
}

function debounce(func, delay) {
  // Each debounced function gets its OWN timer. Previously they shared a single
  // module-level `debounceTimer`, so the page-text scan, search-result and
  // social-post debouncers kept clearing each other's timers and only the
  // last-scheduled one ever fired — dynamic-content filtering was unreliable.
  let timer = null;
  return function executedFunction(...args) {
    const later = () => {
      timer = null;
      func.apply(this, args);
    };
    clearTimeout(timer);
    timer = setTimeout(later, delay);
  };
}

// Map a user-facing strictness preset to verdictFor() thresholds. Keep these
// in sync with the labels in options.js (getAiStrictnessMeta). Lower numbers =
// more aggressive (blocks more). `balanced` is the default.
// The two models answer different questions, so a strictness preset means
// different numbers for each: NSFW.js needs a Porn+Hentai bar and a separate
// (deliberately high) Sexy bar, while the binary ViT needs one NSFW bar. Both
// tables live in shared/ai-image-models.js so the content script, the
// classifier and the tests cannot drift apart.
//
// The fallback below is only reachable if the shared module failed to load
// (content scripts are injected as a list; one failure should not silently
// disable filtering). It mirrors the balanced NSFW.js preset.
function getAiThresholds(level, modelId) {
  const registry = typeof AiImageModels !== 'undefined' ? AiImageModels : null;
  if (registry) return registry.getThresholds(modelId, level);
  switch (String(level || '').toLowerCase()) {
    case 'relaxed': return { pornHentai: 0.80, sexy: 0.97 };
    case 'strict':  return { pornHentai: 0.45, sexy: 0.80 };
    case 'balanced':
    default:        return { pornHentai: 0.60, sexy: 0.90 };
  }
}

// Minimum-evidence floor for whole-page text blocking. The linear model carries
// a positive prior (bias ~0.83 -> sigmoid ~0.70), so a content-sparse page — a
// brand-only title, an un-rendered SPA shell, an image-only page — has too few
// learned features to overcome it and collapses to a bias-driven "adult" score
// (~0.70-0.86) that has nothing to do with its actual words. That is exactly the
// "health"/"navix" false-positive class. Below this many normalized tokens we
// decline to score the page at all, so the bias can never trigger a block by
// itself. Genuinely adult short pages are still covered by URL/path keywords,
// the blocklist, and the AI image scanner. This is a quantity-of-evidence gate:
// it never looks at *which* words are present, only *how many*.
const MIN_TEXT_TOKENS_FOR_BLOCK = 12;

// AI Text Blocker thresholds. `block` = redirect on text alone (high
// confidence). `fuse` = lower bar that only redirects when the AI image blocker
// also flagged >=1 image on the page (corroborating evidence). Whole-page
// blocking has a higher false-positive cost than image blocking, so `block`
// stays conservative.
function getAiTextThresholds(level) {
  switch (String(level || '').toLowerCase()) {
    case 'relaxed': return { block: 0.96, fuse: 0.75 };
    case 'strict':  return { block: 0.80, fuse: 0.50 };
    case 'balanced':
    default:        return { block: 0.90, fuse: 0.60 };
  }
}

// Settings and data loading
async function loadSettings() {
  try {
    const result = await browserAPI.storage.local.get([
      'pblocker_settings',
      'pblocker_whitelist',
      'pblocker_temp_disable_until',
      'pblocker_subscriptions',
      'pblocker_subscription_rules'
    ]);
    loadSubscriptionRules(result.pblocker_subscriptions, result.pblocker_subscription_rules);
    
    const settings = result.pblocker_settings || {
      enabled: true,
      useSmartBlocking: true,
      imageFilterLevel: IMAGE_FILTER_LEVELS.STRICT,
      customPatterns: [],
      customKeywordList: [],
      trustedImageDomains: [],
      blockedPageType: 'default',
      customBlockedPageUrl: '',
      plainBlockedPageHtml: '',
      searchResultTreatment: 'hide',
      searchSummaryEnabled: true,
      blockCountDisplay: 'badge',
      facebookReelsEnabled: false,
      instagramReelsEnabled: false,
      aiImageBlocker: false,
      aiImageScanAllSites: true,
      aiImageModel: 'nsfwjs',
      aiStrictness: 'balanced',
      aiTextBlocker: false,
      aiTextStrictness: 'balanced'
    };
    
    // Handle temporary disable with auto-revert
    const tempUntil = result.pblocker_temp_disable_until;
    if (typeof tempUntil === 'number') {
      if (Date.now() < tempUntil) {
        isEnabled = false;
      } else {
        // Auto-revert: clear temp flag and re-enable
        isEnabled = true;
        await browserAPI.storage.local.remove('pblocker_temp_disable_until');
        const updated = { ...settings, enabled: true };
        await browserAPI.storage.local.set({ pblocker_settings: updated });
      }
    } else {
      isEnabled = settings.enabled;
    }
    useSmartBlocking = settings.useSmartBlocking;
    imageFilterLevel = normalizeImageFilterLevel(settings.imageFilterLevel);
    customKeywordList = liveListEntries(settings.customKeywordList);
    resetCustomKeywordCache(); // entries may have changed; drop stale compiles
    customBlockPatterns = liveListEntries(settings.customPatterns);
    resetCustomPatternCache(); // entries may have changed; drop stale compiles
    trustedDomains = liveListEntries(settings.trustedImageDomains);
    debugMode = settings.debugMode === true;
    facebookReelsEnabled = settings.facebookReelsEnabled === true;
    instagramReelsEnabled = settings.instagramReelsEnabled === true;
    aiTextBlocker = settings.aiTextBlocker !== false;
    aiTextStrictness = settings.aiTextStrictness || 'balanced';
    anyTextFeatureOn = !!(useSmartBlocking || aiTextBlocker);

    // Store custom blocked page settings globally for access during blocking
    blockedPageType = settings.blockedPageType || 'default';
    customBlockedPageUrl = settings.customBlockedPageUrl || '';
    plainBlockedPageHtml = settings.plainBlockedPageHtml || '';

    // Read once here rather than per result: hideElement runs in a tight loop
    // over every container on the page.
    searchResultTreatment = normalizeSearchResultTreatment(settings.searchResultTreatment);
    searchSummaryEnabled = settings.searchSummaryEnabled !== false;
    blockCountDisplay = normalizeBlockCountDisplay(settings.blockCountDisplay);
    
    // Initialize AI image blocker if available
    if (typeof window.AIImageBlocker !== 'undefined' &&
        window.AIImageBlocker &&
        typeof window.AIImageBlocker.init === 'function') {
      window.AIImageBlocker.init({
        ...settings,
        enabled: isEnabled,
        aiThresholds: getAiThresholds(settings.aiStrictness, settings.aiImageModel)
      });
    }

    // Warm up the AI text classifier model so the first page scan is instant.
    if (isEnabled && aiTextBlocker) {
      ensureTextModelLoaded();
    }

    log('Settings loaded', { isEnabled, useSmartBlocking, imageFilterLevel });
  } catch (error) {
    log('Error loading settings:', error);
  }
}

function isFacebookHost(hostname = window.location.hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'facebook.com' || host === 'm.facebook.com' || host.endsWith('.facebook.com');
}

function isFacebookReelsRoute(pathname = window.location.pathname, search = window.location.search) {
  const path = String(pathname || '').toLowerCase();
  if (path === '/reel' || path.startsWith('/reel/') || path === '/reels' || path.startsWith('/reels/')) {
    return true;
  }

  try {
    const params = new URLSearchParams(search || '');
    return String(params.get('sk') || '').toLowerCase() === 'reels';
  } catch (_) {
    return false;
  }
}

function ensureFacebookReelsStyle() {
  const existing = document.getElementById(FACEBOOK_REELS_STYLE_ID);
  if (!facebookReelsEnabled || !isFacebookHost()) {
    if (existing) existing.remove();
    return;
  }

  const css = `
    [data-pblocker-hide-reel="true"],
    [data-pblocker-hide-reel-link="true"] {
      display: none !important;
    }
  `;

  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }

  const style = document.createElement('style');
  style.id = FACEBOOK_REELS_STYLE_ID;
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function clearFacebookReelsMarks() {
  document.querySelectorAll('[data-pblocker-hide-reel="true"]').forEach((node) => {
    delete node.dataset.pblockerHideReel;
  });
  document.querySelectorAll('[data-pblocker-hide-reel-link="true"]').forEach((node) => {
    delete node.dataset.pblockerHideReelLink;
  });
}

function markFacebookReelsEntryPoints() {
  const selectors = [
    'a[href*="/reel/"]',
    'a[href*="/reels/"]',
    'a[href*="sk=reels"]',
    '[href*="/reel/"][role="link"]',
    '[href*="/reels/"][role="link"]',
    '[aria-label*="Reels" i]'
  ];

  document.querySelectorAll(selectors.join(',')).forEach((node) => {
    node.dataset.pblockerHideReelLink = 'true';
    const container = node.closest('[role="article"], [role="listitem"], [role="gridcell"], [data-pagelet]');
    if (container && container !== document.body && container !== document.documentElement) {
      container.dataset.pblockerHideReel = 'true';
    }
  });
}

function enforceFacebookReelsBlock() {
  if (!isFacebookHost()) {
    return;
  }

  if (!facebookReelsEnabled) {
    clearFacebookReelsMarks();
    ensureFacebookReelsStyle();
    return;
  }

  if (isFacebookReelsRoute()) {
    try {
      const redirectTarget = `${window.location.origin}/`;
      if (window.location.href !== redirectTarget) {
        window.location.replace(redirectTarget);
      }
    } catch (error) {
      log('Facebook reels redirect failed:', error);
    }
    return;
  }

  ensureFacebookReelsStyle();
  markFacebookReelsEntryPoints();
}

function isInstagramHost(hostname = window.location.hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'instagram.com' || host === 'www.instagram.com' || host.endsWith('.instagram.com');
}

function isInstagramReelsRoute(pathname = window.location.pathname) {
  const path = String(pathname || '').toLowerCase();
  return path === '/reel' || path.startsWith('/reel/') || path === '/reels' || path.startsWith('/reels/');
}

function ensureInstagramReelsStyle() {
  const existing = document.getElementById(INSTAGRAM_REELS_STYLE_ID);
  if (!instagramReelsEnabled || !isInstagramHost()) {
    if (existing) existing.remove();
    return;
  }

  const css = `
    [data-pblocker-hide-ig-reel="true"],
    [data-pblocker-hide-ig-reel-link="true"] {
      display: none !important;
    }
  `;

  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }

  const style = document.createElement('style');
  style.id = INSTAGRAM_REELS_STYLE_ID;
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function clearInstagramReelsMarks() {
  document.querySelectorAll('[data-pblocker-hide-ig-reel="true"]').forEach((node) => {
    delete node.dataset.pblockerHideIgReel;
  });
  document.querySelectorAll('[data-pblocker-hide-ig-reel-link="true"]').forEach((node) => {
    delete node.dataset.pblockerHideIgReelLink;
  });
}

function markInstagramReelsEntryPoints() {
  const selectors = [
    'a[href*="/reel/"]',
    'a[href*="/reels/"]',
    'a[href*="/reels"]',
    '[href*="/reel/"][role="link"]',
    '[href*="/reels/"][role="link"]',
    '[aria-label*="Reels" i]'
  ];

  document.querySelectorAll(selectors.join(',')).forEach((node) => {
    node.dataset.pblockerHideIgReelLink = 'true';
    const container = node.closest('article, [role="listitem"], [role="gridcell"], main section');
    if (container && container !== document.body && container !== document.documentElement) {
      container.dataset.pblockerHideIgReel = 'true';
    }
  });
}

function enforceInstagramReelsBlock() {
  if (!isInstagramHost()) {
    return;
  }

  if (!instagramReelsEnabled) {
    clearInstagramReelsMarks();
    ensureInstagramReelsStyle();
    return;
  }

  if (isInstagramReelsRoute()) {
    try {
      const redirectTarget = `${window.location.origin}/`;
      if (window.location.href !== redirectTarget) {
        window.location.replace(redirectTarget);
      }
    } catch (error) {
      log('Instagram reels redirect failed:', error);
    }
    return;
  }

  ensureInstagramReelsStyle();
  markInstagramReelsEntryPoints();
}

function sendRuntimeMessageForResponse(message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response || null);
    };
    try {
      const maybePromise = browserAPI.runtime.sendMessage(message, finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(finish, () => finish(null));
      }
    } catch (_) {
      try {
        const maybePromise = browserAPI.runtime.sendMessage(message);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(finish, () => finish(null));
        } else {
          finish(null);
        }
      } catch (_) {
        finish(null);
      }
    }
  });
}

function cacheBackgroundHostVerdict(host, blocked) {
  if (!backgroundBlocklistHostCache.has(host) &&
      backgroundBlocklistHostCache.size >= BACKGROUND_HOST_CACHE_MAX) {
    backgroundBlocklistHostCache.delete(backgroundBlocklistHostCache.keys().next().value);
  }
  backgroundBlocklistHostCache.set(host, blocked === true);
}

async function flushBackgroundHostChecks() {
  backgroundHostCheckTimer = null;
  const hosts = Array.from(pendingBackgroundHostChecks.keys()).slice(0, 500);
  if (hosts.length === 0) return;
  const response = await sendRuntimeMessageForResponse({ type: 'check_blocklist_hosts', hosts });
  const succeeded = response?.success === true && Array.isArray(response.blockedHosts);
  const blockedHosts = new Set(succeeded
    ? response.blockedHosts.map(normalizeHost)
    : []);
  for (const host of hosts) {
    const resolvers = pendingBackgroundHostChecks.get(host) || [];
    pendingBackgroundHostChecks.delete(host);
    const blocked = blockedHosts.has(host);
    // A transport/service-worker failure is not evidence that a host is clean.
    // Resolve fail-open for this pass, but leave it uncached so a later pass can
    // retry instead of memoizing a dropped message for the page lifetime.
    if (succeeded) cacheBackgroundHostVerdict(host, blocked);
    resolvers.forEach(resolve => resolve(blocked));
  }
  if (pendingBackgroundHostChecks.size > 0 && !backgroundHostCheckTimer) {
    backgroundHostCheckTimer = setTimeout(flushBackgroundHostChecks, 0);
  }
}

function isHostBlockedByBackground(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return Promise.resolve(false);
  if (isHostInDefaultBlocklist(normalized)) return Promise.resolve(true);
  if (backgroundBlocklistHostCache.has(normalized)) {
    return Promise.resolve(backgroundBlocklistHostCache.get(normalized));
  }
  return new Promise(resolve => {
    const resolvers = pendingBackgroundHostChecks.get(normalized) || [];
    resolvers.push(resolve);
    pendingBackgroundHostChecks.set(normalized, resolvers);
    if (!backgroundHostCheckTimer) {
      backgroundHostCheckTimer = setTimeout(flushBackgroundHostChecks, 0);
    }
  });
}

function isUrlBlockedByBackground(url) {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Promise.resolve(false);
    }
    return isHostBlockedByBackground(parsed.hostname);
  } catch (_) {
    return Promise.resolve(false);
  }
}

async function hasAnyBackgroundBlockedUrl(urls) {
  const candidates = urls.filter(Boolean);
  if (candidates.length === 0) return false;
  const verdicts = await Promise.all(candidates.map(isUrlBlockedByBackground));
  return verdicts.some(Boolean);
}

async function warmCurrentPageBlocklistHost() {
  const host = normalizeHost(window.location.hostname);
  if (!host) return false;
  const blocked = await isHostBlockedByBackground(host);
  _cleanPageHostCache = null;
  return blocked;
}

// Check if current page hostname is whitelisted (respects temporary expirations + remote global whitelist)
async function isCurrentPageWhitelisted() {
  try {
    const result = await browserAPI.storage.local.get(['pblocker_whitelist', 'pblocker_remote_whitelist_v1']);
    const list = result.pblocker_whitelist || [];
    const now = Date.now();
    const hostname = location.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = location.pathname || '/';
    const pathMatches = (self.DomainValidate && self.DomainValidate.whitelistPathMatches)
      ? self.DomainValidate.whitelistPathMatches
      : (_p, storedPath) => !storedPath;
    const userWhitelisted = list.some(item => {
      const domain = (item.domain || '').toLowerCase();
      const valid = item.type === 'permanent' || (item.expiresAt && item.expiresAt > now);
      if (!valid) return false;
      const hostOk = hostname === domain || hostname.endsWith('.' + domain);
      return hostOk && pathMatches(pathname, item.path);
    });
    if (userWhitelisted) return true;
    const remoteWL = result.pblocker_remote_whitelist_v1 || [];
    return remoteWL.some(d => hostMatchesDomain(hostname, d));
  } catch (e) {
    return false;
  }
}

// Configurable threshold for metadata blocking (title/meta)
const METADATA_BLOCK_THRESHOLD = 1;
const PAGE_TEXT_SCAN_MAX_LINES = 48;
const PAGE_TEXT_SCAN_MIN_LINE_LENGTH = 12;
const PAGE_TEXT_SCAN_MATCH_THRESHOLD = 2;

function isExtensionStorePage() {
  const host = normalizeHost(window.location.hostname);
  return hostMatchesDomain(host, 'addons.mozilla.org') ||
    hostMatchesDomain(host, 'chromewebstore.google.com') ||
    hostMatchesDomain(host, 'chrome.google.com') ||
    hostMatchesDomain(host, 'microsoftedge.microsoft.com');
}

// `title/…/` entries from the user's own blocklist. Deliberately not gated on
// smart blocking, and not skipped on search engines: the user typed this
// pattern themselves, which is about as explicit an instruction as there is.
function checkCustomTitlePatterns() {
  if (!customPatternsMatchTitle(document.title || '', customBlockPatterns)) return false;
  const reason = `Page title matched one of your blocked-site patterns: "${document.title}"`;
  log(reason);
  notifyBackground('website_blocked', { reason, title: document.title });
  redirectToBlockedPage('custom_title_pattern');
  return true;
}

// Scan page title and meta tags for adult content
function checkPageMetadata() {
  // Skip search engines (users need to search)
  if (getSearchEngine()) return false;
  if (isExtensionStorePage()) return false;
  if (isLocalPage()) return false;
  if (!useSmartBlocking) return false;
  
  let textToCheck = document.title || '';
  
  // Collect text from meta tags
  const metaSelectors = [
    'meta[name="title"]', 
    'meta[property="og:title"]', 
    'meta[name="twitter:title"]',
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="keywords"]'
  ];
  
  const metaTags = document.querySelectorAll(metaSelectors.join(','));
  metaTags.forEach(meta => {
    const content = meta.getAttribute('content');
    if (content) textToCheck += ' ' + content;
  });
  
  const analysis = analyzeTextForAdultContent(textToCheck);
  
  const neutralMatches = analysis.totalMatches - analysis.safeMatches;
  if (neutralMatches >= METADATA_BLOCK_THRESHOLD) {
    const reason = `Page metadata contained explicit content: ${analysis.matchedKeywords.join(', ')}`;
    log(reason);
    
    notifyBackground('website_blocked', { 
      reason: reason,
      title: document.title
    });
    
    // Name the keyword that fired. Without it this block was undiagnosable:
    // the page says only "its title or metadata matched", and unlike the body
    // scan below it passed nothing for the blocked page to show.
    redirectToBlockedPage('metadata_scan', { matched: analysis.matchedKeywords.slice(0, 5) });
    return true;
  }
  
  return false;
}

function sanitizeTextForScan(text) {
  if (!text || typeof text !== 'string') return '';
  let value = text;
  if (value.length > MAX_TEXT_LENGTH) {
    value = value.slice(0, MAX_TEXT_LENGTH);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function getPageTextLinesForScan() {
  if (!document.body) return [];

  let sourceText = '';
  try {
    sourceText = document.body.innerText || document.body.textContent || '';
  } catch (_) {
    return [];
  }

  if (!sourceText) return [];

  return sourceText
    .split(/\n+/)
    .map(sanitizeTextForScan)
    .filter(line => line.length >= PAGE_TEXT_SCAN_MIN_LINE_LENGTH)
    .slice(0, PAGE_TEXT_SCAN_MAX_LINES);
}

// Last text slice this page was judged on, so an unchanged page is not
// re-scanned. Reset on SPA navigation alongside the other per-page caches.
let lastPageTextSignature = '';

function checkPageBodyText() {
  if (blockedTriggered) return false;
  if (getSearchEngine()) return false;
  if (isExtensionStorePage()) return false;
  if (isLocalPage()) return false;
  if (!useSmartBlocking || !document.body) return false;

  const lines = getPageTextLinesForScan();
  if (lines.length === 0) return false;

  // A feed that appends below the fold does not change the first 48 lines, so
  // re-analysing an identical slice is pure waste — 48 lines x 166 multilingual
  // substring scans x 7 compiled regexes, for a verdict already reached.
  const signature = `${lines.length} ${lines[0]} ${lines[lines.length - 1]}`;
  if (signature === lastPageTextSignature) return false;
  lastPageTextSignature = signature;

  let matchedLines = 0;
  const matchedKeywords = new Set();

  for (const line of lines) {
    const analysis = analyzeTextForAdultContent(line);
    if (!analysis.isAdult) continue;

    matchedLines++;
    analysis.matchedKeywords.forEach(keyword => matchedKeywords.add(keyword));

    if (matchedLines >= PAGE_TEXT_SCAN_MATCH_THRESHOLD) {
      const keywordSummary = Array.from(matchedKeywords).slice(0, 5);
      const reason = keywordSummary.length > 0
        ? `Page body contained repeated explicit content signals: ${keywordSummary.join(', ')}`
        : 'Page body contained repeated explicit content signals';

      log(reason);
      notifyBackground('website_blocked', {
        reason,
        title: document.title
      });
      redirectToBlockedPage('page_text_scan', { matched: keywordSummary });
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// AI Text Blocker: page-level multilingual classifier scan.
// Loads the linear model lazily, scores combined title+meta+body text, and
// redirects on a confident verdict (or a moderate verdict corroborated by AI
// image blocks on the same page).
// ---------------------------------------------------------------------------
const AI_TEXT_META_SELECTORS = [
  'meta[name="title"]',
  'meta[property="og:title"]',
  'meta[name="twitter:title"]',
  'meta[name="description"]',
  'meta[property="og:description"]',
  'meta[name="twitter:description"]',
  'meta[name="keywords"]'
];

function ensureTextModelLoaded() {
  if (textModelReady || textModelLoading || textModelFailed) return;
  if (typeof TextClassifier === 'undefined') { textModelFailed = true; return; }
  textModelLoading = true;
  let loaded = false;
  fetch(browserAPI.runtime.getURL('text-model.json'))
    .then(res => (res && res.ok) ? res.json() : null)
    .then(json => {
      const m = json ? TextClassifier.loadModel(json) : null;
      if (m) {
        textModel = m;
        textModelReady = true;
        loaded = true;
        log('AI Text Blocker model ready', { version: m.version, weights: m.weights.size });
      }
    })
    .catch(err => { log('AI Text Blocker model load failed:', err && err.message || err); })
    .finally(() => {
      textModelLoading = false;
      if (!loaded) textModelFailed = true; // fail open; do not retry every scan
      else if (textScanPending) runDeferredTextScan();
    });
}

// Re-run the scan once the model finishes loading, if one was requested while
// it was still loading. Re-checks gates (whitelist is async).
function runDeferredTextScan() {
  textScanPending = false;
  if (!isEnabled || blockedTriggered || !aiTextBlocker) return;
  isCurrentPageWhitelisted()
    .then(wl => { if (!wl) checkPageTextWithModel(); })
    .catch(() => {});
}

function gatherTextForModel() {
  const parts = [];
  if (document.title) parts.push(document.title);
  try {
    document.querySelectorAll(AI_TEXT_META_SELECTORS.join(',')).forEach(meta => {
      const content = meta.getAttribute('content');
      if (content) parts.push(content);
    });
  } catch (_) {}
  const lines = getPageTextLinesForScan();
  if (lines.length > 0) parts.push(lines.join(' '));
  let text = parts.join(' ');
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  return text;
}

function checkPageTextWithModel() {
  if (blockedTriggered) return false;
  if (!isEnabled || !aiTextBlocker) return false;
  if (getSearchEngine()) return false;        // users need to search
  if (isExtensionStorePage()) return false;
  if (isLocalPage()) return false;
  if (typeof TextClassifier === 'undefined' || !document.body) return false;

  if (!textModelReady || !textModel) {
    textScanPending = true;
    ensureTextModelLoaded();
    return false;
  }

  const text = gatherTextForModel();
  if (!text) return false;

  // Minimum-evidence guard: with too little text the score is driven by the
  // model's positive prior, not the page's words, so we don't trust it for a
  // block (text-only or image-fused). See MIN_TEXT_TOKENS_FOR_BLOCK.
  const normForCount = TextClassifier.normalizeForClassifier(text);
  const tokenCount = normForCount ? normForCount.split(' ').length : 0;
  if (tokenCount < MIN_TEXT_TOKENS_FOR_BLOCK) {
    if (debugMode) log(`AI text scan skipped — only ${tokenCount} token(s), below evidence floor`);
    return false;
  }

  let prob;
  try {
    prob = TextClassifier.scoreText(text, textModel);
  } catch (_) {
    return false; // fail open
  }
  if (typeof prob !== 'number' || prob < 0) return false;

  const thresholds = getAiTextThresholds(aiTextStrictness);
  const imageBlockCount = (globalThis.__pblockerAIImageBlockCount | 0);
  let verdict = TextClassifier.verdictForText(prob, thresholds, imageBlockCount);

  // TEMPORARY SAFETY CATCH — remove when text model v4 lands.
  //
  // The v3 model's vocabulary is inverted: it scores "videos" (+8.27) as a
  // stronger adult signal than "nude" (+0.27) or "naked" (-0.44), because the
  // adult training phrases average 1.7 words while the benign ones average 8,
  // so generic media words absorbed the positive signal. "youtube" (+3.74)
  // inherits its weight from "tube" through character n-grams alone. The
  // visible symptom was m.youtube.com blocked at 99% confidence.
  //
  // No threshold separates that, so until the model is retrained the text
  // score may not block a page on its own — it only counts when the AI image
  // scanner independently flagged something on the same page. That makes this
  // detector weaker, which is the right trade while it can't be trusted alone.
  if (verdict === 'block' && imageBlockCount < 1) {
    if (debugMode) {
      log(`AI text block withheld (score ${prob.toFixed(2)}, no image corroboration) — v3 model is unreliable alone`);
    }
    verdict = 'allow';
  }

  if (verdict === 'block' || verdict === 'fuse-block') {
    // Explain the verdict: pull the words on the page that pushed the linear
    // model's score up the most, so the blocked page can show *what text*
    // triggered it. Best-effort — never let this throw out of a block.
    let triggers = [];
    try {
      if (typeof TextClassifier.topContributors === 'function') {
        triggers = TextClassifier.topContributors(text, textModel, 6).map(t => t.feature);
      }
    } catch (_) {}
    const triggerNote = triggers.length > 0 ? ` [top signals: ${triggers.join(', ')}]` : '';
    const reason = verdict === 'fuse-block'
      ? `AI text+image classifier flagged this page (text score ${prob.toFixed(2)}, ${imageBlockCount} image(s) blocked)${triggerNote}`
      : `AI text classifier flagged this page (score ${prob.toFixed(2)})${triggerNote}`;
    log(reason);
    notifyBackground('website_blocked', { reason, title: document.title });
    redirectToBlockedPage('ai_text_scan', { matched: triggers, score: prob });
    return true;
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate an adult *site* name in text as a standalone token. A site name glued
// to other letters is part of a different word: substring matching on "erome"
// (a real adult site) blocked every page that said "Jerome". Delegates to
// shared/token-match.js so the rule is unit-tested; the local mirror below only
// runs if that module failed to load.
function indexOfSiteToken(lowerText, token, fromIndex) {
  if (typeof TokenMatch !== 'undefined' && TokenMatch.indexOfStandaloneToken) {
    return TokenMatch.indexOfStandaloneToken(lowerText, token, fromIndex);
  }
  if (!lowerText || !token) return -1;
  const isLetter = (ch) => !!ch && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
  let idx = lowerText.indexOf(token, fromIndex > 0 ? fromIndex : 0);
  while (idx !== -1) {
    const before = idx > 0 ? lowerText.charAt(idx - 1) : '';
    const after = lowerText.charAt(idx + token.length);
    if (!isLetter(before) && !isLetter(after)) return idx;
    idx = lowerText.indexOf(token, idx + 1);
  }
  return -1;
}

// Compiled `/pattern/` entries, keyed by their raw text. Compiling includes a
// timing probe (see shared/keyword-pattern.js), which is far too expensive to
// repeat per page scan — this runs once per entry and is cleared whenever the
// keyword list changes.
let customKeywordRegexCache = new Map();

function resetCustomKeywordCache() {
  customKeywordRegexCache = new Map();
}

function customKeywordRegex(raw) {
  if (customKeywordRegexCache.has(raw)) return customKeywordRegexCache.get(raw);
  let compiled = null;
  try {
    compiled = (typeof KeywordPattern !== 'undefined' && KeywordPattern.compileEntry)
      ? KeywordPattern.compileEntry(raw)
      : null;
  } catch (_) {
    compiled = null; // a bad pattern must never break the whole scan
  }
  customKeywordRegexCache.set(raw, compiled);
  return compiled;
}

function matchesCustomKeywords(lowerText) {
  for (let i = 0; i < customKeywordList.length; i++) {
    const raw = customKeywordList[i];
    const entry = (raw || '').toString().trim();
    if (!entry) continue;

    // A `/pattern/` entry is a regular expression; anything else stays a
    // literal, so lists written before this feature behave identically.
    if (typeof KeywordPattern !== 'undefined' && KeywordPattern.isRegexEntry(entry)) {
      const pattern = customKeywordRegex(entry);
      if (pattern && pattern.test(lowerText)) return true;
      continue;
    }

    const keyword = entry.toLowerCase();
    if (/^[a-z0-9]+$/i.test(keyword)) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
      if (pattern.test(lowerText)) return true;
    } else {
      if (lowerText.includes(keyword)) return true;
    }
  }
  return false;
}

// Content analysis functions
function analyzeTextForAdultContent(text) {
  if (!text || typeof text !== 'string') return { isAdult: false, riskMatches: 0, safeMatches: 0, totalMatches: 0, matchedKeywords: [] };

  let lowerText = text.toLowerCase();
  
  // Check custom blocked words first (always block if found)
  if (customKeywordList.length > 0) {
    if (matchesCustomKeywords(lowerText)) {
      return { isAdult: true, riskMatches: 100, safeMatches: 0, totalMatches: 100, matchedKeywords: ['Custom Blocked Word'] };
    }
  }

  // Multilingual strong-signal scan (covers CJK / Cyrillic / Arabic / Thai etc.
  // where English keyword regex + \b cannot match).
  const mlHit = containsMultilingualAdultKeyword(lowerText);
  if (mlHit) {
    return { isAdult: true, riskMatches: 100, safeMatches: 0, totalMatches: 100, matchedKeywords: [mlHit] };
  }

  const neutralThreshold = 2;
  let totalMatches = 0;
  let safeMatches = 0;
  let riskMatches = 0;
  let matchedKeywords = new Set();

  const evaluateContextWindow = (startIndex, length, options = {}) => {
    const windowStart = Math.max(0, startIndex - CONTEXT_WINDOW);
    const windowEnd = Math.min(lowerText.length, startIndex + length + CONTEXT_WINDOW);
    const windowText = lowerText.slice(windowStart, windowEnd);

    const hasSafeSignal = SAFE_CONTEXT_KEYWORDS.some(keyword => windowText.includes(keyword));
    if (hasSafeSignal) {
      safeMatches++;
      return;
    }

    const hasRiskSignal = RISK_CONTEXT_KEYWORDS.some(keyword => windowText.includes(keyword));
    if (hasRiskSignal || options.assumeRiskWhenNeutral) {
      riskMatches++;
    }
  };

  const processLiteralMatches = (keyword, options = {}) => {
    if (!keyword) return;
    let index = indexOfSiteToken(lowerText, keyword, 0);
    while (index !== -1) {
      totalMatches++;
      matchedKeywords.add(keyword);
      evaluateContextWindow(index, keyword.length, options);
      index = indexOfSiteToken(lowerText, keyword, index + keyword.length);
    }
  };

  const processWordBoundaryMatches = keyword => {
    if (!keyword) return;
    const pattern = new RegExp(`\\b${keyword}\\b`, 'gi');
    let match;
    while ((match = pattern.exec(lowerText)) !== null) {
      totalMatches++;
      matchedKeywords.add(keyword);
      evaluateContextWindow(match.index, keyword.length, { assumeRiskWhenNeutral: false });
    }
  };

  ADULT_CONTENT_KEYWORDS.forEach(keyword => processLiteralMatches(keyword, { assumeRiskWhenNeutral: true }));
  ADULT_CONTEXT_KEYWORDS.forEach(keyword => processWordBoundaryMatches(keyword));

  if (totalMatches === 0) {
    return { isAdult: false, riskMatches, safeMatches, totalMatches, matchedKeywords: [] };
  }

  if (riskMatches > 0) {
    return { isAdult: true, riskMatches, safeMatches, totalMatches, matchedKeywords: Array.from(matchedKeywords) };
  }

  const neutralMatches = totalMatches - safeMatches;
  return { isAdult: neutralMatches >= neutralThreshold, riskMatches, safeMatches, totalMatches, matchedKeywords: Array.from(matchedKeywords) };
}

/**
 * Check whether text contains benign context that explains away ambiguous
 * keywords like "nude", "adult", "sex", "naked" in e-commerce/news/education.
 */
function hasBenignImageContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const term of BENIGN_IMAGE_CONTEXT) {
    if (lower.includes(term)) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.neutralThreshold=2] - How many neutral matches trigger a block.
 * @param {boolean} [opts.useBenignContext=false] - When true, matches that co-occur
 *   with benign context terms (e-commerce, news, sports) are treated as safe.
 */
function containsAdultKeywords(text, opts) {
  if (!text || typeof text !== 'string') return false;
  const neutralThreshold = (opts && typeof opts.neutralThreshold === 'number') ? opts.neutralThreshold : 2;
  const useBenignContext = (opts && opts.useBenignContext) || false;

  let input = text;
  if (input.length > MAX_TEXT_LENGTH) {
    input = input.slice(0, MAX_TEXT_LENGTH);
  }

  const lowerText = input.toLowerCase();
  if (customKeywordList.length > 0) {
    if (matchesCustomKeywords(lowerText)) {
      return true;
    }
  }

  if (containsMultilingualAdultKeyword(lowerText)) {
    return true;
  }

  const benignDetected = useBenignContext && hasBenignImageContext(lowerText);

  let totalMatches = 0;
  let safeMatches = 0;
  let riskMatches = 0;

  const evaluateContextWindow = (startIndex, length, evalOpts = {}) => {
    const windowStart = Math.max(0, startIndex - CONTEXT_WINDOW);
    const windowEnd = Math.min(lowerText.length, startIndex + length + CONTEXT_WINDOW);
    const windowText = lowerText.slice(windowStart, windowEnd);

    const hasSafeSignal = SAFE_CONTEXT_KEYWORDS.some(keyword => windowText.includes(keyword));
    if (hasSafeSignal) {
      safeMatches++;
      return;
    }

    if (benignDetected) {
      for (const term of BENIGN_IMAGE_CONTEXT) {
        if (windowText.includes(term)) {
          safeMatches++;
          return;
        }
      }
    }

    const hasRiskSignal = RISK_CONTEXT_KEYWORDS.some(keyword => windowText.includes(keyword));
    if (hasRiskSignal || evalOpts.assumeRiskWhenNeutral) {
      riskMatches++;
    }
  };

  const processLiteralMatches = (keyword, evalOpts = {}) => {
    if (!keyword) return;
    let index = indexOfSiteToken(lowerText, keyword, 0);
    while (index !== -1) {
      totalMatches++;
      evaluateContextWindow(index, keyword.length, evalOpts);
      index = indexOfSiteToken(lowerText, keyword, index + keyword.length);
    }
  };

  const processWordBoundaryMatches = (keyword) => {
    if (!keyword) return;

    if (benignDetected && AMBIGUOUS_PATH_KEYWORDS.test(keyword)) {
      return;
    }

    const pattern = new RegExp(`\\b${keyword}\\b`, 'gi');
    let match;
    while ((match = pattern.exec(lowerText)) !== null) {
      totalMatches++;
      evaluateContextWindow(match.index, keyword.length, { assumeRiskWhenNeutral: false });
    }
  };

  ADULT_CONTENT_KEYWORDS.forEach(keyword => processLiteralMatches(keyword, { assumeRiskWhenNeutral: true }));
  ADULT_CONTEXT_KEYWORDS.forEach(keyword => processWordBoundaryMatches(keyword));

  if (totalMatches === 0) {
    return false;
  }

  if (riskMatches > 0) {
    return true;
  }

  const neutralMatches = totalMatches - safeMatches;
  return neutralMatches >= neutralThreshold;
}

function isAdultURL(url) {
  if (!url) return false;
  
  try {
    const urlObj = new URL(url);
    const hostname = normalizeHost(urlObj.hostname);
    // Sites the user blocked themselves count too — otherwise their custom
    // blocklist would stop navigation but still let the site's images through
    // image search, embeds and hotlinks.
    return isHostInDefaultBlocklist(hostname)
      || matchesAdultKeywordHost(hostname)
      || matchesCustomBlockPattern(url, hostname);
  } catch (error) {
    log('Error checking adult URL:', error);
    return false;
  }
}

async function shouldBlockElement(element, backgroundBlockedLink, opts) {
  if (!element || !isEnabled) return false;

  // `explicitOnly` containers are judged on stated intent rather than on the
  // heuristic term lists: a blocklisted link still blocks them, and so does a
  // word from the user's own list, but the built-in keyword scoring does not
  // get a vote. Reserved for containers holding long reference prose, where
  // that scoring produces false positives a snippet never would.
  const explicitOnly = !!(opts && opts.explicitOnly);
  const textMatches = explicitOnly
    ? (value) => matchesCustomKeywords(String(value || '').slice(0, MAX_TEXT_LENGTH).toLowerCase())
    : (value) => containsAdultKeywords(value);

  try {
    // Get text content from element and its children
    const textContent = element.textContent || '';
    const title = element.title || '';
    const alt = element.alt || '';

    // Check href attributes first (most reliable)
    const links = Array.from(element.querySelectorAll('a[href]'));
    for (const link of links) {
      try {
        if (isAdultURL(link.href)) {
          if (debugMode) {
            log('Blocking element due to adult URL:', link.href);
          }
          return true;
        }
      } catch (linkError) {
        log('Error checking link:', linkError);
      }
    }

    const blockedByBackground = backgroundBlockedLink === undefined
      ? await hasAnyBackgroundBlockedUrl(links.map(link => link.href))
      : backgroundBlockedLink;
    if (blockedByBackground) {
      if (debugMode) log('Blocking element due to background blocklist verdict');
      return true;
    }

    // Keep network-backed Reddit metadata checks sequential. Host verdicts
    // above have already been registered together for one background batch.
    for (const link of links) {
      try {
        // Check if it's a Reddit link to NSFW subreddit
        if (useSmartBlocking && isRedditURL(link.href)) {
          const shouldBlock = await shouldBlockRedditPage(link.href);
          if (shouldBlock) {
            if (debugMode) {
              log('Blocking element due to Reddit NSFW subreddit:', link.href);
            }
            return true;
          }
        }
      } catch (linkError) {
        log('Error checking link:', linkError);
        // Continue checking other links
      }
    }
    
    // Check text content for adult keywords (be more conservative)
    if (textMatches(textContent)) {
      if (debugMode) {
        log('Blocking element due to text content:', textContent.substring(0, 100));
      }
      return true;
    }
    
    if (textMatches(title)) {
      if (debugMode) {
        log('Blocking element due to title:', title);
      }
      return true;
    }
    
    if (textMatches(alt)) {
      if (debugMode) {
        log('Blocking element due to alt text:', alt);
      }
      return true;
    }
    
    return false;
  } catch (error) {
    log('Error in shouldBlockElement:', error);
    return false; // Don't block if there's an error
  }
}

// Search engine specific filtering
function getSearchEngine() {
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  
  if (hostname.includes('google.')) return 'google';
  if (hostname.includes('bing.')) return 'bing';
  if (hostname.includes('duckduckgo.') || hostname === 'duckduckgo.com' || hostname.includes('ddg.')) return 'duckduckgo';
  if (hostname === 'search.brave.com' || hostname === 'safe.search.brave.com') return 'brave';
  if (hostname.includes('yahoo.')) return 'yahoo';
  if (isYandexSearchHost(hostname) &&
      (pathname.startsWith('/search') || pathname.startsWith('/images') || params.has('text'))) {
    return 'yandex';
  }
  
  return null;
}

function getCurrentSearchQuery() {
  try {
    const engine = getSearchEngine();
    if (!engine) return '';

    const params = new URLSearchParams(window.location.search);
    if (engine === 'google' || engine === 'bing' || engine === 'duckduckgo') {
      return params.get('q') || '';
    }
    if (engine === 'yahoo') {
      return params.get('p') || '';
    }
    if (engine === 'yandex') {
      return params.get('text') || '';
    }
  } catch (_) {}

  return '';
}

function shouldBlockCurrentSearchQuery() {
  const rawQuery = getCurrentSearchQuery();
  const query = safelyDecodeUrlCandidate(rawQuery).toLowerCase().trim();
  if (!query) return false;

  // Queries with clear recovery / educational intent should stay allowed.
  const hasSafeIntent = SAFE_CONTEXT_KEYWORDS.some(keyword => query.includes(keyword));
  if (hasSafeIntent) return false;

  if (ADULT_CONTENT_KEYWORDS.some(keyword => indexOfSiteToken(query, keyword, 0) !== -1)) {
    return true;
  }

  if (containsMultilingualAdultKeyword(query)) {
    return true;
  }

  return /\b(porn|porno|pornography|xxx|nsfw|hentai|nude|naked|erotic|sex|fetish|onlyfans|rule34)\b/i.test(query);
}

function isLikelyImageSearchResultImage(img) {
  try {
    if (!img || !isImagesSearchContext()) return false;
    if (img.closest('header, nav, form, [role="search"]')) return false;

    const engine = getSearchEngine();
    if (engine === 'brave') {
      return !!img.closest('.image-result');
    }

    if (engine === 'yandex') {
      if (img.closest('a[href*="img_url="], a[href*="rpt=simage"]')) return true;
      if (img.closest('.serp-item, .ImagesContent-Item, .MMImage')) return true;
      const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
      return !!rect && rect.width >= 80 && rect.height >= 80;
    }

    return true;
  } catch (_) {
    return false;
  }
}

// Social site detection
function getSocialSite() {
  try {
    const host = window.location.hostname.toLowerCase();
    // Reddit
    if (host.endsWith('reddit.com') || host.includes('reddit.')) return 'reddit';
    // Twitter/X
    if (host.endsWith('twitter.com') || host.includes('twitter.') || host === 'x.com' || host.endsWith('.x.com') || host.includes('x.com')) return 'twitter';
    // Mastodon (many instances); detect via host or meta generator
    if (host.includes('mastodon')) return 'mastodon';
    const gen = document.querySelector('meta[name="generator"]');
    if (gen && /mastodon/i.test(gen.getAttribute('content') || '')) return 'mastodon';
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    if (ogSite && /mastodon/i.test(ogSite.getAttribute('content') || '')) return 'mastodon';
  } catch (_) {}
  return null;
}

// Reddit-specific functions
function isRedditURL(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('reddit.com');
  } catch (error) {
    log('Error checking Reddit URL:', error);
    return false;
  }
}

function extractSubredditFromURL(url) {
  try {
    const urlObj = new URL(url);
    // Match patterns like /r/subredditname or /r/subredditname/posts/...
    const match = urlObj.pathname.match(/^\/r\/([^/]+)/);
    return match ? match[1] : null;
  } catch (error) {
    log('Error extracting subreddit from URL:', error);
    return null;
  }
}

async function checkRedditSubredditNSFW(subredditName) {
  if (!useSmartBlocking) return false;
  if (!subredditName) return false;
  
  const cacheKey = subredditName.toLowerCase();
  const now = Date.now();
  
  // Check cache first
  if (redditNSFWCache.has(cacheKey)) {
    const cached = redditNSFWCache.get(cacheKey);
    if (now - cached.timestamp < REDDIT_CACHE_DURATION) {
      if (debugMode) {
        log(`Reddit cache hit for r/${subredditName}: ${cached.isNSFW}`);
      }
      return cached.isNSFW;
    }
  }
  
  try {
    if (debugMode) {
      log(`Checking Reddit API for r/${subredditName}...`);
    }
    
    // Fetch subreddit info from Reddit API
    const apiUrl = `https://www.reddit.com/r/${subredditName}/about.json`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'BlockNSFW Extension'
      }
    });
    
    if (!response.ok) {
      if (debugMode) {
        log(`Reddit API error for r/${subredditName}: ${response.status}`);
      }
      return false;
    }
    
    const data = await response.json();
    const isNSFW = data?.data?.over18 || false;
    
    // Cache the result
    redditNSFWCache.set(cacheKey, {
      isNSFW: isNSFW,
      timestamp: now
    });
    
    if (debugMode) {
      log(`Reddit r/${subredditName} NSFW status: ${isNSFW}`);
    }
    
    return isNSFW;
    
  } catch (error) {
    log('Error checking Reddit subreddit NSFW status:', error);
    return false;
  }
}

async function shouldBlockRedditPage(url) {
  if (!useSmartBlocking) return false;
  if (!isRedditURL(url)) return false;
  
  const subreddit = extractSubredditFromURL(url);
  if (!subreddit) return false;
  
  // Check if subreddit is NSFW
  const isNSFW = await checkRedditSubredditNSFW(subreddit);
  
  if (isNSFW && debugMode) {
    log(`Blocking Reddit page - r/${subreddit} is marked as NSFW`);
  }
  
  return isNSFW;
}

// Social post-level blocking (synchronous): detect NSFW labels or adult-domain links
function shouldBlockSocialPost(element, site) {
  try {
    if (!element || !site) return false;
    const text = (element.textContent || '').toLowerCase();

    // 1) NSFW/Sensitive labels
    if (site === 'reddit') {
      // Reddit posts commonly show an "NSFW" badge
      if (useSmartBlocking && text.includes('nsfw')) return true;
      // Badge/aria-based hints
      const badge = element.querySelector('[data-testid*="nsfw"], [aria-label*="NSFW"], .icon-nsfw, .PostBadges');
      if (useSmartBlocking && badge && (badge.textContent || '').toLowerCase().includes('nsfw')) return true;
    } else if (site === 'twitter') {
      // Twitter/X sensitive media gating
      if (useSmartBlocking && (text.includes('sensitive content') || text.includes('may contain sensitive content'))) return true;
      const warn = element.querySelector('[data-testid*="Sensitive"], [aria-label*="Sensitive"]');
      if (useSmartBlocking && warn) return true;
    } else if (site === 'mastodon') {
      // Mastodon content warnings (CW) often mark sensitive posts
      const cw = element.querySelector('.cw, .content-warning, .status__content__spoiler');
      if (cw) {
        const cwText = (cw.textContent || '').toLowerCase();
        if (useSmartBlocking && (cwText.includes('nsfw') || cwText.includes('sensitive'))) return true;
      }
    }

    // 2) Links to adult domains inside the post
    const anchors = element.querySelectorAll('a[href], a[data-expanded-url]');
    for (const a of anchors) {
      const expanded = a.getAttribute('data-expanded-url');
      const url = expanded || a.href || '';
      if (!url) continue;
      try {
        if (isAdultURL(url)) return true;
        const u = new URL(url, window.location.href);
        const host = u.hostname.toLowerCase();
        if (isHostInDefaultBlocklist(host) || matchesAdultKeywordHost(host)) return true;
      } catch (_) {
        // If URL parsing fails, fall back to keyword check on the raw value
        if (containsAdultKeywords(url)) return true;
      }
    }

    return false;
  } catch (_) {
    return false;
  }
}

async function hasBackgroundBlockedLink(element) {
  if (!element || typeof element.querySelectorAll !== 'function') return false;
  const anchors = element.querySelectorAll('a[href], a[data-expanded-url]');
  const urls = Array.from(anchors, anchor =>
    anchor.getAttribute('data-expanded-url') || anchor.href || ''
  );
  return hasAnyBackgroundBlockedUrl(urls);
}

function isSearchResultContainer(element) {
  // Much simpler and more reliable check for individual search results
  
  const searchEngine = getSearchEngine();
  
  // DuckDuckGo specific checks
  if (searchEngine === 'duckduckgo') {
    // DuckDuckGo uses different structures, be more flexible. The two verticals
    // nest the title the opposite way round — a web result is `h2 > a`, a video
    // result is `a > article > h2` — so both orders have to be accepted or the
    // videos tab is silently skipped.
    const hasDDGTitle = element.querySelector('h2 a, h3 a, a h2, a h3, a[data-testid="result-title-a"], .result__title a, [data-testid="result-title-a"]');
    // On the web vertical the testid is on the result element itself; once
    // lifted to the wrapping <li> it sits on a descendant instead.
    const hasDataTestId = (element.hasAttribute('data-testid') && element.getAttribute('data-testid').includes('result'))
      || !!element.querySelector('[data-testid="result"]');

    if (hasDDGTitle || hasDataTestId) {
      const hasText = element.textContent && element.textContent.trim().length > 20;
      if (debugMode && hasText) {
        log('DuckDuckGo result container found:', element.className, element.getAttribute('data-testid'));
      }
      return hasText;
    }
    return false;
  }

  if (searchEngine === 'brave') {
    const hasBraveTitle = element.querySelector(
      'a.l1, .title.search-snippet-title, .search-snippet-title'
    );
    const hasBraveSnippet = element.querySelector(
      '.generic-snippet .content, .snippet-description, .snippet-content'
    );
    const hasText = element.textContent && element.textContent.trim().length > 20;

    if (!hasBraveTitle || !hasText) return false;
    if (!element.matches?.('.snippet[data-type="web"]')) return false;
    if (element.matches?.('[data-type="ad"]')) return false;
    if (!hasBraveSnippet && element.querySelectorAll('img').length > 2) return false;

    return true;
  }

  if (searchEngine === 'yandex') {
    const hasYandexTitle = element.querySelector(
      '.OrganicTitle-Link, .OrganicTitle, a.Link.OrganicTitle-Link, a[href] h2, a[href] h3'
    );
    const hasYandexSnippet = element.querySelector(
      '.Snippet, .TextContainer, .OrganicText, .ExtendedText, .Path, .organic__text'
    );
    const hasText = element.textContent && element.textContent.trim().length > 20;

    if (!hasYandexTitle || !hasText) return false;
    if (!hasYandexSnippet && element.querySelectorAll('img').length > 2) return false;
    if (element.closest('nav, header, footer, form, .search-form, .navigation, .Tabs')) {
      return false;
    }

    return true;
  }
  
  // General check for other search engines
  // Must have a clickable title link (this is the key identifier of a search result)
  const titleLink = element.querySelector('h1 a, h2 a, h3 a, a h1, a h2, a h3');
  if (!titleLink) return false;
  
  // Must have meaningful text content
  const hasText = element.textContent && element.textContent.trim().length > 20;
  if (!hasText) return false;
  
  // Skip if it's clearly a navigation or interface element
  if (element.closest('nav, header, footer, form, .search-form')) {
    return false;
  }
  
  // Skip Google's specific interface elements
  if (element.id === 'searchform' || element.closest('#searchform, .searchbox')) {
    return false;
  }
  
  // Prevent blocking of image grids/carousels as single results
  // If a container has multiple images, it's likely a collection (images block, shopping carousel, etc.)
  // We want to let filterImages/filterMedia handle individual items inside.
  const imgCount = element.querySelectorAll('img').length;
  if (imgCount > 2) {
    return false;
  }
  
  return true;
}

// Every selector an engine wants examined, including the containers judged on
// explicit signals only. Both the full pass and the observer's incremental path
// read this, so they cannot drift apart.
function searchContainerSelector(selectors) {
  if (!selectors || !selectors.containers) return null;
  return selectors.explicitOnlyContainers
    ? `${selectors.containers}, ${selectors.explicitOnlyContainers}`
    : selectors.containers;
}

// Resolve a matched element to the result container to act on, or null when
// there is nothing to act on yet.
//
// Returning null for a row that is not yet recognisable as a result is the
// point: these pages ship no results in their HTML at all and hydrate row by
// row, so a container can exist with its title still missing. Marking such a
// row off on the way past — which both paths used to do — meant it was never
// looked at again once it filled in.
function resolveResultContainer(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
  const engine = getSearchEngine();
  const selectors = engine ? SEARCH_SELECTORS[engine] : null;
  if (!selectors) return null;

  const container = selectors.resultRoot
    ? (element.closest(selectors.resultRoot) || element)
    : element;

  if (container.dataset.pblockerProcessed === 'true') return null;
  if (!isSearchResultContainer(container)) return null;

  const explicitOnlySelector = selectors.explicitOnlyContainers || '';
  return {
    container,
    explicitOnly: !!explicitOnlySelector && !!container.matches?.(explicitOnlySelector)
  };
}

async function filterSearchResults() {
  const searchEngine = getSearchEngine();
  if (!searchEngine || !SEARCH_SELECTORS[searchEngine]) return;

  const selectors = SEARCH_SELECTORS[searchEngine];
  let blockedCount = 0;
  let processedCount = 0;

  // Only filter individual search result containers, NOT search functionality
  const containers = document.querySelectorAll(searchContainerSelector(selectors));

  if (debugMode) {
    log(`Found ${containers.length} potential result containers on ${searchEngine}`);
  }
  
  const candidates = [];
  const claimed = new Set();
  for (let index = 0; index < containers.length; index++) {
    try {
      // Several matched elements can lift to the same wrapping row, so the
      // resolved container — not the match — is what gets claimed.
      const resolved = resolveResultContainer(containers[index]);
      if (!resolved) {
        if (debugMode) log(`[${index}] Skipped - not a result container yet (will be re-checked)`);
        continue;
      }
      if (claimed.has(resolved.container)) continue;
      claimed.add(resolved.container);
      resolved.container.dataset.pblockerProcessed = 'true';
      processedCount++;
      candidates.push({ container: resolved.container, index, explicitOnly: resolved.explicitOnly });
    } catch (error) {
      log(`Error processing container ${index}:`, error);
      // Continue processing other results even if one fails
    }
  }

  // Register every result's hosts before yielding, allowing the pending-host
  // coordinator to send one message for the whole search pass.
  const backgroundVerdicts = await Promise.all(
    candidates.map(({ container }) => hasBackgroundBlockedLink(container))
  );

  // Keep per-result Reddit metadata checks sequential; only the local
  // background host lookups above are parallelized.
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const { container, index, explicitOnly } = candidates[candidateIndex];
    try {
      if (debugMode) {
        const title = container.querySelector('h1, h2, h3')?.textContent || 'No title';
        log(`[${index}] Checking result: "${title.substring(0, 50)}..."${explicitOnly ? ' (explicit signals only)' : ''}`);
      }
      const shouldBlock = await shouldBlockElement(container, backgroundVerdicts[candidateIndex], { explicitOnly });
      if (debugMode) log(`[${index}] Result should be blocked: ${shouldBlock}`);
      if (shouldBlock) {
        hideElement(container, 'search-result');
        blockedCount++;
        if (debugMode) log(`[${index}] Blocked result successfully`);
      }
    } catch (error) {
      log(`Error processing container ${index}:`, error);
    }
  }
  
  if (debugMode) {
    log(`Processed ${processedCount} containers, blocked ${blockedCount} results on ${searchEngine}`);
  }

  if (blockedCount > 0) {
    notifyBackground('search_result_filtered', { count: blockedCount });
    addBlockedResultCount(blockedCount);
  }
  updateBlockedResultsNotice();
}

// Image filtering
function filterImages() {
  // Register all images with the IntersectionObserver so classification
  // occurs only when they become visible (handles lazy src/srcset).
  const images = document.querySelectorAll('img');
  images.forEach(img => observeImage(img));
}

function filterMedia() {
  // Register all videos/animated GIF thumbnails for classification on visibility
  const videos = document.querySelectorAll('video');
  videos.forEach(v => observeMedia(v));
}

// Social feed filtering: per-post, without blocking entire site
async function filterSocialFeed() {
  const site = getSocialSite();
  if (!site || !SOCIAL_SELECTORS[site]) return;

  const selector = SOCIAL_SELECTORS[site].containers;
  const posts = Array.from(document.querySelectorAll(selector)).filter(post =>
    post && post.dataset.pblockerHidden !== 'true' && post.dataset.pblockerProcessed !== 'true'
  );
  let blockedCount = 0;
  const backgroundVerdicts = await Promise.all(posts.map(hasBackgroundBlockedLink));

  for (let index = 0; index < posts.length; index++) {
    const post = posts[index];
    try {
      if (shouldBlockSocialPost(post, site) || backgroundVerdicts[index]) {
        hideElement(post, 'social-post');
        blockedCount++;
      } else {
        post.dataset.pblockerProcessed = 'true';
      }
    } catch (_) {}
  }

  if (blockedCount > 0) {
    notifyBackground('social_post_filtered', { count: blockedCount });
  }
}

function isTrustedDomain(url) {
  if (!url) return false;
  
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // User-configured trusted domains
    for (let i = 0; i < trustedDomains.length; i++) {
      const d = (trustedDomains[i] || '').toLowerCase().replace(/^www\./, '');
      if (hostname === d || hostname.endsWith('.' + d)) return true;
    }
    // Built-in default trusted domains (e-commerce, gaming, news, etc.)
    for (let i = 0; i < DEFAULT_TRUSTED_IMAGE_DOMAINS_LIST.length; i++) {
      const d = DEFAULT_TRUSTED_IMAGE_DOMAINS_LIST[i];
      if (hostname === d || hostname.endsWith('.' + d)) return true;
    }
    return false;
  } catch (error) {
    log('Error checking trusted domain:', error);
    return false;
  }
}

// The result tile an image-search thumbnail belongs to, for engines that give us
// one. Only defined inside an image-search context: on an ordinary page the
// enclosing figure is the article's own illustration, not a result card.
function getImageSearchTile(element) {
  try {
    if (!element || typeof element.closest !== 'function') return null;
    if (!isImagesSearchContext()) return null;
    const tileSelector = SEARCH_SELECTORS[getSearchEngine()]?.imageContext?.tile;
    if (!tileSelector) return null;
    return element.closest(tileSelector);
  } catch (_) {
    return null;
  }
}

// Element hiding and replacement
function hideElement(element, type) {
  if (!element || element.dataset.pblockerHidden) return;

  // Held before the image branch below can swap `element` for its wrapping tile:
  // the address lives on the <img>, not on the tile.
  const blockedSource = element;

  // Hiding only the <img> of an image-search result leaves its caption behind —
  // and the caption is where the title the user blocked is spelled out. Where
  // the engine wraps each result in a tile, hide the tile instead.
  if (type === 'image') {
    const tile = getImageSearchTile(element);
    if (tile && tile !== element) {
      element.dataset.pblockerHidden = 'true';
      if (tile.dataset.pblockerHidden) return;
      element = tile;
    }
  }

  element.dataset.pblockerHidden = 'true';
  element.style.display = 'none';

  recordBlockedEntry(blockedSource, type);

  // Create replacement message for search results
  if (type === 'search-result') {
    // 'hide' removes the result outright and lets the summary line above the
    // results account for it — one line however many were blocked, instead of a
    // branded card per result. 'overlay' keeps the card for people who want
    // per-position evidence that something was filtered *there*: a removed
    // result is indistinguishable from a result that never existed, which
    // matters in an accountability setup.
    if (searchResultTreatment === 'overlay' && element.parentNode) {
      const replacement = createBlockedResultElement();
      element.parentNode.insertBefore(replacement, element);

      // Add subtle entrance animation
      requestAnimationFrame(() => {
        replacement.style.opacity = '0';
        replacement.style.transform = 'translateY(10px)';
        replacement.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

        requestAnimationFrame(() => {
          replacement.style.opacity = '1';
          replacement.style.transform = 'translateY(0)';
        });
      });
    }
  } else if (type === 'image' || type === 'video') {
    // In a search grid the tile is gone and a gap reads as "fewer results"; a
    // grid of shield boxes reads as an error state. On an ordinary page the
    // placeholder earns its keep — it holds the layout and explains the hole in
    // the article — so it stays there.
    if (isImagesSearchContext() || getImageSearchTile(element)) return;
    const placeholder = createBlockedImagePlaceholder(element);
    if (element.parentNode) {
      element.parentNode.insertBefore(placeholder, element);
    }
  }
}

const BLOCKED_SUMMARY_ID = 'pblocker-blocked-summary';
const FLOATING_COUNTER_ID = 'pblocker-floating-counter';
// Social posts are excluded on purpose: they do not feed the toolbar badge
// either, and a pill that appears on every scroll of a feed is the noise this
// whole change set out to remove.
const COUNTED_BLOCK_TYPES = new Set(['search-result', 'image', 'video', 'iframe']);

/**
 * The host behind a blocked element, for the pill's detail panel. Each element
 * type keeps its address somewhere different: a result in its link, an image in
 * its src (possibly wrapped in a search engine's thumbnail proxy), a frame in
 * its src attribute.
 */
function blockedEntryHost(element, type) {
  try {
    if (!element) return '';
    let candidate = '';

    if (type === 'search-result') {
      const anchor = element.querySelector?.('a[href]');
      candidate = anchor ? (anchor.getAttribute('data-expanded-url') || anchor.href || '') : '';
    } else if (type === 'image') {
      // On an image search the src is the engine's own proxy, which would make
      // every result look like it came from the engine. The real address is in a
      // parameter, and extractWrappedImageSearchUrls already knows how to get it.
      const raw = getEffectiveImageUrl(element);
      // The raw address is element 0 of that list and the unwrapped targets come
      // after it, so the last entry is the real source when there is one.
      const unwrapped = extractWrappedImageSearchUrls(raw);
      candidate = (Array.isArray(unwrapped) && unwrapped.length > 1)
        ? unwrapped[unwrapped.length - 1]
        : raw;
    } else {
      candidate = element.currentSrc || element.src || element.getAttribute?.('src') || '';
    }

    if (!candidate) return '';
    return new URL(candidate, window.location.href).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/**
 * Tally one block for the in-page pill. Keyed on search identity like the
 * summary line, so switching DuckDuckGo verticals does not carry the previous
 * tab's list across.
 */
function recordBlockedEntry(element, type) {
  try {
    if (!COUNTED_BLOCK_TYPES.has(type)) return;

    const key = currentSearchIdentity();
    if (key !== pageBlockedEntriesKey) {
      pageBlockedEntriesKey = key;
      pageBlockedEntries = new Map();
      pageBlockedTotal = 0;
      floatingCounterExpanded = false;
    }

    pageBlockedTotal++;
    const host = blockedEntryHost(element, type);
    if (host) pageBlockedEntries.set(host, (pageBlockedEntries.get(host) || 0) + 1);

    // Blocks arrive one image at a time on a scrolling page; redrawing per block
    // would thrash layout for no benefit.
    scheduleFloatingCounterUpdate();
  } catch (_) {
    // Fail-open: the tally is cosmetic and must never break a block.
  }
}

/**
 * Identity of the search currently on screen. Used to decide when the blocked
 * tally belongs to a new search rather than the one it was counting. Includes
 * the vertical parameters, because switching DuckDuckGo's Images/Videos tabs
 * changes neither pathname nor query — and does it via pushState, so there is no
 * popstate to hang a reset off.
 */
function currentSearchIdentity() {
  try {
    const params = new URLSearchParams(window.location.search);
    const vertical = ['ia', 'iax', 'iar', 'tbm', 'scope'].map((key) => params.get(key) || '').join('|');
    const query = params.get('q') || params.get('p') || params.get('text') || '';
    return `${window.location.hostname}${window.location.pathname}?${query}#${vertical}`;
  } catch (_) {
    return window.location.href;
  }
}

/** Add to the running tally, restarting it when the search has changed. */
function addBlockedResultCount(count) {
  if (!count || count < 0) return pageBlockedCount;
  const key = currentSearchIdentity();
  if (key !== pageBlockedCountKey) {
    pageBlockedCountKey = key;
    pageBlockedCount = 0;
  }
  pageBlockedCount += count;
  return pageBlockedCount;
}

/**
 * Draw (or update) the one-line summary above the results — the whole of the
 * extension's on-page presence when results are hidden rather than overlaid.
 * Deliberately text only, with nothing to click: uBlacklist's equivalent line
 * carries a "Show" link, which for a porn blocker is a one-click bypass sitting
 * on every search page. Revealing blocked results is the popup's job, where it
 * can be PIN-gated.
 *
 * Find-or-create rather than insert-once, because the engines that need this
 * most re-render their result list and will throw the node away.
 */
function updateBlockedResultsNotice() {
  try {
    const engine = getSearchEngine();
    // Turned off, nothing blocked, or the tally belongs to a previous search:
    // in every case the line has to go, including when it is already drawn.
    if (!searchSummaryEnabled || !engine || pageBlockedCount <= 0 ||
        currentSearchIdentity() !== pageBlockedCountKey) {
      const stale = document.getElementById(BLOCKED_SUMMARY_ID);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      return;
    }

    let notice = document.getElementById(BLOCKED_SUMMARY_ID);
    if (!notice || !notice.isConnected) {
      notice = document.createElement('div');
      notice.id = BLOCKED_SUMMARY_ID;
      const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      notice.style.cssText = `
        margin: 0 0 12px 0;
        padding: 0;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: ${isDarkMode ? '#94a3b8' : '#64748b'};
        background: none;
        border: none;
      `;
      if (!insertBlockedResultsNotice(notice, engine)) return;
    }

    notice.textContent = pageBlockedCount === 1
      ? '1 result blocked by BlockNSFW'
      : `${pageBlockedCount} results blocked by BlockNSFW`;
  } catch (error) {
    // Fail-open: a missing summary must never stop results from being blocked.
    log('Error updating blocked-results summary:', error);
  }
}

let floatingCounterTimer = null;

function scheduleFloatingCounterUpdate() {
  if (floatingCounterTimer) return;
  floatingCounterTimer = setTimeout(() => {
    floatingCounterTimer = null;
    updateFloatingCounter();
  }, 200);
}

/**
 * The in-page counter pill, for people whose toolbar icon is not pinned and who
 * therefore never see the badge. Clicking it lists the hosts that were blocked.
 *
 * The listed hosts are inert text — not links, no click handler, not selectable
 * as a unit — because the point is to account for what happened, not to offer a
 * way back to it. That is the same reason the summary line above search results
 * carries no "Show".
 */
function updateFloatingCounter() {
  try {
    const existing = document.getElementById(FLOATING_COUNTER_ID);

    if (blockCountDisplay !== 'floating' || pageBlockedTotal <= 0 ||
        currentSearchIdentity() !== pageBlockedEntriesKey) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (!document.body) return;

    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let host = existing;
    if (!host || !host.isConnected) {
      host = document.createElement('div');
      host.id = FLOATING_COUNTER_ID;
      // `all: initial` first, so a page with aggressive global rules cannot
      // restyle the pill out of legibility.
      host.style.cssText = `
        all: initial;
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483646;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        display: block;
      `;
      document.body.appendChild(host);
    }

    // Rebuilt rather than patched: the content is a count and a short list, so
    // there is nothing worth diffing, and this keeps the two states in one place.
    while (host.firstChild) host.removeChild(host.firstChild);

    const surface = isDarkMode ? '#1e293b' : '#ffffff';
    const borderColor = isDarkMode ? '#334155' : '#e2e8f0';
    const primaryText = isDarkMode ? '#f1f5f9' : '#0f172a';
    const mutedText = isDarkMode ? '#94a3b8' : '#64748b';

    if (floatingCounterExpanded) {
      const panel = document.createElement('div');
      panel.style.cssText = `
        box-sizing: border-box;
        min-width: 260px;
        max-width: 380px;
        max-height: 420px;
        overflow-y: auto;
        background: ${surface};
        border: 1px solid ${borderColor};
        border-radius: 14px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, ${isDarkMode ? '0.5' : '0.15'});
        padding: 18px 20px;
        margin-bottom: 10px;
        font-size: 16px;
        line-height: 1.6;
        color: ${primaryText};
      `;

      const heading = document.createElement('div');
      heading.textContent = pageBlockedEntries.size === 1 ? 'Blocked source' : 'Blocked sources';
      heading.style.cssText = `font-weight: 600; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: ${mutedText}; margin-bottom: 12px;`;
      panel.appendChild(heading);

      if (pageBlockedEntries.size === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'Source not available.';
        empty.style.cssText = `color: ${mutedText};`;
        panel.appendChild(empty);
      } else {
        // Busiest first: on an image grid one host usually accounts for most of
        // the blocks, and that is the useful thing to see.
        const sorted = Array.from(pageBlockedEntries.entries()).sort((a, b) => b[1] - a[1]);
        for (const [entryHost, count] of sorted) {
          const row = document.createElement('div');
          row.style.cssText = `
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 6px 0;
            cursor: default;
            user-select: none;
          `;
          const name = document.createElement('span');
          name.textContent = entryHost;
          name.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          const tally = document.createElement('span');
          tally.textContent = String(count);
          tally.style.cssText = `color: ${mutedText}; flex-shrink: 0; font-variant-numeric: tabular-nums;`;
          row.appendChild(name);
          row.appendChild(tally);
          panel.appendChild(row);
        }
      }
      host.appendChild(panel);
    }

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.setAttribute('aria-expanded', floatingCounterExpanded ? 'true' : 'false');
    pill.title = floatingCounterExpanded ? 'Hide blocked sources' : 'Show blocked sources';
    pill.style.cssText = `
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
      padding: 12px 18px;
      background: ${surface};
      border: 1px solid ${borderColor};
      border-radius: 999px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, ${isDarkMode ? '0.45' : '0.12'});
      font-family: inherit;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.2;
      color: ${primaryText};
      cursor: pointer;
    `;

    const shield = document.createElement('span');
    shield.textContent = '🛡️';
    shield.style.cssText = 'font-size: 19px; line-height: 1;';
    pill.appendChild(shield);

    const label = document.createElement('span');
    label.textContent = pageBlockedTotal === 1 ? '1 blocked' : `${pageBlockedTotal} blocked`;
    pill.appendChild(label);

    pill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      floatingCounterExpanded = !floatingCounterExpanded;
      updateFloatingCounter();
    });

    host.appendChild(pill);
  } catch (error) {
    log('Error updating floating counter:', error);
  }
}

/**
 * Undo the search-result filtering already applied to this page so the next pass
 * can redo it under the new treatment. Only search results are touched — images
 * and video keep their own restore path in restoreBlockedMediaElements().
 */
function resetBlockedSearchResults() {
  try {
    document.querySelectorAll('.pblocker-blocked-result').forEach((card) => {
      if (card.parentNode) card.parentNode.removeChild(card);
    });

    const engine = getSearchEngine();
    const selectors = engine ? SEARCH_SELECTORS[engine] : null;
    if (!selectors) return;

    // Un-hide and un-mark every result the filter touched. The elements are
    // still in the DOM — hideElement only sets display:none — so re-judging them
    // costs one pass and no refetch.
    document.querySelectorAll('[data-pblocker-hidden="true"]').forEach((el) => {
      if (!el.matches?.(searchContainerSelector(selectors)) &&
          !(selectors.resultRoot && el.matches?.(selectors.resultRoot))) {
        return;
      }
      el.style.display = '';
      delete el.dataset.pblockerHidden;
      delete el.dataset.pblockerProcessed;
    });

    pageBlockedCount = 0;
    pageBlockedCountKey = '';
    const notice = document.getElementById(BLOCKED_SUMMARY_ID);
    if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
  } catch (error) {
    log('Error resetting blocked search results:', error);
  }
}

/**
 * Place the summary above the result list. Falls back to the parent of the first
 * result, so an engine whose layout has drifted still gets a line rather than
 * silently losing the feature.
 */
function insertBlockedResultsNotice(notice, engine) {
  const selectors = SEARCH_SELECTORS[engine];
  if (!selectors) return false;

  const anchor = selectors.resultsAnchor
    ? document.querySelector(selectors.resultsAnchor)
    : null;
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(notice, anchor);
    return true;
  }

  const firstResult = document.querySelector(searchContainerSelector(selectors));
  if (firstResult && firstResult.parentNode) {
    firstResult.parentNode.insertBefore(notice, firstResult);
    return true;
  }
  return false;
}

function createBlockedImagePlaceholder(element) {
  const placeholder = document.createElement('div');
  placeholder.className = 'pblocker-blocked-image-placeholder';
  
  // Try to preserve original dimensions if known
  const rect = element.getBoundingClientRect();
  // Use clientWidth/Height as fallback for hidden elements, or attributes
  const width = rect.width || element.clientWidth || parseInt(element.getAttribute('width')) || 0;
  const height = rect.height || element.clientHeight || parseInt(element.getAttribute('height')) || 0;
  
  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  // Styles
  const bg = isDarkMode ? '#1e293b' : '#f1f5f9';
  const border = isDarkMode ? '#334155' : '#cbd5e1';
  const color = isDarkMode ? '#94a3b8' : '#64748b';
  
  placeholder.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: ${bg};
    border: 1px solid ${border};
    border-radius: 4px;
    width: ${width ? width + 'px' : '100%'};
    height: ${height ? height + 'px' : '100%'};
    min-height: 80px;
    min-width: 80px;
    color: ${color};
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    text-align: center;
    overflow: hidden;
    box-sizing: border-box;
    padding: 8px;
    transition: opacity 0.3s ease;
  `;
  
  // Icon
  const icon = document.createElement('div');
  icon.textContent = '🛡️';
  icon.style.fontSize = '20px';
  icon.style.marginBottom = '6px';
  placeholder.appendChild(icon);
  
  // Text
  const text = document.createElement('div');
  text.textContent = 'Content Blocked by BlockNSFW';
  text.style.fontWeight = '500';
  text.style.lineHeight = '1.3';
  
  // Scale text down for very small containers
  if (width > 0 && width < 120) {
    text.style.fontSize = '10px';
    text.textContent = 'Blocked';
  }
  
  placeholder.appendChild(text);
  
  return placeholder;
}

function restoreBlockedMediaElements() {
  const blockedMedia = document.querySelectorAll('[data-pblocker-hidden="true"][data-pblocker-type="image"], [data-pblocker-hidden="true"][data-pblocker-type="video"]');
  blockedMedia.forEach((element) => {
    const blockId = element.dataset.pblockerBlockId;
    if (blockId) {
      const placeholder = document.querySelector(`.pblocker-blocked-image-placeholder[data-pblocker-for="${blockId}"]`);
      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }
    }
    element.style.display = element.dataset.pblockerOriginalDisplay || '';
    delete element.dataset.pblockerHidden;
    delete element.dataset.pblockerType;
    delete element.dataset.pblockerOriginalDisplay;
    delete element.dataset.pblockerObserved;
    delete element.dataset.pblockerObservedSrc;
    delete element.dataset.pblockerBlockId;
  });
}

function createBlockedResultElement() {
  const replacement = document.createElement('div');
  replacement.className = 'pblocker-blocked-result';
  
  // Detect dark mode preference
  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const searchEngine = getSearchEngine();
  
  // Apply theme-appropriate styling
  const theme = getBlockedResultTheme(isDarkMode, searchEngine);
  replacement.style.cssText = theme.container;
  
  // Add smooth hover effects
  addHoverEffects(replacement, theme);
  
  // Create the content with theme using safe DOM methods
  createBlockedResultDOM(replacement, theme);
  
  // Try to load the icon after the element is created
  setTimeout(() => {
    tryLoadExtensionIcon(replacement, theme);
  }, 100);
  
  return replacement;
}

function tryLoadExtensionIcon(container, theme) {
  const iconContainer = container.querySelector('#pblocker-icon-container');
  if (!iconContainer) return;
  
  // Try different icon loading approaches
  const iconPaths = [
    'icons/icon-48.png',
    'icons/icon-128.png', 
    'icons/icon-16.png'
  ];
  
  let currentIndex = 0;
  
  function tryNextIcon() {
    if (currentIndex >= iconPaths.length) {
      // All failed, use emoji fallback
      iconContainer.textContent = '🛡️';
      if (debugMode) {
        log('All icon loading attempts failed, using emoji fallback');
      }
      return;
    }
    
    try {
      const iconUrl = browserAPI.runtime.getURL(iconPaths[currentIndex]);
      const img = document.createElement('img');
      
      img.style.cssText = `
        width: 28px;
        height: 28px;
        border-radius: 50%;
        object-fit: contain;
      `;
      
      img.onload = () => {
        while (iconContainer.firstChild) {
          iconContainer.removeChild(iconContainer.firstChild);
        }
        iconContainer.appendChild(img);
        if (debugMode) {
          log(`Successfully loaded icon: ${iconPaths[currentIndex]}`);
        }
      };
      
      img.onerror = () => {
        if (debugMode) {
          log(`Failed to load icon: ${iconPaths[currentIndex]}`);
        }
        currentIndex++;
        tryNextIcon();
      };
      
      img.src = iconUrl;
      img.alt = 'BlockNSFW';
      
    } catch (error) {
      log('Error creating icon:', error);
      currentIndex++;
      tryNextIcon();
    }
  }
  
  tryNextIcon();
}

function getBlockedResultTheme(isDarkMode, searchEngine) {
  // Base theme that adapts to search engine and dark mode
  const baseTheme = {
    light: {
      container: `
        position: relative;
        padding: 16px 20px;
        margin: 8px 0;
        background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
        border: 1px solid #e2e8f0;
        border-left: 4px solid #3b82f6;
        border-radius: 12px;
        color: #475569;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        transition: all 0.2s ease;
        cursor: default;
      `,
      iconBg: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
      iconBorder: '2px solid #3b82f6',
      titleColor: '#1e293b',
      textColor: '#64748b',
      badgeBg: '#f1f5f9',
      badgeBorder: '#cbd5e1',
      badgeColor: '#475569'
    },
    dark: {
      container: `
        position: relative;
        padding: 16px 20px;
        margin: 8px 0;
        background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
        border: 1px solid #475569;
        border-left: 4px solid #60a5fa;
        border-radius: 12px;
        color: #cbd5e1;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
        cursor: default;
      `,
      iconBg: 'linear-gradient(135deg, #475569 0%, #64748b 100%)',
      iconBorder: '2px solid #60a5fa',
      titleColor: '#f1f5f9',
      textColor: '#94a3b8',
      badgeBg: '#334155',
      badgeBorder: '#475569',
      badgeColor: '#cbd5e1'
    }
  };
  
  return isDarkMode ? baseTheme.dark : baseTheme.light;
}

function addHoverEffects(element, theme) {
  element.addEventListener('mouseenter', () => {
    element.style.boxShadow = theme.container.includes('dark') 
      ? '0 4px 12px rgba(0, 0, 0, 0.4)' 
      : '0 4px 12px rgba(0, 0, 0, 0.15)';
    element.style.transform = 'translateY(-1px)';
  });
  
  element.addEventListener('mouseleave', () => {
    element.style.boxShadow = theme.container.includes('dark')
      ? '0 1px 3px rgba(0, 0, 0, 0.3)'
      : '0 1px 3px rgba(0, 0, 0, 0.1)';
    element.style.transform = 'translateY(0)';
  });
}

function createBlockedResultDOM(container, theme) {
  // Try to get the extension logo URL
  let logoUrl = '';
  try {
    logoUrl = browserAPI.runtime.getURL('icons/icon-48.png');
    if (debugMode) {
      log('Logo URL generated:', logoUrl);
    }
  } catch (error) {
    log('Error getting logo URL:', error);
    logoUrl = '';
  }
  
  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display: flex; align-items: center; gap: 12px;';
  
  // Create icon container
  const iconContainer = document.createElement('div');
  iconContainer.id = 'pblocker-icon-container';
  iconContainer.style.cssText = `
    width: 40px;
    height: 40px;
    background: ${theme.iconBg};
    border: ${theme.iconBorder || 'none'};
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    padding: 4px;
    font-size: 18px;
  `;
  
  if (logoUrl) {
    const img = document.createElement('img');
    img.src = logoUrl;
    img.alt = 'BlockNSFW';
    img.style.cssText = 'width: 28px; height: 28px; border-radius: 50%; object-fit: contain;';
    img.onload = () => {
      if (debugMode) log('Logo loaded successfully');
    };
    img.onerror = () => {
      if (debugMode) log('Logo failed to load, using fallback');
      img.style.display = 'none';
      iconContainer.textContent = '🛡️';
    };
    iconContainer.appendChild(img);
  } else {
    iconContainer.textContent = '🛡️';
  }
  
  // Create text container
  const textContainer = document.createElement('div');
  textContainer.style.cssText = 'flex: 1;';
  
  const title = document.createElement('div');
  title.style.cssText = `
    font-weight: 600;
    color: ${theme.titleColor};
    margin-bottom: 4px;
    font-size: 15px;
  `;
  title.textContent = 'Content Filtered by BlockNSFW';
  
  const description = document.createElement('div');
  description.style.cssText = `
    color: ${theme.textColor};
    font-size: 13px;
    line-height: 1.4;
  `;
  description.textContent = 'This search result was blocked for containing inappropriate content';
  
  textContainer.appendChild(title);
  textContainer.appendChild(description);
  
  // Create badge
  const badge = document.createElement('div');
  badge.style.cssText = `
    background: ${theme.badgeBg};
    border: 1px solid ${theme.badgeBorder};
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 11px;
    color: ${theme.badgeColor};
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;
  badge.textContent = 'BLOCKED';
  
  // Assemble
  wrapper.appendChild(iconContainer);
  wrapper.appendChild(textContainer);
  wrapper.appendChild(badge);
  container.appendChild(wrapper);
}

// --- Image visibility-driven classification ---
function isImagesSearchContext() {
  try {
    const engine = getSearchEngine();
    const params = new URLSearchParams(window.location.search);
    if (engine === 'google') {
      // Google images tab uses tbm=isch
      if (params.get('tbm') === 'isch') return true;
      // Check for specific Google Images DOM elements (grid layout)
      if (document.getElementById('islrg') || document.querySelector('.islrc')) return true;
      // Check path
      if (window.location.pathname === '/imgres') return true;
      return false;
    }
    if (engine === 'bing') {
      // Bing may use scope or path for images
      return /[?&]scope=images\b/i.test(window.location.search) || /\/images\b/i.test(window.location.pathname);
    }
    if (engine === 'duckduckgo') {
      // DuckDuckGo images tab markers
      return params.get('ia') === 'images' || params.get('iar') === 'images' || params.get('iax') === 'images';
    }
    if (engine === 'brave') {
      return window.location.pathname.startsWith('/images');
    }
    if (engine === 'yahoo') {
      return /\/images\b/i.test(window.location.pathname);
    }
    if (engine === 'yandex') {
      return window.location.pathname.startsWith('/images/') ||
        window.location.pathname === '/images/search' ||
        params.get('rpt') === 'imageview';
    }
  } catch (_) {}
  return false;
}
function getEffectiveImageUrl(img) {
  try {
    // currentSrc reflects the chosen candidate from srcset when available
    return img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
  } catch (e) {
    return img.src || '';
  }
}

function getImageContextText(img) {
  try {
    const engine = getSearchEngine();
    if (!engine || !SEARCH_SELECTORS[engine]?.imageContext) return '';

    const selectors = SEARCH_SELECTORS[engine].imageContext;
    const container = img.closest(selectors.container);
    
    if (!container) return '';

    // Extract text from specific text containers
    const textElements = container.querySelectorAll(selectors.text);
    let contextText = '';
    textElements.forEach(el => {
      contextText += ' ' + (el.textContent || '');
    });

    // Include nearby image metadata such as alt/title text for image-grid engines.
    const imageNodes = container.querySelectorAll('img');
    imageNodes.forEach(imageNode => {
      contextText += ' ' + (imageNode.getAttribute('alt') || '') + ' ' + (imageNode.getAttribute('title') || '');
    });

    // Also check aria-labels on links (often used for titles in Google Images)
    const links = container.querySelectorAll('a');
    links.forEach(a => {
      contextText += ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.title || '');
    });

    return contextText.trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

function safelyDecodeUrlCandidate(value) {
  if (!value || typeof value !== 'string') return '';
  let decoded = value.trim();

  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (_) {
      break;
    }
  }

  return decoded;
}

// Engines that serve image-search thumbnails through their own proxy, and the
// parameter holding the real address. Without unwrapping these, every thumbnail
// on the page looks like it comes from the search engine itself:
//
//   https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Ftse3.mm.bing.net%2Fth%3Fq%3DApricot…
//
// The host is duckduckgo.com and the path is just "/iu/", so a keyword scan of
// the proxy address alone can never match anything — the terms are inside `u`.
const WRAPPED_IMAGE_URL_PARAMS = {
  duckduckgo: ['u'],
  yandex: ['img_url', 'url', 'img_href', 'media_url', 'thumb_url']
};

function extractWrappedImageSearchUrls(rawUrl, engine = getSearchEngine()) {
  const urls = new Set();
  if (!rawUrl || typeof rawUrl !== 'string') return [];

  const normalizedRaw = rawUrl.trim();
  if (!normalizedRaw || normalizedRaw.startsWith('javascript:') || normalizedRaw.startsWith('#')) {
    return [];
  }

  urls.add(normalizedRaw);

  try {
    const parsed = new URL(normalizedRaw, window.location.href);

    const wrapperParams = WRAPPED_IMAGE_URL_PARAMS[engine];
    if (wrapperParams) {
      for (const paramName of wrapperParams) {
        const candidate = safelyDecodeUrlCandidate(parsed.searchParams.get(paramName) || '');
        if (/^https?:\/\//i.test(candidate)) {
          urls.add(candidate);
        }
      }
    }
  } catch (_) {
    const decoded = safelyDecodeUrlCandidate(normalizedRaw);
    if (/^https?:\/\//i.test(decoded)) {
      urls.add(decoded);
    }
  }

  return Array.from(urls);
}

function getImageContextLinks(img) {
  try {
    const engine = getSearchEngine();
    if (!engine || !SEARCH_SELECTORS[engine]?.imageContext) return [];

    const selectors = SEARCH_SELECTORS[engine].imageContext;
    const container = img.closest(selectors.container);
    
    if (!container) return [];

    const links = container.querySelectorAll('a[href], a[data-href], a[data-url], [data-img-url]');
    const collectedLinks = new Set();

    links.forEach(node => {
      const candidates = [
        node.getAttribute?.('href') || '',
        node.getAttribute?.('data-href') || '',
        node.getAttribute?.('data-url') || '',
        node.getAttribute?.('data-img-url') || ''
      ];

      candidates.forEach(candidate => {
        extractWrappedImageSearchUrls(candidate, engine).forEach(url => {
          if (url && !url.startsWith('javascript:') && !url.startsWith('#')) {
            collectedLinks.add(url);
          }
        });
      });
    });

    return Array.from(collectedLinks);
  } catch (e) {
    return [];
  }
}

function shouldBlockImage(img) {
  const url = getEffectiveImageUrl(img);
  const alt = img.alt || '';
  const title = img.title || '';
  const level = normalizeImageFilterLevel(imageFilterLevel);

  // In image search contexts, avoid alt/title keyword checks to prevent mass blocking
  if (isImagesSearchContext()) {
    if (!url) return false;
    const engine = getSearchEngine();
    if (engine === 'yandex' && shouldBlockCurrentSearchQuery() && isLikelyImageSearchResultImage(img)) {
      if (debugMode) log('Blocking Yandex image result due to explicit query:', getCurrentSearchQuery());
      return true;
    }
    try {
      const u = new URL(url, window.location.href);
      const host = u.hostname.toLowerCase();

      if (isHostInDefaultBlocklist(host)) return true;
      if (matchesAdultKeywordHost(host)) return true;
      if (matchesCustomBlockPattern(url, host)) return true;

      // A proxied thumbnail (DuckDuckGo's external-content, Yandex's img_url)
      // hides both the real host and the search terms inside a parameter, so
      // the unwrapped address has to be checked as well as the proxy's own.
      // Query text goes through buildUrlScanText, which drops adult-filter
      // switches so `&adlt=moderate` does not read as an adult signal.
      let scanText = '';
      for (const candidate of extractWrappedImageSearchUrls(url, engine)) {
        let candidateUrl = null;
        try { candidateUrl = new URL(candidate, window.location.href); } catch (_) { continue; }

        const candidateHost = candidateUrl.hostname.toLowerCase();
        if (candidateHost !== host) {
          if (isHostInDefaultBlocklist(candidateHost)) return true;
          if (matchesAdultKeywordHost(candidateHost)) return true;
          if (matchesCustomBlockPattern(candidate, candidateHost)) return true;
        }

        scanText += ' ' + buildUrlScanText(candidateUrl).toLowerCase();
      }

      const highConfInPath = HIGH_CONFIDENCE_PATH_KEYWORDS.test(scanText);
      const ambigInPath = AMBIGUOUS_PATH_KEYWORDS.test(scanText);
      const shouldBlockByPath = highConfInPath || (!isCleanPageHost() && ambigInPath);

      if (!isTrustedDomain(url) && !isKnownSafeImageHost(url) && shouldBlockByPath) {
        if (debugMode) log('Blocking image due to path keywords:', scanText.trim().substring(0, 120));
        return true;
      }

      // Lenient with no custom words needs no context text at all, and this
      // runs once per image on a page that can hold hundreds of them.
      const needsContext = level !== IMAGE_FILTER_LEVELS.LENIENT || customKeywordList.length > 0;
      const contextText = needsContext ? getImageContextText(img) : '';

      // A word the user typed themselves is an instruction, not a heuristic, so
      // it applies at every filter level — the level only decides how far the
      // built-in term lists reach. Same reasoning as custom title patterns
      // outranking the smart-blocking gate.
      if (matchesCustomKeywords(contextText) || matchesCustomKeywords(scanText)) {
        if (debugMode) log('Blocking image — custom blocked word:', contextText.substring(0, 80));
        return true;
      }

      if (level !== IMAGE_FILTER_LEVELS.LENIENT) {
        const contextMatch = level === IMAGE_FILTER_LEVELS.STRICT
          ? (contextText && containsAdultKeywords(contextText))
          : hasModerateContextSignals(contextText);

        if (contextMatch) {
          if (debugMode) {
            log('Blocking image due to context text:', (contextText || '').substring(0, 50) + '...');
          }
          return true;
        }
      }

      const contextLinks = getImageContextLinks(img);
      for (const linkUrl of contextLinks) {
        if (isAdultURL(linkUrl)) {
            if (debugMode) log('Blocking image due to source link domain:', linkUrl);
            return true;
        }
        
        try {
            const linkObj = new URL(linkUrl);
            const linkPath = buildUrlScanText(linkObj).toLowerCase();
            const highConfSource = HIGH_CONFIDENCE_PATH_KEYWORDS.test(linkPath);
            const ambigSource = AMBIGUOUS_PATH_KEYWORDS.test(linkPath);
            const sourcePathMatch = highConfSource || (!isCleanPageHost() && ambigSource);
            if (sourcePathMatch) {
                if (debugMode) log('Blocking image due to keywords in source link:', linkUrl);
                return true;
            }
        } catch (_) {}
      }

    } catch (_) {
      return false;
    }
    return false;
  }

  // Outside images search, use original signals
  if (!url && !alt && !title) return false;

  // An explicit user block outranks the built-in trusted/safe-CDN allowlist —
  // if they blocked the site, they meant its images too.
  if (url && customBlockPatterns.length) {
    try {
      const host = normalizeHost(new URL(url, window.location.href).hostname);
      if (matchesCustomBlockPattern(url, host)) {
        if (debugMode) log('[Image Filter] Blocked — user blocklist host:', host);
        return true;
      }
    } catch (_) {}
  }

  if (isTrustedDomain(url) || isKnownSafeImageHost(url)) {
    if (debugMode) log('[Image Filter] Allowed — trusted/safe CDN:', url?.substring(0, 80));
    return false;
  }

  if (isAdultURL(url)) {
    if (debugMode) log('[Image Filter] Blocked — adult URL host:', url);
    return true;
  }

  const cleanPage = isCleanPageHost();

  // On clean pages with moderate/lenient, host check above is sufficient.
  if (cleanPage && level !== IMAGE_FILTER_LEVELS.STRICT) {
    return false;
  }

  if (level === IMAGE_FILTER_LEVELS.STRICT) {
    if (cleanPage) {
      // CLEAN PAGE + STRICT: Use raised threshold and benign-context
      // awareness to avoid false positives on e-commerce/news/sports sites.
      const strictOpts = { neutralThreshold: 3, useBenignContext: true };
      const hasAdultSignals = containsAdultKeywords(alt, strictOpts) || containsAdultKeywords(title, strictOpts);
      if (hasAdultSignals) {
        if (debugMode) log('[Image Filter][Strict/Clean] Blocked — alt/title keyword match:', alt || title, '| url:', url);
        return true;
      }
    } else {
      // SUSPICIOUS PAGE + STRICT: full keyword analysis (original threshold)
      const hasAdultSignals = containsAdultKeywords(alt) || containsAdultKeywords(title);
      if (hasAdultSignals) {
        if (debugMode) log('[Image Filter][Strict/Suspicious] Blocked — alt/title keyword match:', alt || title, '| url:', url);
        return true;
      }
    }
  } else if (level === IMAGE_FILTER_LEVELS.MODERATE) {
    // Moderate on NON-clean pages: still do a light keyword check
    const hasExplicit = hasImageKeywordsForLevel(alt, level) || hasImageKeywordsForLevel(title, level);
    if (hasExplicit) {
      if (debugMode) log('[Image Filter][Moderate] Blocked — alt/title keyword on non-clean page:', alt || title, '| url:', url);
      return true;
    }
  }

  return false;
}

function maybeBlockImage(img) {
  // Skip already hidden
  if (img.dataset.pblockerHidden === 'true') return;
  if (shouldBlockImage(img)) {
    hideElement(img, 'image');
    notifyBackground('image_filtered', { count: 1 });
  } else if (debugMode) {
    const url = getEffectiveImageUrl(img);
    log('[Image Filter] Allowed:', url ? url.substring(0, 120) : '(no url)', '| alt:', (img.alt || '').substring(0, 60));
  }
}

const IMAGE_OBSERVER_ROOT_MARGIN_PX = 1400;

// isImageNearViewport() and prewarmImageAnalysis() lived here. They ran
// getBoundingClientRect() per <img> from inside observeImage(), interleaved
// with hideElement()'s style writes — a forced layout flush per image. The
// IntersectionObserver below already covers the same ground: its 1400px bottom
// margin fires it well before an image is on screen, it delivers an initial
// callback for targets already visible, and it does its work off the main
// thread. Do not reintroduce a layout read on this path.

function setupIntersectionObserver() {
  if (imageObserver) {
    try { imageObserver.disconnect(); } catch (_) {}
  }
  // Observe entering viewport with small preload margin
  imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const img = entry.target;
      if (entry.isIntersecting) {
        if (!isEnabled) {
          imageObserver.unobserve(img);
          continue;
        }
        // Re-check when visible (src/srcset may have changed lazily)
        maybeBlockImage(img);
        if (img.dataset.pblockerHidden !== 'true' &&
            typeof window.AIImageBlocker !== 'undefined' &&
            window.AIImageBlocker &&
            typeof window.AIImageBlocker.onImageVisible === 'function') {
          window.AIImageBlocker.onImageVisible(img);
        }
        imageObserver.unobserve(img);
      }
    }
  }, { root: null, rootMargin: `0px 0px ${IMAGE_OBSERVER_ROOT_MARGIN_PX}px 0px`, threshold: 0.1 });
}

function observeImage(img) {
  if (!img || !isEnabled) return;
  const effectiveUrl = getEffectiveImageUrl(img);
  const previousObservedSrc = img.dataset.pblockerObservedSrc || '';
  if (img.dataset.pblockerObserved === 'true' && previousObservedSrc === effectiveUrl) return;
  if (previousObservedSrc && previousObservedSrc !== effectiveUrl && img.classList) {
    // The node now holds a different picture, so the old AI verdict is stale.
    // Hand it to the AI blocker rather than unblurring here: on virtualised
    // feeds (X/Twitter) the same <img> is recycled across posts, and simply
    // dropping the blur exposed the new image for the whole classification
    // round-trip. onImageSrcChanged() re-hides it until a fresh verdict lands
    // and reveals it itself when the AI filter is off.
    if (typeof window.AIImageBlocker !== 'undefined' &&
        window.AIImageBlocker &&
        typeof window.AIImageBlocker.onImageSrcChanged === 'function') {
      window.AIImageBlocker.onImageSrcChanged(img);
    } else {
      img.classList.remove('pblocker-ai-blocked');
    }
  }
  img.dataset.pblockerObserved = 'true';
  if (effectiveUrl) {
    img.dataset.pblockerObservedSrc = effectiveUrl;
  } else {
    delete img.dataset.pblockerObservedSrc;
  }
  
  // CRITICAL FIX: Check image URL immediately (before it loads/displays)
  // Don't wait for IntersectionObserver - block bad URLs instantly
  const quickCheck = shouldBlockImageQuickly(img);
  if (quickCheck) {
    hideElement(img, 'image');
    notifyBackground('image_filtered', { count: 1 });
    return; // Don't observe further
  }

  // Preserve full remote/blocklist coverage without materializing the entire
  // list in this page. Checks for many images sharing a CDN host coalesce into
  // one background message and cache one boolean for the rest of the page.
  const checkedUrl = effectiveUrl;
  if (checkedUrl) {
    const relatedUrls = [checkedUrl, ...getImageContextLinks(img)];
    Promise.all(relatedUrls.map(isUrlBlockedByBackground)).then(verdicts => {
      if (!verdicts.some(Boolean) || !img.isConnected) return;
      if (getEffectiveImageUrl(img) !== checkedUrl) return;
      if (img.dataset.pblockerHidden !== 'true') {
        hideElement(img, 'image');
        notifyBackground('image_filtered', { count: 1 });
      }
    }).catch(() => {});
  }
  
  // For images that pass quick check, use IntersectionObserver for deeper analysis
  if (!imageObserver) setupIntersectionObserver();
  try { imageObserver.observe(img); } catch (_) {}
  // Deliberately no prewarmImageAnalysis() here.
  //
  // It called isImageNearViewport(), i.e. getBoundingClientRect(), once per
  // <img> — a forced synchronous layout — while the same loop was writing
  // `display: none` and inserting placeholders through hideElement(). Read,
  // write, read, write is the textbook layout-thrash pattern, and on an image
  // grid of a few hundred pictures it meant a few hundred full-document layout
  // flushes in one task, repeated on every processContent().
  //
  // Nothing is lost. IMAGE_OBSERVER_ROOT_MARGIN_PX gives the observer 1400px of
  // bottom margin, so it fires well over a screen before an image is visible,
  // off the main thread, and it delivers an initial callback for targets that
  // are already on screen. The synchronous URL/keyword guard above still hides
  // obvious matches at parse time, and it never touches layout.
}

// Quick synchronous check for obvious adult content in URL
function shouldBlockImageQuickly(img) {
  try {
    const url = getEffectiveImageUrl(img);
    if (!url) return false;
    const level = normalizeImageFilterLevel(imageFilterLevel);
    
    const u = new URL(url, window.location.href);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    if (isTrustedDomain(url) || isKnownSafeImageHost(url)) {
      if (debugMode) log('[Quick Image] Allowed — trusted/safe CDN:', host);
      return false;
    }

    const cleanPage = isCleanPageHost();
    if (cleanPage && level !== IMAGE_FILTER_LEVELS.STRICT) {
      if (isHostInDefaultBlocklist(host) || matchesAdultKeywordHost(host)) {
        if (debugMode) log('[Quick Image] Blocked — adult host on clean page (mod/len):', host);
        return true;
      }
      return false;
    }
    
    if (isHostInDefaultBlocklist(host)) {
      if (debugMode) log('[Quick Image] Blocked — host in blocklist:', host);
      return true;
    }
    if (matchesAdultKeywordHost(host)) {
      if (debugMode) log('[Quick Image] Blocked — adult keyword in host:', host);
      return true;
    }
    
    let decodedPath = path;
    try { decodedPath = decodeURIComponent(path).toLowerCase(); } catch(_) {}
    
    const highConfMatch = HIGH_CONFIDENCE_PATH_KEYWORDS.test(decodedPath);
    if (highConfMatch) {
      if (debugMode) log('[Quick Image] Blocked — high-confidence path keyword:', decodedPath, '| level:', level);
      return true;
    }

    if (!cleanPage) {
      const ambigMatch = AMBIGUOUS_PATH_KEYWORDS.test(decodedPath);
      if (ambigMatch) {
        if (debugMode) log('[Quick Image] Blocked — ambiguous path keyword on suspicious page:', decodedPath, '| level:', level);
        return true;
      }
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

// --- Iframe scanning ---
function processIframe(iframe) {
  try {
    const src = iframe.getAttribute('src') || '';
    const srcdoc = iframe.getAttribute('srcdoc') || '';
    // Keyed on the src that was judged, not a bare flag: a clean iframe has to
    // be marked too (otherwise every scheduleMediaDiscovery pass re-ran the URL
    // parse, three host matchers, a keyword scan of srcdoc and another
    // background round-trip for it), but an iframe that is later re-pointed at
    // a different src must still be re-checked.
    if (!iframe) return;
    if (iframe.dataset.pblockerProcessed === 'true' &&
        (iframe.dataset.pblockerCheckedSrc || '') === src) return;

    let shouldHide = false;
    if (src) {
      try {
        const url = new URL(src, window.location.href);
        const host = url.hostname;
        shouldHide = isAdultURL(url.href) || isHostInDefaultBlocklist(host) || matchesAdultKeywordHost(host);
      } catch (_) {
        // Non-standard src; fall back to keyword check
        shouldHide = containsAdultKeywords(src);
      }
    }

    if (!shouldHide && srcdoc) {
      // Lightweight keyword check for inline content
      shouldHide = containsAdultKeywords(srcdoc);
    }

    // Record what was judged before the async check resolves, so a re-entrant
    // discovery pass over the same clean iframe returns at the guard above.
    iframe.dataset.pblockerProcessed = 'true';
    iframe.dataset.pblockerCheckedSrc = src;

    if (shouldHide) {
      hideElement(iframe, 'iframe');
      notifyBackground('iframe_filtered', { src });
    } else if (src) {
      isUrlBlockedByBackground(src).then(blocked => {
        // Bails on `pblockerHidden`, not `pblockerProcessed` — the latter is now
        // set for clean iframes too, and checking it here would stop this
        // verdict from ever being applied.
        if (!blocked || !iframe.isConnected || iframe.dataset.pblockerHidden === 'true') return;
        if ((iframe.getAttribute('src') || '') !== src) return; // re-pointed meanwhile
        hideElement(iframe, 'iframe');
        notifyBackground('iframe_filtered', { src });
      }).catch(() => {});
    }
  } catch (err) {
    if (debugMode) log('Error processing iframe:', err);
  }
}

// --- Media (video) scanning ---
function getEffectiveMediaUrls(video) {
  const urls = [];
  try {
    const poster = video.getAttribute('poster');
    if (poster) urls.push(poster);
  } catch (_) {}
  try {
    const sources = video.querySelectorAll('source[src]');
    sources.forEach(s => urls.push(s.getAttribute('src')));
  } catch (_) {}
  return urls.filter(Boolean);
}

function shouldBlockMedia(video) {
  const urls = getEffectiveMediaUrls(video);
  // Check poster and source URLs for adult signals
  for (const url of urls) {
    try {
      if (isAdultURL(url)) return true;
      const u = new URL(url, window.location.href);
      const host = u.hostname.toLowerCase();
      if (isHostInDefaultBlocklist(host) || matchesAdultKeywordHost(host)) return true;
      const path = u.pathname.toLowerCase();
      const strictInPath = /\b(porn|xxx|nude|naked|erotic|nsfw)\b/i.test(path);
      if (!isTrustedDomain(url) && !isKnownSafeImageHost(url) && strictInPath) return true;
    } catch (_) {
      if (containsAdultKeywords(url)) return true;
    }
  }
  // Alt/aria labels
  const label = (video.getAttribute('aria-label') || '').toLowerCase();
  if (label && containsAdultKeywords(label)) return true;
  return false;
}

function maybeBlockMedia(video) {
  if (video.dataset.pblockerHidden === 'true') return;
  if (shouldBlockMedia(video)) {
    hideElement(video, 'video');
    notifyBackground('video_filtered', { count: 1 });
  }
}

function setupMediaObserver() {
  if (mediaObserver) {
    try { mediaObserver.disconnect(); } catch (_) {}
  }
  mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting) {
        maybeBlockMedia(video);
        mediaObserver.unobserve(video);
      }
    }
  }, { root: null, rootMargin: '0px 0px 400px 0px', threshold: 0.1 });
}

function observeMedia(video) {
  if (!video || video.dataset.pblockerObserved === 'true') return;
  if (!mediaObserver) setupMediaObserver();
  video.dataset.pblockerObserved = 'true';
  try { mediaObserver.observe(video); } catch (_) {}
  const urls = getEffectiveMediaUrls(video);
  if (urls.length > 0) {
    Promise.all(urls.map(isUrlBlockedByBackground)).then(verdicts => {
      if (!verdicts.some(Boolean) || !video.isConnected) return;
      if (video.dataset.pblockerHidden !== 'true') {
        hideElement(video, 'video');
        notifyBackground('video_filtered', { count: 1 });
      }
    }).catch(() => {});
  }
}

// Background communication
function notifyBackground(type, data = {}) {
  try {
    browserAPI.runtime.sendMessage({
      type: type,
      url: window.location.href,
      title: document.title,
      ...data
    });
  } catch (error) {
    log('Error notifying background:', error);
  }
}

// Main processing functions
async function processContent() {
  if (isProcessing) return;
  enforceFacebookReelsBlock();
  enforceInstagramReelsBlock();
  // Respect whitelist and temporary disable
  const whitelisted = await isCurrentPageWhitelisted();
  pageWhitelisted = whitelisted;
  if (!isEnabled || whitelisted) return;
  
  isProcessing = true;
  
  try {
    // Check Reddit NSFW status first (if on Reddit)
    if (isRedditURL(window.location.href)) {
      const shouldBlock = await shouldBlockRedditPage(window.location.href);
      if (shouldBlock) {
        log('Reddit page blocked - subreddit is NSFW');
        redirectToBlockedPage('reddit_nsfw');
        return;
      }
    }

    const searchEngine = getSearchEngine();
    if (searchEngine === 'yandex' && shouldBlockCurrentSearchQuery()) {
      log('Yandex search blocked - explicit query detected');
      redirectToBlockedPage('search_query');
      return;
    }

    // Filter search results only on text/web results, not image search
    if (searchEngine && !isImagesSearchContext()) {
      await filterSearchResults();
    }
    
    // Filter images on all pages
    filterImages();
    // Filter video/GIF thumbnails on all pages
    filterMedia();

    // Social site feeds: per-post filtering without blocking entire site
    await filterSocialFeed();
    
    // The user's own title patterns come first — an explicit instruction
    // outranks the heuristics below it.
    if (checkCustomTitlePatterns()) {
      return;
    }
    // Check page title and metadata
    if (checkPageMetadata()) {
      return;
    }
    if (checkPageBodyText()) {
      return;
    }
    // AI text classifier (multilingual) — catches non-English adult pages the
    // keyword/blocklist scans miss; fuses with AI image-block evidence.
    if (checkPageTextWithModel()) {
      return;
    }

  } catch (error) {
    log('Error processing content:', error);
  } finally {
    isProcessing = false;
  }
}

function redirectToBlockedPage(reason = 'content', detail) {
  if (blockedTriggered) return;
  blockedTriggered = true;
  try { window.stop(); } catch (_) {}
  if (observer) { try { observer.disconnect(); } catch (_) {} }
  if (imageObserver) { try { imageObserver.disconnect(); } catch (_) {} }
  if (mediaObserver) { try { mediaObserver.disconnect(); } catch (_) {} }

  const blockedUrl = getBlockedRedirectUrl(window.location.href, reason, null, detail);
  
  // Notify background about the block
  notifyBackground('website_blocked', {
    url: window.location.href,
    title: document.title,
    reason: getBlockedReasonLabel(reason)
  });
  
  window.location.replace(blockedUrl);
}

// Batch processing for performance
const debouncedProcess = debounce(processContent, DEBOUNCE_DELAY);
// The page-text scan reads document.body.innerText, which is layout-dependent:
// reading it forces a full style + layout flush of the document. It was armed
// off EVERY element insertion at DEBOUNCE_DELAY (100ms), and useSmartBlocking
// defaults on, so any page with an ad rotator, a live feed or a chat widget
// re-flushed layout ten times a second for as long as it was open.
//
// This is a page-level verdict, not a per-element one — it does not need 100ms
// latency. Debounce it far longer and take it during idle time.
const PAGE_TEXT_SCAN_DEBOUNCE = 750;

function whenIdle(run) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 0);
}

const debouncedPageTextScan = debounce(() => {
  whenIdle(async () => {
    if (!isEnabled || blockedTriggered) return;
    const whitelisted = await isCurrentPageWhitelisted();
    if (whitelisted) return;
    if (checkPageBodyText()) return;
    checkPageTextWithModel();
  });
}, PAGE_TEXT_SCAN_DEBOUNCE);

// Incremental processor for newly added search result containers
async function processPendingResults() {
  if (pendingResults.size === 0) return;
  const toProcess = Array.from(pendingResults);
  pendingResults.clear();
  let blockedCount = 0;

  // Resolve through the same rules the full pass uses. Judging a raw mutation
  // target directly would hide the wrong element on engines that wrap their
  // results, skip the explicit-signals-only policy, and — worst — mark a
  // half-hydrated row as inspected so it was never revisited.
  const candidates = [];
  const claimed = new Set();
  for (const el of toProcess) {
    const resolved = resolveResultContainer(el);
    if (!resolved || claimed.has(resolved.container)) continue;
    claimed.add(resolved.container);
    candidates.push(resolved);
  }

  const backgroundVerdicts = await Promise.all(
    candidates.map(({ container }) => hasBackgroundBlockedLink(container))
  );

  for (let i = 0; i < candidates.length; i++) {
    const { container, explicitOnly } = candidates[i];
    try {
      const shouldBlock = await shouldBlockElement(container, backgroundVerdicts[i], { explicitOnly });
      if (shouldBlock) {
        hideElement(container, 'search-result');
        blockedCount++;
      } else {
        // Mark inspected to avoid redundant checks
        container.dataset.pblockerProcessed = 'true';
      }
    } catch (_) {
      // Fail-open: skip this element
    }
  }

  if (blockedCount > 0) {
    notifyBackground('search_result_filtered', { count: blockedCount });
    addBlockedResultCount(blockedCount);
  }
  // Runs even at zero: this pass fires on every result the page hydrates, and it
  // is the only thing that redraws the summary after the engine re-renders its
  // result list and discards the node.
  updateBlockedResultsNotice();
}

const debouncedProcessResults = debounce(processPendingResults, DEBOUNCE_DELAY);

// Incremental processor for newly added social post containers
async function processPendingSocial() {
  if (pendingSocial.size === 0) return;
  const toProcess = Array.from(pendingSocial);
  pendingSocial.clear();
  let blockedCount = 0;
  const site = getSocialSite();
  const candidates = toProcess.filter(el =>
    el && el.nodeType === Node.ELEMENT_NODE && el.dataset?.pblockerProcessed !== 'true'
  );
  const backgroundVerdicts = await Promise.all(candidates.map(hasBackgroundBlockedLink));
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    try {
      // First, apply fast synchronous checks (labels + direct adult links)
      if (shouldBlockSocialPost(el, site) || backgroundVerdicts[i]) {
        hideElement(el, 'social-post');
        blockedCount++;
      } else if (site === 'reddit') {
        // Optional asynchronous check: if the post links to an NSFW subreddit
        const subLink = el.querySelector('a[href*="/r/"]');
        let blocked = false;
        if (subLink && subLink.href) {
          try {
            const isNSFW = await shouldBlockRedditPage(subLink.href);
            if (isNSFW) {
              hideElement(el, 'social-post');
              blockedCount++;
              blocked = true;
            }
          } catch (_) {}
        }
        if (!blocked) {
          el.dataset.pblockerProcessed = 'true';
        }
      } else {
        el.dataset.pblockerProcessed = 'true';
      }
    } catch (_) {}
  }
  if (blockedCount > 0) {
    notifyBackground('social_post_filtered', { count: blockedCount });
  }
}

const debouncedProcessSocial = debounce(processPendingSocial, DEBOUNCE_DELAY);

// Process queued media roots in one coalesced idle pass. Firefox content-script
// DOM calls cross a compartment boundary, so one combined native selector is
// materially cheaper than three calls per added element.
function scheduleMediaDiscovery() {
  if (mediaDiscoveryScheduled) return;
  mediaDiscoveryScheduled = true;
  const run = () => {
    mediaDiscoveryScheduled = false;
    if (blockedTriggered || !isEnabled || pageWhitelisted) { pendingMediaNodes.clear(); return; }
    const nodes = pendingMediaNodes;
    pendingMediaNodes = new Set();
    for (const el of nodes) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) continue;
      if (el.tagName === 'IMG') observeImage(el);
      else if (el.tagName === 'VIDEO') observeMedia(el);
      else if (el.tagName === 'IFRAME') processIframe(el);
      const media = el.querySelectorAll?.('img, video, iframe');
      media && media.forEach(node => {
        if (node.tagName === 'IMG') observeImage(node);
        else if (node.tagName === 'VIDEO') observeMedia(node);
        else processIframe(node);
      });
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 500 });
  } else {
    setTimeout(run, 100);
  }
}

/**
 * Stop observing media inside a subtree that has left the document.
 *
 * IntersectionObserver holds a STRONG reference to every target, and the only
 * paths that unobserve are "it intersected" and "filtering was switched off".
 * On a virtualised feed (X, Reddit, Instagram) nodes are created and discarded
 * by the hundred without most of them ever intersecting, so without this the
 * observer pinned every <img> the tab had ever rendered — an unbounded leak
 * that only shows up after a long browsing session, which is exactly when
 * users reported the browser getting slow.
 */
function releaseObservedMedia(el) {
  try {
    if (el.tagName === 'IMG') { imageObserver && imageObserver.unobserve(el); return; }
    if (el.tagName === 'VIDEO') { mediaObserver && mediaObserver.unobserve(el); return; }
    if (typeof el.querySelectorAll !== 'function') return;
    if (imageObserver) {
      el.querySelectorAll('img').forEach(node => {
        try { imageObserver.unobserve(node); } catch (_) {}
      });
    }
    if (mediaObserver) {
      el.querySelectorAll('video').forEach(node => {
        try { mediaObserver.unobserve(node); } catch (_) {}
      });
    }
  } catch (_) {}
}

// Removed subtrees are drained on idle, never inside the observer callback.
// A virtualised feed removes rows on every frame, and querySelectorAll() per
// removal in the synchronous callback measurably raised mutation p95 — the
// same mistake this whole change set exists to remove.
let pendingReleaseNodes = new Set();
let mediaReleaseScheduled = false;

function scheduleMediaRelease() {
  if (mediaReleaseScheduled) return;
  mediaReleaseScheduled = true;
  const run = () => {
    mediaReleaseScheduled = false;
    const nodes = pendingReleaseNodes;
    pendingReleaseNodes = new Set();
    for (const node of nodes) {
      // Re-parented rather than discarded: still in the document, still wanted.
      if (node.isConnected) continue;
      releaseObservedMedia(node);
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
  else setTimeout(run, 200);
}

// Mutation observer for dynamic content
function setupMutationObserver() {
  if (observer) {
    observer.disconnect();
  }
  
  observer = new MutationObserver((mutations) => {
    // Cheap early-out: once a page is blocked, the extension is off, or the site
    // is whitelisted, there is nothing to do — and we must not keep queuing work
    // on every mutation.
    if (blockedTriggered || !isEnabled || pageWhitelisted) return;

    let scheduleResultsProcess = false;
    let scheduleSocialProcess = false;
    let schedulePageTextScan = false;
    let scheduleMedia = false;
    const engine = getSearchEngine();
    const containerSelector = engine ? searchContainerSelector(SEARCH_SELECTORS[engine]) : null;
    const socialSite = getSocialSite();
    const socialSelector = socialSite ? SOCIAL_SELECTORS[socialSite]?.containers : null;

    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const addedElements = [];
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node;
          addedElements.push(el);

          // A directly-added media element is O(1) to check, so do it NOW —
          // this preserves instant blocking of obvious bad-URL images/videos
          // (observeImage hides on a synchronous URL/keyword match). It was
          // never the perf problem; only the subtree *sweeps* of large added
          // containers were. Descendant discovery for container nodes is still
          // deferred to a coalesced idle pass (see scheduleMediaDiscovery).
          if (el.tagName === 'IMG') observeImage(el);
          else if (el.tagName === 'VIDEO') observeMedia(el);
          else if (el.tagName === 'IFRAME') processIframe(el);
          // A full-page text scan is only worth scheduling when a text feature
          // is actually enabled. We no longer read el.textContent per node just
          // to decide this — the debounced scan re-reads the page once anyway,
          // so reading here (O(subtree), O(n^2) as a streaming message grows)
          // was pure waste. Flag on any element addition; the debounce coalesces.
          if (anyTextFeatureOn) {
            schedulePageTextScan = true;
          }

          // Tight scope: only schedule incremental processing for search engines
          if (containerSelector) {
            // If the added node itself is a result container, queue it
            if (el.matches?.(containerSelector)) {
              pendingResults.add(el);
              scheduleResultsProcess = true;
            } else {
              // Otherwise, queue any descendant result containers
              const newContainers = el.querySelectorAll?.(containerSelector);
              if (newContainers && newContainers.length) {
                newContainers.forEach((c) => {
                  if (c && c.dataset.pblockerProcessed !== 'true') {
                    pendingResults.add(c);
                  }
                });
                scheduleResultsProcess = true;
              }
            }
          }
          // Social containers: queue incremental processing
          if (socialSelector) {
            if (el.matches?.(socialSelector)) {
              pendingSocial.add(el);
              scheduleSocialProcess = true;
            } else {
              const newSocial = el.querySelectorAll?.(socialSelector);
              if (newSocial && newSocial.length) {
                newSocial.forEach((c) => {
                  if (c && c.dataset.pblockerProcessed !== 'true') {
                    pendingSocial.add(c);
                  }
                });
                scheduleSocialProcess = true;
              }
            }
          }
        }

        if (mutation.removedNodes.length > 0) {
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            pendingReleaseNodes.add(node);
          }
          scheduleMediaRelease();
        }

        if (addedElements.length > 0) {
          // DocumentFragment/React batches can expose hundreds of sibling nodes
          // in one record. Query their shared target once in native selector
          // code; querying each sibling separately is a multi-second Firefox
          // cross-compartment hot path. Small/single additions keep tight roots
          // to avoid rescanning a large container unnecessarily.
          const target = mutation.target;
          if (addedElements.length > 4 && target && target.nodeType === Node.ELEMENT_NODE) {
            pendingMediaNodes.add(target);
          } else {
            addedElements.forEach(el => pendingMediaNodes.add(el));
          }
          scheduleMedia = true;
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        // Check for title/meta changes in head
        if (target.tagName === 'TITLE' || (target.tagName === 'META' && ['title', 'description', 'keywords', 'og:title', 'og:description', 'twitter:title'].includes(target.name || target.getAttribute('property')))) {
          checkPageMetadata();
          if (anyTextFeatureOn) schedulePageTextScan = true;
        }

        // Attribute changes on media (src/srcset/poster/srcdoc) can flip an
        // element to adult content — re-check it, but off the synchronous path.
        if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO' || target.tagName === 'IFRAME')) {
          pendingMediaNodes.add(target);
          scheduleMedia = true;
        } else if (target && target.tagName === 'SOURCE') {
          const v = target.closest?.('video');
          if (v) { pendingMediaNodes.add(v); scheduleMedia = true; }
        }
        // Attribute changes inside a search result: re-check only that container
        if (containerSelector && target && target.closest) {
          const container = target.closest(containerSelector);
          if (container && container.dataset.pblockerProcessed !== 'true') {
            pendingResults.add(container);
            scheduleResultsProcess = true;
          }
        }
        // Attribute changes inside a social post container: re-check only that post
        if (socialSelector && target && target.closest) {
          const s = target.closest(socialSelector);
          if (s && s.dataset.pblockerProcessed !== 'true') {
            pendingSocial.add(s);
            scheduleSocialProcess = true;
          }
        }
      }
    }

    // Tight scope: prefer incremental result processing over full-page reprocessing
    if (scheduleMedia) {
      scheduleMediaDiscovery();
    }
    if (scheduleResultsProcess) {
      debouncedProcessResults();
    }
    if (scheduleSocialProcess) {
      debouncedProcessSocial();
    }
    if (schedulePageTextScan) {
      debouncedPageTextScan();
    }
  });

  const observeConfig = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-src', 'data-lazy-src', 'srcdoc', 'poster', 'content']
  };

  const startObserving = () => {
    // Prefer documentElement to catch head changes (title/meta)
    const root = document.documentElement || document.body || document;
    if (!root || typeof root.nodeType !== 'number') return false;
    try {
      observer.observe(root, observeConfig);
      return true;
    } catch (_) {
      return false;
    }
  };

  if (startObserving()) return;

  const onReady = () => {
    if (startObserving()) {
      document.removeEventListener('DOMContentLoaded', onReady);
    }
  };

  document.addEventListener('DOMContentLoaded', onReady);
  setTimeout(onReady, 250);
}

// Event listeners
function setupEventListeners() {
  // Listen for storage changes
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.pblocker_settings) {
      const previousLevel = imageFilterLevel;
      const previousEnabled = isEnabled;
      const previousTreatment = searchResultTreatment;
      _cleanPageHostCache = null;
      loadSettings().then(() => {
        const levelChanged = previousLevel !== imageFilterLevel;
        const becameDisabled = previousEnabled && !isEnabled;
        if (levelChanged || becameDisabled) {
          restoreBlockedMediaElements();
        }
        // Switching treatment has to redo the results already on screen —
        // otherwise the tab keeps the old presentation until it is reloaded,
        // and the picker looks like it did nothing.
        if (previousTreatment !== searchResultTreatment) {
          resetBlockedSearchResults();
        }
        log('Settings updated, reprocessing content');
        processContent();
        // processContent() only filters *unprocessed* results, so a summary that
        // just became visible (or has to disappear) needs its own nudge. Same for
        // the pill when the count moves to or from the toolbar.
        updateBlockedResultsNotice();
        updateFloatingCounter();
      });
    }

    // A list that just finished downloading has to reach the page without a
    // reload, or a fresh subscription looks like it did nothing.
    if (changes.pblocker_subscriptions || changes.pblocker_subscription_rules) {
      browserAPI.storage.local.get(['pblocker_subscriptions', 'pblocker_subscription_rules'])
        .then((store) => {
          loadSubscriptionRules(store.pblocker_subscriptions, store.pblocker_subscription_rules);
          resetCustomPatternCache();
          processContent();
        })
        .catch(() => {});
    }

    if (changes[BLOCKLIST_META_KEY]) {
      // Background owns the canonical list. Invalidate only the tiny per-page
      // verdict cache; cloning the refreshed 200k-entry snapshot here causes a
      // multi-second main-thread stall in Firefox.
      backgroundBlocklistHostCache.clear();
      _cleanPageHostCache = null;
      log('Blocklist host verdict cache invalidated');
      warmCurrentPageBlocklistHost()
        .then(() => processContent())
        .catch(() => {});
    }
  });
  
  // Process content when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(processContent, 100);
    });
  } else {
    setTimeout(processContent, 100);
  }
  
  // Handle dynamic content changes
  setTimeout(setupMutationObserver, 500);
  
  // Re-process on navigation (for SPAs)
  window.addEventListener('popstate', debouncedProcess);
  window.addEventListener('popstate', () => consoleLogPageTitle('popstate'));

  // Handle search form submissions - only process results, don't interfere with search
  document.addEventListener('submit', (e) => {
    if (e.target.matches('form[role="search"], .search-form, #search-form')) {
      // Wait for search results to load, then filter them
      setTimeout(debouncedProcess, 2000);
    }
  });
}

function consoleLogPageTitle(source) {
  try {
    console.log('BlockNSFW: Page title', {
      source,
      title: document.title || '',
      url: window.location.href,
      host: window.location.hostname,
      readyState: document.readyState
    });
  } catch (_) {}
}

// Initialization
async function init() {
  try {
    consoleLogPageTitle('init');
    log('Content script initializing on', window.location.hostname);

    // Load settings, then warm the one canonical-list verdict needed by the
    // synchronous clean-page heuristics. The full list remains in background.
    await loadSettings();
    await warmCurrentPageBlocklistHost();

    // Set up event listeners and observers
    setupEventListeners();
    setupIntersectionObserver();
    setupMutationObserver();

    // Initial pass to register images and check search results
    processContent();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => consoleLogPageTitle('dom_content_loaded'), { once: true });
    } else {
      setTimeout(() => consoleLogPageTitle('ready'), 0);
    }
    
    log('Content script initialized successfully');
  } catch (error) {
    log('Error initializing content script:', error);
  }
}

// Start the extension
init();

// Export for debugging (development only)
if (typeof window !== 'undefined') {
  window.PBlocker = {
    processContent,
    filterSearchResults,
    filterImages,
    loadSettings,
    isEnabled: () => isEnabled,
    getSearchEngine,
    toggleDebug: async () => {
      debugMode = !debugMode;
      try {
        const stored = await browserAPI.storage.local.get(SETTINGS_KEY);
        const settings = stored[SETTINGS_KEY] || {};
        settings.debugMode = debugMode;
        await browserAPI.storage.local.set({ [SETTINGS_KEY]: settings });
      } catch (error) {
        console.error('BlockNSFW: Failed to persist debug toggle', error);
      }
      log('Debug mode toggled via console:', debugMode);
    },
    testKeywords: (text) => containsAdultKeywords(text),
    testURL: (url) => isAdultURL(url),
    setEnabled: (enabled) => { isEnabled = enabled; log('Filtering enabled:', isEnabled); },
    testElement: (element) => shouldBlockElement(element),
    reprocessResults: () => filterSearchResults(),
    testBlockedDesign: () => {
      // Create a test blocked result to preview the design
      const testContainer = document.createElement('div');
      testContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000; width: 400px;';
      const blockedElement = createBlockedResultElement();
      testContainer.appendChild(blockedElement);
      document.body.appendChild(testContainer);
      
      // Auto-remove after 10 seconds (longer to see icon loading)
      setTimeout(() => {
        if (document.body.contains(testContainer)) {
          document.body.removeChild(testContainer);
        }
      }, 10000);
      
      log('Test blocked result displayed for 10 seconds - watch for icon loading');
    },
    testIconUrls: () => {
      // Test all icon URLs to see which ones work
      const iconPaths = ['icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png'];
      iconPaths.forEach(path => {
        try {
          const url = browserAPI.runtime.getURL(path);
          log(`Testing icon URL: ${url}`);
          
          const img = new Image();
          img.onload = () => log(`✅ ${path} loaded successfully`);
          img.onerror = () => log(`❌ ${path} failed to load`);
          img.src = url;
        } catch (error) {
          log(`Error testing ${path}:`, error);
        }
      });
    },
    debugDuckDuckGo: () => {
      // Debug DuckDuckGo specific elements
      if (getSearchEngine() !== 'duckduckgo') {
        log('Not on DuckDuckGo - current engine:', getSearchEngine());
        return;
      }
      
      log('=== DuckDuckGo Debug Info ===');
      
      // Test all possible selectors
      const testSelectors = [
        '[data-testid="result"]',
        '.nrn-react-div', 
        '.result', 
        '.web-result', 
        '.react-results--main .result',
        'article',
        '[data-testid*="result"]',
        '.result__body',
        '.results .result'
      ];
      
      testSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          log(`✅ Found ${elements.length} elements with selector: ${selector}`);
          elements.forEach((el, i) => {
            if (i < 3) { // Log first 3 elements
              log(`  [${i}] Classes: ${el.className}, Data-testid: ${el.getAttribute('data-testid')}, Text: ${el.textContent.substring(0, 50)}...`);
            }
          });
        } else {
          log(`❌ No elements found for selector: ${selector}`);
        }
      });
      
      // Check for title links
      const titleSelectors = [
        'h2 a', 'h3 a', 
        'a[data-testid="result-title-a"]', 
        '.result__title a', 
        '[data-testid="result-title-a"]',
        'article h2 a',
        'article h3 a'
      ];
      
      log('\n=== Title Link Analysis ===');
      titleSelectors.forEach(selector => {
        const links = document.querySelectorAll(selector);
        if (links.length > 0) {
          log(`✅ Found ${links.length} title links with: ${selector}`);
        }
      });
    },
    testRedditNSFW: async (subredditName) => {
      // Test Reddit NSFW checking for a specific subreddit
      if (!subredditName) {
        log('Usage: window.PBlocker.testRedditNSFW("subredditname")');
        return;
      }
      
      log(`Testing Reddit NSFW status for r/${subredditName}...`);
      try {
        const isNSFW = await checkRedditSubredditNSFW(subredditName);
        log(`Result: r/${subredditName} is ${isNSFW ? 'NSFW' : 'SFW'}`);
        return isNSFW;
      } catch (error) {
        log('Error testing Reddit NSFW:', error);
        return false;
      }
    },
    testRedditURL: (url) => {
      // Test Reddit URL parsing
      if (!url) {
        url = window.location.href;
      }
      
      log('=== Reddit URL Analysis ===');
      log('URL:', url);
      log('Is Reddit URL:', isRedditURL(url));
      
      if (isRedditURL(url)) {
        const subreddit = extractSubredditFromURL(url);
        log('Extracted subreddit:', subreddit);
        
        if (subreddit) {
          log(`To test NSFW status, run: window.PBlocker.testRedditNSFW("${subreddit}")`);
        }
      }
    },
    clearRedditCache: () => {
      // Clear Reddit NSFW cache
      const cacheSize = redditNSFWCache.size;
      redditNSFWCache.clear();
      log(`Cleared Reddit NSFW cache (${cacheSize} entries)`);
    },
    getStats: () => ({ 
      enabled: isEnabled, 
      debug: debugMode, 
      blocklistHostCacheSize: backgroundBlocklistHostCache.size,
      searchEngine: getSearchEngine(),
      logoUrl: browserAPI.runtime.getURL('icons/icon-48.png')
    })
  };
}
