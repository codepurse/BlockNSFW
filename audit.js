/* BlockNSFW audit log */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Storage keys
const AUDIT_BLOCKED_KEY = 'pblocker_audit_blocked';
const AUDIT_DISABLED_KEY = 'pblocker_audit_disabled';
const AUDIT_RETENTION_DAYS = 30;
const ITEMS_PER_PAGE = 20;

// What the page says.
const MESSAGES = {
  loadFailed: 'The log didn’t load. Reload the page to try again.',
  listFailed: 'The log didn’t load.',
  nothingToExport: 'Nothing to export yet.',
  nothingMatchesExport: 'Nothing matches these filters, so there’s nothing to export.',
  clearFailed: 'The logs weren’t cleared. Try again.',
  cleared: 'Logs cleared.',
  refreshed: 'The log is up to date.',
  emptyFiltered: 'Nothing matches these filters.',
  emptyAll: 'Events will appear here as they happen.'
};

// State
let blockedEvents = [];
let disabledEvents = [];
let currentTab = 'all';
let currentPage = 1;
let loadFailed = false;
let filters = {
  search: '',
  dateFrom: null,
  dateTo: null,
  sortOrder: 'newest'
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadAuditData();
  setupEventListeners();
  renderCurrentView();
});

// Load audit data from storage
async function loadAuditData() {
  try {
    const data = await browserAPI.storage.local.get([
      AUDIT_BLOCKED_KEY,
      AUDIT_DISABLED_KEY
    ]);

    blockedEvents = data[AUDIT_BLOCKED_KEY] || [];
    disabledEvents = data[AUDIT_DISABLED_KEY] || [];

    // Clean old entries beyond retention period
    await cleanOldEntries();

    // Update statistics
    updateStatistics();

    if (loadFailed) {
      loadFailed = false;
      showError('');
    }
    return true;
  } catch (error) {
    console.error('Error loading audit data:', error);
    loadFailed = true;
    showError(MESSAGES.loadFailed);
    return false;
  }
}

// Clean entries older than retention period
async function cleanOldEntries() {
  const cutoffDate = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const originalBlockedCount = blockedEvents.length;
  const originalDisabledCount = disabledEvents.length;

  blockedEvents = blockedEvents.filter(event => event.timestamp >= cutoffDate);
  disabledEvents = disabledEvents.filter(event => event.timestamp >= cutoffDate);

  // Save if anything was cleaned
  if (originalBlockedCount !== blockedEvents.length || originalDisabledCount !== disabledEvents.length) {
    await browserAPI.storage.local.set({
      [AUDIT_BLOCKED_KEY]: blockedEvents,
      [AUDIT_DISABLED_KEY]: disabledEvents
    });
  }
}

// Update statistics display. The protection log holds both directions, so
// "turned off" counts only the switches off; the two rows add up to it.
function updateStatistics() {
  const turnedOff = disabledEvents.filter(event => !event.enabled).length;
  setText('stat-blocked-pages', formatCount(blockedEvents.length));
  setText('stat-disable-events', formatCount(turnedOff));
  setText('stat-enable-events', formatCount(disabledEvents.length - turnedOff));
  setText('stat-total-events', formatCount(blockedEvents.length + disabledEvents.length));
}

