const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

// The detail normally arrives through session storage under a random key, so
// the address of the blocked site never enters this page's URL — and so never
// enters browser history, omnibox suggestions, or Chrome's history sync.
// content.js used to put it in the query string, which meant `location.replace`
// kept the adult URL out of history and then wrote a history entry containing
// it anyway. See stashBlockedDetail() in content.js.
//
// The query-string form is still read, for three cases that all still occur: a
// custom blocked page (someone else's document, which cannot read our
// storage), a browser without session storage, and a redirect already in
// flight when the extension updated.
const detailKey = getParam('k') || '';

let url = getParam('url') || 'Unknown URL';
let reason = getParam('reason') || '';
let matched = getParam('matched') || '';
let score = getParam('score') || '';
// `mode` is deliberately not read from the query string any more — see the
// plain-HTML branch at the bottom of this file. content.js still sends it, so
// older copies of the blocked page keep working during an update.

// The settings page's Preview button opens ?preview=<design>. It can only pick
// one of the registry's designs, and it shows a placeholder address, never a
// real one: this page is web-accessible, so any website can open that URL.
const PREVIEW_URL = 'https://example.com/';
const previewTheme = (() => {
  const themes = globalThis.BlockedThemes;
  const id = getParam('preview');
  return (themes && id && themes.get(id)) ? id : '';
})();

// What held the page, in three forms:
//  - `sourceLabel`: the name of the rule, for the "reason" line;
//  - `detail`: the phrase a custom template's {{reason}} receives, unchanged so
//    pages people have written keep reading the same;
//  - `message`: one plain sentence for the "why" section.
// `when` says whether the page was stopped before it loaded or closed after it
// was read, so the line under the headline stays true.
function getReasonMeta(reasonCode) {
  switch (reasonCode) {
    case 'dns_blocked':
      return {
        sourceLabel: 'DNS protection',
        detail: 'Blocked by DNS Protection',
        message: 'Your family-safe DNS resolver reported this site as adult before it loaded.',
        when: 'before'
      };
    case 'custom_blocklist':
      return {
        sourceLabel: 'Your blocklist',
        detail: 'Blocked by your custom blocklist',
        message: 'This site matches an entry on your own blocklist.',
        when: 'before'
      };
    case 'default_blocklist':
    case 'instant_host_match':
      return {
        sourceLabel: 'Built-in blocklist',
        detail: 'Blocked by the built-in blocklist',
        message: 'This site is on BlockNSFW’s built-in blocklist.',
        when: 'before'
      };
    case 'smart_filter':
    case 'instant_keyword_match':
      return {
        sourceLabel: 'Keyword filter',
        detail: 'Blocked by the smart keyword filter',
        message: 'The address matched BlockNSFW’s keyword filter.',
        when: 'before'
      };
    case 'search_query':
      return {
        sourceLabel: 'Search filter',
        detail: 'Blocked by search query filter',
        message: 'The search matched your adult-content filters.',
        when: 'before'
      };
    case 'reddit_nsfw':
      return {
        sourceLabel: 'NSFW community filter',
        detail: 'Blocked due to NSFW subreddit detection',
        message: 'This page belongs to a Reddit community marked NSFW.',
        when: 'neutral'
      };
    case 'metadata_scan':
      return {
        sourceLabel: 'Page details',
        detail: 'Blocked by metadata scan',
        message: 'The page’s title or description matched your adult-content filters.',
        when: 'after'
      };
    case 'page_text_scan':
      return {
        sourceLabel: 'Page text',
        detail: 'Blocked by page text scan',
        message: 'The page’s text matched explicit-content words again and again.',
        when: 'after'
      };
    case 'ai_text_scan':
      return {
        sourceLabel: 'On-device AI',
        detail: 'Blocked by AI text scan',
        message: 'The AI on your device read the page’s text and judged it adult.',
        when: 'after'
      };
    case 'blocked':
    case 'content':
    case 'local_filter':
      return {
        sourceLabel: 'Local filter rules',
        detail: 'Blocked by local filter rules',
        message: 'This page matched BlockNSFW’s local filter rules.',
        when: 'neutral'
      };
    default:
      return {
        sourceLabel: 'Protection rules',
        detail: reasonCode ? reasonCode.replaceAll('_', ' ') : 'Blocked by protection rules',
        message: 'This page matched your protection settings.',
        when: 'neutral'
      };
  }
}

const HELD_LINE = {
  before: 'BlockNSFW stopped it before it loaded.',
  after: 'BlockNSFW closed it as soon as it read the page.',
  neutral: 'BlockNSFW stopped it from showing.'
};

// The address is never shown, on this page or any other: eight bullets and the
// top-level domain, the same length whatever the site, so nothing about it can
// be read off the screen. An IP address or an unreadable value keeps no ending.
function redactedHost(address) {
  const mask = '••••••••';
  try {
    const host = new URL(address).hostname;
    const dot = host.lastIndexOf('.');
    const ending = dot > 0 ? host.slice(dot + 1).toLowerCase() : '';
    return /^[a-z][a-z0-9-]*$/.test(ending) ? `${mask}.${ending}` : mask;
  } catch (_) {
    return mask;
  }
}

