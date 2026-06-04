const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

const url = getParam('url') || 'Unknown URL';
const reason = getParam('reason') || '';
const mode = getParam('mode') || '';

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
  const reasonEl = document.createElement('p');
  reasonEl.className = 'muted';
  reasonEl.textContent = 'Reason: ' + reasonMeta.detail;
  urlEl.parentNode.insertBefore(reasonEl, urlEl.nextSibling);
}

if (mode === 'plain_html') {
  (async () => {
    try {
      const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
      const html = settings && typeof settings.plainBlockedPageHtml === 'string' ? settings.plainBlockedPageHtml : '';
      if (!html || !html.trim()) return;
      const rendered = html
        .replace(/\{\{\s*url\s*\}\}/g, url)
        .replace(/\{\{\s*reason\s*\}\}/g, reasonMeta.detail);
      document.open();
      document.write(rendered);
      document.close();
    } catch (_) {}
  })();
}

document.addEventListener('DOMContentLoaded', () => {
  const settings = document.getElementById('settings');
  if (settings) {
    settings.addEventListener('click', (e) => {
      e.preventDefault();
      const optionsUrl = browserAPI.runtime.getURL('options.html');
      window.open(optionsUrl, '_blank');
    });
  }
});