// Setup event listeners
function setupEventListeners() {
  // Tabs: click to choose; arrows, Home and End move between them.
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
    tab.addEventListener('keydown', onTabKeydown);
  });

  // Search
  const searchInput = document.getElementById('search-input');
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      filters.search = e.target.value.toLowerCase();
      currentPage = 1;
      renderCurrentView();
    }, 300);
  });

  // Date filters
  document.getElementById('date-from').addEventListener('change', (e) => {
    filters.dateFrom = e.target.value ? new Date(e.target.value).getTime() : null;
    currentPage = 1;
    renderCurrentView();
  });

  document.getElementById('date-to').addEventListener('change', (e) => {
    filters.dateTo = e.target.value ? new Date(e.target.value + 'T23:59:59').getTime() : null;
    currentPage = 1;
    renderCurrentView();
  });

  // Sort
  document.getElementById('sort-select').addEventListener('change', (e) => {
    filters.sortOrder = e.target.value;
    currentPage = 1;
    renderCurrentView();
  });

  // Reset filters
  document.getElementById('reset-filters-btn').addEventListener('click', () => {
    filters = {
      search: '',
      dateFrom: null,
      dateTo: null,
      sortOrder: 'newest'
    };
    document.getElementById('search-input').value = '';
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    document.getElementById('sort-select').value = 'newest';
    currentPage = 1;
    renderCurrentView();
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', refreshLog);

  // Export CSV
  document.getElementById('export-csv-btn').addEventListener('click', () => {
    exportToCSV();
  });

  // Pagination (delegated). The buttons are re-rendered on every view change,
  // so bind once on the document rather than per-button.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.page-button[data-page]');
    if (!btn || btn.disabled) return;
    const page = parseInt(btn.dataset.page, 10);
    if (Number.isFinite(page)) changePage(page);
  });

  // Clear logs: the button asks once, in place, before anything is cleared.
  document.getElementById('clear-logs-btn').addEventListener('click', openClearConfirm);
  document.getElementById('clear-cancel-btn').addEventListener('click', () => closeClearConfirm(true));
  document.getElementById('clear-confirm-btn').addEventListener('click', confirmClearLogs);
  document.getElementById('clear-confirm').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeClearConfirm(true);
    }
  });
}

// Refresh, saying what it is doing while it does it.
async function refreshLog() {
  const button = document.getElementById('refresh-btn');
  if (!button || button.getAttribute('aria-busy') === 'true') return;
  announce('');
  setBusy(button, 'Refreshing…');
  const ok = await loadAuditData();
  renderCurrentView();
  clearBusy(button, 'Refresh');
  if (ok) announce(MESSAGES.refreshed);
}

function openClearConfirm() {
  const button = document.getElementById('clear-logs-btn');
  const confirmGroup = document.getElementById('clear-confirm');
  if (!button || !confirmGroup) return;
  button.hidden = true;
  confirmGroup.hidden = false;
  const cancel = document.getElementById('clear-cancel-btn');
  if (cancel) cancel.focus();
}

function closeClearConfirm(returnFocus) {
  const button = document.getElementById('clear-logs-btn');
  const confirmGroup = document.getElementById('clear-confirm');
  if (confirmGroup) confirmGroup.hidden = true;
  if (button) {
    button.hidden = false;
    if (returnFocus) button.focus();
  }
}

async function confirmClearLogs() {
  const button = document.getElementById('clear-confirm-btn');
  if (!button || button.getAttribute('aria-busy') === 'true') return;
  announce('');
  showError('');

  // Under a Pact, clearing the log waits like any other loosening: this log
  // is where a quiet change would show.
  const Pact = self.Pact;
  const pact = Pact ? await Pact.readPact(browserAPI.storage.local) : null;
  if (Pact && Pact.isActive(pact)) {
    setBusy(button, 'Starting the wait…');
    const reply = await Pact.ask({
      type: 'pact_enqueue',
      change: { kind: 'audit-clear', label: 'clear the activity log', payload: {} }
    });
    clearBusy(button, 'Clear logs');
    closeClearConfirm(true);
    if (reply && reply.ok) {
      const now = Date.now();
      announce(`Clearing waits for your pact. It happens around ${Pact.formatWhen(now + (reply.remainingMs || 0), now)}. You can cancel it in Settings.`);
    } else {
      showError('Clearing couldn’t start. Try again.');
    }
    return;
  }

  setBusy(button, 'Clearing…');
  const ok = await clearAllLogs();
  clearBusy(button, 'Clear logs');
  if (ok) {
    closeClearConfirm(true);
    announce(MESSAGES.cleared);
  }
}

// Switch tabs
function switchTab(tabName) {
  currentTab = tabName;
  currentPage = 1;

  // Update tab buttons
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    const selected = tab.dataset.tab === tabName;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  });

  // Update panels
  document.querySelectorAll('[role="tabpanel"]').forEach(panel => {
    panel.hidden = panel.id !== `${tabName}-section`;
  });

  renderCurrentView();
}