function addRecord(list, label, value, valueClass) {
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'record';
  const term = document.createElement('dt');
  term.className = 'meta';
  term.textContent = label;
  const data = document.createElement('dd');
  data.className = valueClass || 'why-value';
  data.textContent = value;
  row.appendChild(term);
  row.appendChild(data);
  list.appendChild(row);
}

// The page title, its address, its favicon and the words it matched are all
// part of what was held, so none of them is written here. The reason is named,
// and the AI's confidence, which is a number, not the page's content.
function renderDetail() {
  const reasonMeta = getReasonMeta(reason);

  const urlEl = document.getElementById('target-url');
  if (urlEl) {
    urlEl.textContent = redactedHost(url);
  }

  const messageEl = document.querySelector('.blocked-message');
  if (messageEl && reasonMeta.message) {
    messageEl.textContent = reasonMeta.message;
  }

  const subtitleEl = document.querySelector('.blocked-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = HELD_LINE[reasonMeta.when] || HELD_LINE.neutral;
  }

  if (reason) {
    const rows = document.getElementById('why-rows');
    addRecord(rows, 'reason', reasonMeta.sourceLabel);

    // The AI text scan reports a confidence score in [0,1]; show it as a percent.
    const scorePct = score ? Math.round(parseFloat(score) * 100) : NaN;
    if (!Number.isNaN(scorePct)) {
      addRecord(rows, 'ai confidence', `${scorePct}%`, 'record-value tnum');
    }
  }
}

/**
 * Fetch the stashed detail, then render.
 *
 * content.js writes it fire-and-forget so the redirect is not delayed, which
 * leaves a small race: this page can load before the write lands. One short
 * retry covers it. If nothing arrives the page still renders — with a generic
 * message rather than a wrong one — because a blocked page that fails to
 * appear is far worse than one missing its reason line.
 *
 * The record is deleted after reading. It exists only to survive one
 * navigation.
 */
async function loadStashedDetail() {
  const area = browserAPI.storage && browserAPI.storage.session;
  if (!detailKey || !area) return false;

  for (const waitMs of [0, 60, 180]) {
    if (waitMs) await new Promise(done => setTimeout(done, waitMs));
    let record;
    try {
      const stored = await area.get(detailKey);
      record = stored && stored[detailKey];
    } catch (_) {
      return false;
    }
    if (!record) continue;
    try { area.remove(detailKey); } catch (_) {}

    url = typeof record.url === 'string' && record.url ? record.url : url;
    reason = typeof record.reason === 'string' ? record.reason : reason;
    matched = Array.isArray(record.matched) ? record.matched.join(', ') : (record.matched || '');
    score = (typeof record.score === 'number' && isFinite(record.score))
      ? record.score.toFixed(2) : '';
    return true;
  }
  return false;
}

/**
 * User-supplied HTML replaces the document outright.
 *
 * Which page type to render is read from settings, not from the `mode` query
 * parameter. content.js sets that parameter from the same setting, so
 * legitimate navigations are unaffected — but taking it from the URL let any
 * website choose this rendering path for a user who had never selected it.
 *
 * Only the substituted values are escaped. The template is the user's own
 * HTML and is meant to render as markup; that is the feature.
 *
 * @returns {boolean} whether it took over the document
 */
function renderPlainHtml(settings) {
  try {
    if (!settings || settings.blockedPageType !== 'plain_html') return false;
    const html = typeof settings.plainBlockedPageHtml === 'string' ? settings.plainBlockedPageHtml : '';
    if (!html || !html.trim()) return false;
    const rendered = html
      .replace(/\{\{\s*url\s*\}\}/g, escapeHtml(url))
      .replace(/\{\{\s*reason\s*\}\}/g, escapeHtml(getReasonMeta(reason).detail));
    document.open();
    document.write(rendered);
    document.close();
    return true;
  } catch (_) {
    return false;
  }
}

async function loadSettings() {
  try {
    const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
    return settings || null;
  } catch (_) {
    return null;
  }
}

// --- Design -----------------------------------------------------------------
//
// Classic is this document as written. Any other design (blocked-themes.js)
// renders a hero above the card and restyles the card through
// html[data-theme]; the card keeps the reason, the address and the buttons.

// Whole days protection has stayed on, the same streak the Statistics page
// shows. It resets when protection is switched off, so it is described as
// days of protection, never as days clean.
function streakDays() {
  return browserAPI.storage.local.get('pblocker_streak_start').then((stored) => {
    const start = stored && stored.pblocker_streak_start;
    if (typeof start !== 'number' || !isFinite(start)) return null;
    return Math.floor((Date.now() - start) / (24 * 60 * 60 * 1000));
  });
}

