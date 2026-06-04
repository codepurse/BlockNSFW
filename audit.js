/* BlockNSFW audit log */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Storage keys
const AUDIT_BLOCKED_KEY = 'pblocker_audit_blocked';
const AUDIT_DISABLED_KEY = 'pblocker_audit_disabled';
const AUDIT_RETENTION_DAYS = 30;
const ITEMS_PER_PAGE = 20;

// State
let blockedEvents = [];
let disabledEvents = [];
let currentTab = 'all';
let currentPage = 1;
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
  } catch (error) {
    console.error('Error loading audit data:', error);
    showError('Failed to load audit data');
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

// Update statistics display
function updateStatistics() {
  document.getElementById('stat-blocked-pages').textContent = blockedEvents.length;
  document.getElementById('stat-disable-events').textContent = disabledEvents.length;
  document.getElementById('stat-total-events').textContent = blockedEvents.length + disabledEvents.length;
}

// Setup event listeners
function setupEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
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
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await loadAuditData();
    renderCurrentView();
  });

  // Export CSV
  document.getElementById('export-csv-btn').addEventListener('click', () => {
    exportToCSV();
  });

  // Clear logs
  document.getElementById('clear-logs-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all audit logs? This action cannot be undone.')) {
      clearAllLogs();
    }
  });
}

// Switch tabs
function switchTab(tabName) {
  currentTab = tabName;
  currentPage = 1;

  // Update tab buttons
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Update sections
  document.querySelectorAll('.section').forEach(section => {
    section.classList.remove('active');
  });
  document.getElementById(`${tabName}-section`).classList.add('active');

  renderCurrentView();
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

  // Apply search filter
  if (filters.search) {
    events = events.filter(event => {
      const searchStr = filters.search;
      return (
        event.url?.toLowerCase().includes(searchStr) ||
        event.reason?.toLowerCase().includes(searchStr) ||
        event.method?.toLowerCase().includes(searchStr) ||
        event.type?.toLowerCase().includes(searchStr)
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

  // Calculate pagination
  const totalPages = Math.ceil(events.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const pageEvents = events.slice(startIndex, endIndex);

  // Render list
  if (pageEvents.length === 0) {
    listElement.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No events found</div>
        <div class="empty-state-subtext">
          ${filters.search || filters.dateFrom || filters.dateTo 
            ? 'Try adjusting your filters' 
            : 'Events will appear here as they occur'}
        </div>
      </div>
    `;
  } else {
    listElement.innerHTML = pageEvents.map(event => renderEventItem(event)).join('');
  }

  // Render pagination
  renderPagination(paginationElement, currentPage, totalPages, events.length);
}

// Render individual event item
function renderEventItem(event) {
  const date = new Date(event.timestamp);
  const formattedDate = formatDateTime(date);

  if (event.type === 'blocked') {
    return `
      <div class="audit-item">
        <div class="audit-item-header">
          <div class="audit-item-url">${escapeHtml(event.url)}</div>
          <div class="audit-item-time">${formattedDate}</div>
        </div>
        <div class="audit-item-details">
          <span class="audit-badge badge-blocked">🚫 Blocked</span>
          ${event.reason ? `<span class="audit-badge" style="background: rgba(99, 102, 241, 0.1); color: var(--primary); border: 1px solid rgba(99, 102, 241, 0.2);">
            ${escapeHtml(event.reason)}
          </span>` : ''}
        </div>
      </div>
    `;
  } else if (event.type === 'disabled') {
    const durationText = event.duration 
      ? formatDuration(event.duration)
      : event.endTimestamp 
        ? formatDuration(event.endTimestamp - event.timestamp)
        : 'Ongoing';

    return `
      <div class="audit-item">
        <div class="audit-item-header">
          <div class="audit-item-url" style="color: var(--foreground);">
            Extension ${event.enabled ? 'Enabled' : 'Disabled'}
          </div>
          <div class="audit-item-time">${formattedDate}</div>
        </div>
        <div class="audit-item-details">
          <span class="audit-badge ${event.enabled ? 'badge-enabled' : 'badge-disabled'}">
            ${event.enabled ? '✅ Enabled' : '⏸️ Disabled'}
          </span>
          ${event.method ? `<span class="audit-badge" style="background: rgba(99, 102, 241, 0.1); color: var(--primary); border: 1px solid rgba(99, 102, 241, 0.2);">
            ${escapeHtml(event.method)}
          </span>` : ''}
          ${event.duration || event.endTimestamp ? `<span class="audit-badge" style="background: rgba(245, 158, 11, 0.1); color: #d97706; border: 1px solid rgba(245, 158, 11, 0.2);">
            Duration: ${durationText}
          </span>` : ''}
        </div>
      </div>
    `;
  }

  return '';
}

// Render pagination controls
function renderPagination(paginationElement, page, totalPages, totalItems) {
  if (totalPages <= 1) {
    paginationElement.innerHTML = '';
    return;
  }

  const startItem = (page - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(page * ITEMS_PER_PAGE, totalItems);

  let html = `
    <button class="page-button" ${page === 1 ? 'disabled' : ''} onclick="changePage(1)">⏮️</button>
    <button class="page-button" ${page === 1 ? 'disabled' : ''} onclick="changePage(${page - 1})">◀️</button>
    <span class="page-info">
      ${startItem}-${endItem} of ${totalItems}
    </span>
  `;

  // Page numbers
  const maxPageButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxPageButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxPageButtons - 1);

  if (endPage - startPage < maxPageButtons - 1) {
    startPage = Math.max(1, endPage - maxPageButtons + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `
      <button class="page-button ${i === page ? 'active' : ''}" onclick="changePage(${i})">
        ${i}
      </button>
    `;
  }

  html += `
    <button class="page-button" ${page === totalPages ? 'disabled' : ''} onclick="changePage(${page + 1})">▶️</button>
    <button class="page-button" ${page === totalPages ? 'disabled' : ''} onclick="changePage(${totalPages})">⏭️</button>
  `;

  paginationElement.innerHTML = html;
}

// Change page
function changePage(page) {
  currentPage = page;
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Export to CSV
function exportToCSV() {
  const events = getFilteredEvents('all');

  if (events.length === 0) {
    alert('No events to export');
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
}

// Clear all logs
async function clearAllLogs() {
  try {
    blockedEvents = [];
    disabledEvents = [];

    await browserAPI.storage.local.set({
      [AUDIT_BLOCKED_KEY]: [],
      [AUDIT_DISABLED_KEY]: []
    });

    updateStatistics();
    renderCurrentView();
  } catch (error) {
    console.error('Error clearing logs:', error);
    showError('Failed to clear logs');
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

// Escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}

// Escape CSV
function escapeCSV(text) {
  return String(text || '').replace(/"/g, '""');
}

// Show error message
function showError(message) {
  alert(message);
}

// Listen for storage changes (real-time updates)
browserAPI.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && (changes[AUDIT_BLOCKED_KEY] || changes[AUDIT_DISABLED_KEY])) {
    await loadAuditData();
    renderCurrentView();
  }
});