function onTabKeydown(e) {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const index = tabs.indexOf(e.currentTarget);
  if (index < 0) return;
  let next = -1;
  if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  if (next < 0) return;
  e.preventDefault();
  tabs[next].focus();
  switchTab(tabs[next].dataset.tab);
}

// Get filtered and sorted events
function getFilteredEvents(eventType = 'all') {
  let events = [];

  // Combine events based on type
  if (eventType === 'all') {
    events = [
      ...blockedEvents.map(e => ({ ...e, type: 'blocked' })),
      ...disabledEvents.map(e => ({ ...e, type: 'disabled' }))
    ];
  } else if (eventType === 'blocked') {
    events = blockedEvents.map(e => ({ ...e, type: 'blocked' }));
  } else if (eventType === 'disabled') {
    events = disabledEvents.map(e => ({ ...e, type: 'disabled' }));
  }

  // Apply search filter. It still matches the stored address, reason and
  // method, and also the words a row shows, so what is on screen can be found.
  if (filters.search) {
    events = events.filter(event => {
      const searchStr = filters.search;
      return (
        event.url?.toLowerCase().includes(searchStr) ||
        event.reason?.toLowerCase().includes(searchStr) ||
        event.method?.toLowerCase().includes(searchStr) ||
        event.type?.toLowerCase().includes(searchStr) ||
        shownWords(event).toLowerCase().includes(searchStr)
      );
    });
  }

  // Apply date filters
  if (filters.dateFrom) {
    events = events.filter(event => event.timestamp >= filters.dateFrom);
  }
  if (filters.dateTo) {
    events = events.filter(event => event.timestamp <= filters.dateTo);
  }

  // Sort
  events.sort((a, b) => {
    if (filters.sortOrder === 'newest') {
      return b.timestamp - a.timestamp;
    } else {
      return a.timestamp - b.timestamp;
    }
  });

  return events;
}

function filtersActive() {
  return !!(filters.search || filters.dateFrom || filters.dateTo);
}

// Render current view
function renderCurrentView() {
  const events = getFilteredEvents(currentTab);
  const listId = `${currentTab}-list`;
  const paginationId = `${currentTab}-pagination`;

  renderEventList(events, listId, paginationId);
}

// Render event list with pagination
function renderEventList(events, listId, paginationId) {
  const listElement = document.getElementById(listId);
  const paginationElement = document.getElementById(paginationId);

  // Calculate pagination. A page past the end (the log can shrink under a
  // storage update or a clear) falls back to the last page there is.
  const totalPages = Math.ceil(events.length / ITEMS_PER_PAGE);
  if (currentPage > Math.max(1, totalPages)) currentPage = Math.max(1, totalPages);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const pageEvents = events.slice(startIndex, endIndex);

  // Render list
  if (pageEvents.length === 0) {
    let text = MESSAGES.emptyAll;
    if (loadFailed) text = MESSAGES.listFailed;
    else if (filtersActive()) text = MESSAGES.emptyFiltered;
    listElement.replaceChildren(make('p', 'domain-empty', text));
  } else {
    const list = make('ol', 'events');
    pageEvents.forEach(event => {
      const item = renderEventItem(event);
      if (item) list.appendChild(item);
    });
    listElement.replaceChildren(list);
  }
  listElement.removeAttribute('aria-busy');

  // Render pagination
  renderPagination(paginationElement, currentPage, totalPages, events.length);
}

// --- Rows -----------------------------------------------------------------
//
// Built node by node and filled with textContent: the hostname and the
// reason came from pages, so none of it is ever parsed as markup.

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// The hostname of a blocked page and nothing else: no scheme, path, query or
// fragment, and no leading "www.". The stored address can say what the page
// was; the hostname is all the log shows. Export keeps the full address.
function displayHost(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = String(url || '').trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[\/?#]/)[0]
      .replace(/^[^@]*@/, '')
      .replace(/:\d*$/, '');
  }
  return host.replace(/^www\./i, '');
}