function applyTheme(settings) {
  const themes = globalThis.BlockedThemes;
  if (!themes) return;
  const id = previewTheme || themes.normalize(settings && settings.blockedPageTheme);
  const theme = themes.get(id);
  const hero = document.getElementById('theme-hero');
  if (!theme || typeof theme.render !== 'function' || !hero) return;

  const reducedMotion = typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.dataset.theme = id;
  hero.hidden = false;
  const why = document.getElementById('why');
  if (why) why.open = false;
  // A design's buttons are plain words; the emoji belong to Classic.
  const back = document.getElementById('back-button');
  if (back) back.textContent = 'Go back';
  const settingsLink = document.getElementById('settings');
  if (settingsLink) settingsLink.textContent = 'Settings';
  theme.render({ doc: document, hero, reducedMotion, loadStreakDays: streakDays });
}

function revealPage() {
  try {
    document.documentElement.classList.remove('theme-pending');
  } catch (_) {}
}

// Settles once the stashed detail has been read, or given up on. The popup's
// question below waits on it rather than answering with the placeholder.
let markDetailSettled;
const detailSettled = new Promise(done => { markDetailSettled = done; });

// One driver, so every rendering path sees the same detail. The stashed record
// has to be read before any runs, or they render the query string's values and
// the whole point of stashing it is lost.
(async () => {
  if (previewTheme) {
    url = PREVIEW_URL;
    reason = 'default_blocklist';
  } else {
    try {
      await loadStashedDetail();
    } catch (_) {
      // Fall through and render whatever the query string carried.
    }
  }
  markDetailSettled();
  // A preview shows the design it names, whatever page type is saved.
  const settings = previewTheme ? null : await loadSettings();
  try {
    if (renderPlainHtml(settings)) return;
  } catch (_) {}
  try {
    applyTheme(settings);
  } catch (error) {
    console.warn('BlockNSFW: could not apply the blocked-page design', error);
  }
  revealPage();
  try {
    renderDetail();
  } catch (error) {
    console.warn('BlockNSFW: could not render blocked-page detail', error);
  }
})();

// --- Telling the popup which site this is -----------------------------------
//
// "Unblock this website" in the popup has to whitelist the site this page
// stands in for. It used to read that from ?url=, and still does for the
// fallback form. But the address is now kept out of this page's URL, and the
// record is deleted once read, so this page is the only thing that still
// knows. The popup found no url= parameter, fell back to the tab's own
// address, and whitelisted the extension's ID instead (issue #44, the same
// symptom as #26).
//
// So the popup asks, naming the key from the tab's address. Every blocked tab
// hears the question; only the one holding that key answers.
function blockedTargetUrl() {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
  } catch (_) {
    return null; // still the 'Unknown URL' placeholder
  }
}

function answerPopup(message, sender, sendResponse) {
  if (!message || message.type !== 'blocked_page_target') return false;
  if (!detailKey || message.key !== detailKey) return false;
  // Only our popup. Content scripts share this bus, and one tab's page has no
  // business learning what another tab blocked.
  const popupUrl = browserAPI.runtime.getURL('popup.html');
  if (!sender || sender.id !== browserAPI.runtime.id || sender.tab ||
      String(sender.url || '').split(/[?#]/)[0] !== popupUrl) {
    return false;
  }
  detailSettled.then(() => {
    const target = blockedTargetUrl();
    sendResponse(target ? { url: target } : null);
  });
  return true;
}

// Guarded: a throw here would stop the rest of this file, and the back button
// below would never be bound.
try {
  browserAPI.runtime.onMessage.addListener(answerPopup);
} catch (_) {}

// --- Page chrome ------------------------------------------------------------

function runtimeURL(path) {
  return browserAPI.runtime.getURL(path);
}

function openTab(target) {
  window.open(target, '_blank');
}

function goBack() {
  // content.js arrives here via location.replace(), so the blocked site is not
  // in history and stepping back lands on whatever preceded it. A tab opened
  // straight onto a blocked link has nothing behind it at all.
  if (history.length > 1) {
    history.back();
  } else {
    location.replace('about:blank');
  }
}

// Values substituted into the user's template. Everything on this page comes
// out of the query string, and blocked.html is a web-accessible resource — so
// any website can navigate to it, or frame it, with a `url` of its choosing.
// Written into the template unescaped, that is HTML injection into the
// extension's own origin.
//
// The extension CSP (script-src 'self') stops injected script from running,
// but it does not stop markup: an attacker could render a convincing
// "BlockNSFW — enter your PIN to continue" form at a genuine
// chrome-extension:// address, and img-src is unrestricted so the result can
// be sent somewhere. PIN phishing against this particular audience is not a
// theoretical concern.
//
// Only the substituted values are escaped. The template itself is the user's
// own HTML and is meant to render as HTML — that is the whole feature.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


document.addEventListener('DOMContentLoaded', () => {
  const settings = document.getElementById('settings');
  if (settings) {
    settings.addEventListener('click', (e) => {
      e.preventDefault();
      openTab(runtimeURL('options.html'));
    });
  }

  // Bound here rather than as an inline onclick: the extension CSP is
  // script-src 'self', which blocks inline handlers outright.
  const backButton = document.getElementById('back-button');
  if (backButton) {
    backButton.addEventListener('click', goBack);
  }
});
