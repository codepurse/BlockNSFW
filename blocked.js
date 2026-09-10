const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

const url = getParam('url') || 'Unknown URL';
const reason = getParam('reason') || '';
const matched = getParam('matched') || '';
const score = getParam('score') || '';
// `mode` is deliberately not read from the query string any more — see the
// plain-HTML branch at the bottom of this file. content.js still sends it, so
// older copies of the blocked page keep working during an update.

function getReasonMeta(reasonCode) {
  switch (reasonCode) {
    case 'dns_blocked':
      return {
        sourceLabel: 'DNS Protection',
        detail: 'Blocked by DNS Protection',
        message: 'This site was blocked by DNS Protection using Cloudflare for Families before the page could load.'
      };
    case 'custom_blocklist':
      return {
        sourceLabel: 'Custom Blocklist',
        detail: 'Blocked by your custom blocklist',
        message: 'This site matches a rule in your custom blocklist, so BlockNSFW stopped it before it finished loading.'
      };
    case 'default_blocklist':
    case 'instant_host_match':
      return {
        sourceLabel: 'Built-in Blocklist',
        detail: 'Blocked by the built-in blocklist',
        message: 'This site matches BlockNSFW\'s built-in blocklist and was blocked before it could load.'
      };
    case 'smart_filter':
    case 'instant_keyword_match':
      return {
        sourceLabel: 'Smart Keyword Filter',
        detail: 'Blocked by the smart keyword filter',
        message: 'This site was blocked because it matched BlockNSFW\'s smart keyword filter.'
      };
    case 'search_query':
      return {
        sourceLabel: 'Search Filter',
        detail: 'Blocked by search query filter',
        message: 'This page was blocked because the search query matched your adult-content filters.'
      };
    case 'reddit_nsfw':
      return {
        sourceLabel: 'NSFW Community Filter',
        detail: 'Blocked due to NSFW subreddit detection',
        message: 'This page was blocked because it appears to belong to an NSFW Reddit community.'
      };
    case 'metadata_scan':
      return {
        sourceLabel: 'Page Metadata Filter',
        detail: 'Blocked by metadata scan',
        message: 'This page was blocked because its title or metadata matched your adult-content filters.'
      };
    case 'page_text_scan':
      return {
        sourceLabel: 'Page Text Filter',
        detail: 'Blocked by page text scan',
        message: 'This page was blocked because its visible text repeatedly matched explicit-content keywords.'
      };
    case 'ai_text_scan':
      return {
        sourceLabel: 'AI Text Scan',
        detail: 'Blocked by AI text scan',
        message: 'This page was blocked because the on-device AI text classifier judged its content to be adult/explicit.'
      };
    case 'blocked':
    case 'content':
    case 'local_filter':
      return {
        sourceLabel: 'Local Filter Rules',
        detail: 'Blocked by local filter rules',
        message: 'This site was blocked because it matched BlockNSFW\'s local filtering rules.'
      };
    default:
      return {
        sourceLabel: 'Protection Rules',
        detail: reasonCode ? reasonCode.replaceAll('_', ' ') : 'Blocked by protection rules',
        message: 'This site has been blocked because it matched your protection settings.'
      };
  }
}

const reasonMeta = getReasonMeta(reason);

const urlEl = document.getElementById('target-url');
if (urlEl) {
  urlEl.textContent = url;
}

const messageEl = document.querySelector('.blocked-message');
if (messageEl && reasonMeta.message) {
  messageEl.textContent = reasonMeta.message;
}

const subtitleEl = document.querySelector('.blocked-subtitle');
if (subtitleEl && reasonMeta.sourceLabel) {
  subtitleEl.textContent = `BlockNSFW – ${reasonMeta.sourceLabel}`;
}

if (reason && urlEl) {
  const container = urlEl.parentNode;
  // Insert new nodes right after `anchor`, advancing it so they stay in order.
  let anchor = urlEl;
  const insertAfterAnchor = (node) => {
    container.insertBefore(node, anchor.nextSibling);
    anchor = node;
  };

  const reasonEl = document.createElement('p');
  reasonEl.className = 'muted';
  reasonEl.textContent = 'Reason: ' + reasonMeta.detail;
  insertAfterAnchor(reasonEl);

  // The AI text scan reports a confidence score in [0,1]; show it as a percent.
  const scorePct = score ? Math.round(parseFloat(score) * 100) : NaN;
  if (!Number.isNaN(scorePct)) {
    const conf = document.createElement('p');
    conf.className = 'muted';
    conf.textContent = `AI confidence: ${scorePct}%`;
    insertAfterAnchor(conf);
  }

  // Show the specific text that triggered the block.
  const matchedTerms = matched
    ? matched.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  if (matchedTerms.length > 0) {
    const label = document.createElement('div');
    label.className = 'blocked-url-label';
    label.style.marginTop = '1rem';
    label.textContent = reason === 'ai_text_scan'
      ? 'Words that most influenced the AI'
      : 'Detected text';
    insertAfterAnchor(label);

    const chips = document.createElement('div');
    chips.className = 'matched-terms';
    matchedTerms.forEach(term => {
      const chip = document.createElement('span');
      chip.className = 'matched-term';
      chip.textContent = term;
      chips.appendChild(chip);
    });
    insertAfterAnchor(chips);
  }
}

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

// User-supplied HTML replaces the document outright.
//
// Which page type to render is read from settings, not from the `mode` query
// parameter. The parameter is set by content.js from the same setting, so
// legitimate navigations are unaffected — but taking it from the URL let any
// website choose this rendering path for a user who had never selected it.
(async () => {
  try {
    const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
    if (!settings || settings.blockedPageType !== 'plain_html') return;
    const html = typeof settings.plainBlockedPageHtml === 'string' ? settings.plainBlockedPageHtml : '';
    if (!html || !html.trim()) return;
    const rendered = html
      .replace(/\{\{\s*url\s*\}\}/g, escapeHtml(url))
      .replace(/\{\{\s*reason\s*\}\}/g, escapeHtml(reasonMeta.detail));
    document.open();
    document.write(rendered);
    document.close();
  } catch (_) {}
})();

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