// Why a page was held, in the words the blocked page uses. The stored reason
// is not shown as written: several carry the page's own title or the explicit
// words it matched (see content.js), and neither belongs on screen. Anything
// not recognised here reads as "Protection rules".
const REASON_LABELS = {
  // getBlockedReasonLabel() in content.js
  'blocked by dns filter': 'DNS protection',
  'blocked by custom blocklist': 'Your blocklist',
  'blocked by built-in blocklist': 'Built-in blocklist',
  'blocked by smart keyword filter': 'Keyword filter',
  'blocked by metadata scan': 'Page details',
  'blocked by page text scan': 'Page text',
  'blocked by ai text classifier': 'On-device AI',
  'blocked explicit search query': 'Search filter',
  'reddit nsfw subreddit': 'NSFW community filter',
  'adult content detected': 'Protection rules',
  // The fixed reasons background.js records
  'pattern match': 'Pattern match',
  'image filtered': 'Image filtered',
  'ai image filtered': 'Image filtered by on-device AI',
  'search results filtered': 'Search results filtered',
  'video filtered': 'Video filtered',
  'embedded frame filtered': 'Embedded frame filtered',
  'social posts filtered': 'Social posts filtered',
  // Reason codes, and the event type stored when no reason was given
  dns_blocked: 'DNS protection',
  custom_blocklist: 'Your blocklist',
  default_blocklist: 'Built-in blocklist',
  instant_host_match: 'Built-in blocklist',
  smart_filter: 'Keyword filter',
  instant_keyword_match: 'Keyword filter',
  search_query: 'Search filter',
  reddit_nsfw: 'NSFW community filter',
  metadata_scan: 'Page details',
  page_text_scan: 'Page text',
  ai_text_scan: 'On-device AI',
  custom_title_pattern: 'Your title patterns',
  blocked: 'Local filter rules',
  content: 'Local filter rules',
  local_filter: 'Local filter rules',
  website_blocked: 'Protection rules',
  image_filtered: 'Image filtered',
  image_ai_filtered: 'Image filtered by on-device AI',
  search_result_filtered: 'Search results filtered',
  video_filtered: 'Video filtered',
  iframe_filtered: 'Embedded frame filtered',
  social_post_filtered: 'Social posts filtered'
};

// Reasons that open with fixed words and then quote the page.
const REASON_PREFIXES = [
  ['page title matched one of your blocked-site patterns', 'Your title patterns'],
  ['page metadata contained explicit content', 'Page details'],
  ['page body contained repeated explicit content signals', 'Page text'],
  ['ai text+image classifier flagged', 'On-device AI'],
  ['ai text classifier flagged', 'On-device AI']
];

function reasonLabel(reason) {
  const key = String(reason || '').trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(REASON_LABELS, key)) return REASON_LABELS[key];
  for (const [prefix, label] of REASON_PREFIXES) {
    if (key.startsWith(prefix)) return label;
  }
  return 'Protection rules';
}

function switchTitle(event) {
  return event.enabled ? 'Protection turned on' : 'Protection turned off';
}

function durationText(event) {
  if (event.duration) return formatDuration(event.duration);
  if (event.endTimestamp) return formatDuration(event.endTimestamp - event.timestamp);
  return '';
}

// The words a row puts on screen, for search.
function shownWords(event) {
  if (event.type === 'blocked') return `${displayHost(event.url)} ${reasonLabel(event.reason)} held`;
  if (event.type === 'disabled') return switchTitle(event);
  return '';
}

function heldMark() {
  const mark = make('span', 'held event-held');
  const icons = globalThis.UiIcons;
  if (icons && typeof icons.create === 'function') {
    try { mark.appendChild(icons.create('held', { size: 12 })); } catch (_) {}
  }
  mark.appendChild(make('span', 'held-word', 'held'));
  return mark;
}

function timeElement(timestamp, text) {
  const el = make('time', 'event-time mono tnum', text);
  try { el.setAttribute('datetime', new Date(timestamp).toISOString()); } catch (_) {}
  return el;
}

// Render individual event item
function renderEventItem(event) {
  const date = new Date(event.timestamp);
  const formattedDate = formatDateTime(date);

  const row = make('li', 'domain-row event');
  const main = make('div', 'domain-main event-main');
  const side = make('div', 'event-side');

  if (event.type === 'blocked') {
    const host = displayHost(event.url);
    const name = make('span', 'domain', host || 'Unknown site');
    if (host) name.title = host;
    main.appendChild(name);
    main.appendChild(make('span', 'domain-meta', reasonLabel(event.reason)));
    side.appendChild(heldMark());
  } else if (event.type === 'disabled') {
    main.appendChild(make('span', 'event-title', switchTitle(event)));

    // How it was switched, and for how long it was off, when that is known.
    const duration = durationText(event);
    if (event.method || duration) {
      const detail = make('span', 'domain-meta');
      if (event.method) detail.appendChild(document.createTextNode(String(event.method)));
      if (duration) {
        if (event.method) detail.appendChild(document.createTextNode(' · '));
        detail.appendChild(document.createTextNode(event.enabled ? 'Off for ' : 'Lasted '));
        detail.appendChild(make('span', 'mono tnum', duration));
      }
      main.appendChild(detail);
    }
  } else {
    return null;
  }

  side.appendChild(timeElement(event.timestamp, formattedDate));
  row.appendChild(main);
  row.appendChild(side);
  return row;
}

// Render pagination controls
function renderPagination(paginationElement, page, totalPages, totalItems) {
  if (!paginationElement) return;
  if (totalPages <= 1) {
    paginationElement.innerHTML = '';
    paginationElement.hidden = true;
    return;
  }
  paginationElement.hidden = false;

  const startItem = (page - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(page * ITEMS_PER_PAGE, totalItems);

  // Page numbers
  const maxPageButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxPageButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxPageButtons - 1);

  if (endPage - startPage < maxPageButtons - 1) {
    startPage = Math.max(1, endPage - maxPageButtons + 1);
  }

  // The first and last pages stay one press away, as the old first and last
  // buttons kept them.
  const gap = '<span class="page-gap" aria-hidden="true">…</span>';
  let numbers = '';
  if (startPage > 1) {
    numbers += pageButton(1, page);
    if (startPage > 2) numbers += gap;
  }
  for (let i = startPage; i <= endPage; i++) {
    numbers += pageButton(i, page);
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) numbers += gap;
    numbers += pageButton(totalPages, page);
  }

  // NOTE: pagination buttons carry their target page in `data-page` and are
  // handled by a delegated listener (see setupEventListeners). Inline
  // `onclick=` handlers are blocked by the MV3 extension-page CSP
  // (script-src 'self'), which silently made every page button a no-op.
  // Only numbers this function computed go into this markup.
  paginationElement.innerHTML =
    `<p class="page-info mono tnum">${formatCount(startItem)}–${formatCount(endItem)} of ${formatCount(totalItems)}</p>` +
    '<div class="page-controls">' +
      `<button type="button" class="page-button page-step" data-page="${page - 1}"${page === 1 ? ' disabled' : ''}>Previous</button>` +
      numbers +
      `<button type="button" class="page-button page-step" data-page="${page + 1}"${page === totalPages ? ' disabled' : ''}>Next</button>` +
    '</div>';
}

// One page-number button; the current page says so with aria-current.
function pageButton(number, current) {
  if (number === current) {
    return `<button class="page-button active" data-page="${number}" type="button" aria-current="page" aria-label="Page ${number}">${number}</button>`;
  }
  return `<button class="page-button" data-page="${number}" type="button" aria-label="Page ${number}">${number}</button>`;
}

// Change page. Clamped to the current result set so a stale button (the list
// can shrink under a filter or a storage update between render and click) can
// never land on an empty page.
function changePage(page) {
  const total = Math.max(1, Math.ceil(getFilteredEvents(currentTab).length / ITEMS_PER_PAGE));
  const target = Math.min(Math.max(1, page), total);
  if (target === currentPage) return;
  currentPage = target;
  renderCurrentView();
  revealCurrentList();
}

// After a page change, bring the top of the list into view and put focus on
// it, so the new rows are what is read next.
function revealCurrentList() {
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
  const panel = document.getElementById(`${currentTab}-section`);
  if (panel && typeof panel.focus === 'function') {
    try { panel.focus({ preventScroll: true }); } catch (_) {}
  }
  const tabs = document.getElementById('event-tabs');
  if (tabs && typeof tabs.scrollIntoView === 'function') {
    tabs.scrollIntoView({ block: 'start', behavior });
  } else if (typeof window.scrollTo === 'function') {
    window.scrollTo({ top: 0, behavior });
  }
}

function prefersReducedMotion() {
  try {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

// Export to CSV
function exportToCSV() {
  const events = getFilteredEvents('all');

  if (events.length === 0) {
    announce('');
    showError(blockedEvents.length + disabledEvents.length === 0
      ? MESSAGES.nothingToExport
      : MESSAGES.nothingMatchesExport);
    return;
  }

  // CSV header
  let csv = 'Type,Timestamp,Date,URL/Event,Reason/Method,Duration\n';

  // CSV rows
  events.forEach(event => {
    const date = new Date(event.timestamp);
    const formattedDate = formatDateTime(date);
    const type = event.type === 'blocked' ? 'Blocked Page' : 'Extension State';
    const urlOrEvent = event.url || (event.enabled ? 'Extension Enabled' : 'Extension Disabled');
    const reasonOrMethod = event.reason || event.method || '';
    const duration = event.duration
      ? formatDuration(event.duration)
      : event.endTimestamp
        ? formatDuration(event.endTimestamp - event.timestamp)
        : '';

    csv += `"${type}","${event.timestamp}","${formattedDate}","${escapeCSV(urlOrEvent)}","${escapeCSV(reasonOrMethod)}","${duration}"\n`;
  });

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  const filename = `pblocker-audit-${new Date().toISOString().split('T')[0]}.csv`;

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showError('');
  announce([
    'Exported ',
    make('span', 'mono tnum', formatCount(events.length)),
    events.length === 1 ? ' event.' : ' events.'
  ]);
}

// Clear all logs. Storage is cleared first, so a failed write leaves the page
// showing what is still kept.
async function clearAllLogs() {
  try {
    await browserAPI.storage.local.set({
      [AUDIT_BLOCKED_KEY]: [],
      [AUDIT_DISABLED_KEY]: []
    });

    blockedEvents = [];
    disabledEvents = [];

    updateStatistics();
    renderCurrentView();
    return true;
  } catch (error) {
    console.error('Error clearing logs:', error);
    showError(MESSAGES.clearFailed);
    return false;
  }
}

// Format date and time
function formatDateTime(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

// Format duration
function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatCount(value) {
  const n = Number(value) || 0;
  try { return n.toLocaleString(); } catch (_) { return String(n); }
}

// Escape CSV
function escapeCSV(text) {
  return String(text || '').replace(/"/g, '""');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBusy(button, label) {
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
}

function clearBusy(button, label) {
  button.removeAttribute('aria-busy');
  button.textContent = label;
}

// --- Notices ----------------------------------------------------------------
//
// One line for what went right (role="status") and one for what went wrong
// (role="alert"). The words go in a moment after the line is emptied, so the
// same message said twice is read out twice.

const noticeTimers = {};

function setNotice(id, content) {
  const el = document.getElementById(id);
  if (!el) return;
  clearTimeout(noticeTimers[id]);
  el.replaceChildren();
  const parts = (Array.isArray(content) ? content : [content]).filter(part => part);
  if (parts.length === 0) return;
  noticeTimers[id] = setTimeout(() => {
    el.replaceChildren(...parts.map(part => (
      typeof part === 'string' ? document.createTextNode(part) : part
    )));
  }, 30);
}

function announce(content) {
  setNotice('audit-status', content);
}

// Show error message
function showError(message) {
  setNotice('audit-alert', message);
}

// Listen for storage changes (real-time updates)
browserAPI.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && (changes[AUDIT_BLOCKED_KEY] || changes[AUDIT_DISABLED_KEY])) {
    await loadAuditData();
    renderCurrentView();
  }
});
