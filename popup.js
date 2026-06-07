const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const DAILY_STATS_KEY = 'pblocker_daily_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const PIN_KEY = 'pblocker_pin';
const TEMP_DISABLE_UNTIL_KEY = 'pblocker_temp_disable_until';
const STREAK_START_KEY = 'pblocker_streak_start';

function $(id) { return document.getElementById(id); }

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await browserAPI.storage.local.get(SETTINGS_KEY);
  return settings || { enabled: true, useSmartBlocking: true, customPatterns: [], safeSearchEnabled: true };
}

async function setSettings(newSettings) {
  await browserAPI.storage.local.set({ [SETTINGS_KEY]: newSettings });
}

async function getStats() {
  const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
  return stats || { blockedCount: 0, lastBlocked: null };
}

async function getDailyStats() {
  const { [DAILY_STATS_KEY]: dailyStats } = await browserAPI.storage.local.get(DAILY_STATS_KEY);
  const today = new Date().toDateString();
  
  if (!dailyStats || dailyStats.date !== today) {
    return { date: today, blockedToday: 0, websiteBlocked: 0, imageBlocked: 0, searchResultBlocked: 0 };
  }
  
  return dailyStats;
}

async function updateDailyStats(updates) {
  const dailyStats = await getDailyStats();
  const newStats = { ...dailyStats, ...updates };
  await browserAPI.storage.local.set({ [DAILY_STATS_KEY]: newStats });
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: whitelist } = await browserAPI.storage.local.get(WHITELIST_KEY);
  return whitelist || [];
}

async function setWhitelist(whitelist) {
  await browserAPI.storage.local.set({ [WHITELIST_KEY]: whitelist });
}

async function addToWhitelist(domain, type = 'permanent', expiresMs = null) {
  const whitelist = await getWhitelist();
  const existingIndex = whitelist.findIndex(item => item.domain === domain);
  
  const entry = {
    domain: domain,
    type: type,
    addedAt: Date.now(),
    // If temporary, use provided duration or default to 1 hour
    expiresAt: type === 'temporary' ? Date.now() + (expiresMs || (60 * 60 * 1000)) : null
  };
  
  if (existingIndex >= 0) {
    whitelist[existingIndex] = entry; // Update existing
  } else {
    whitelist.push(entry); // Add new
  }
  
  await setWhitelist(whitelist);
}

async function removeFromWhitelist(domain) {
  const whitelist = await getWhitelist();
  const filtered = whitelist.filter(item => item.domain !== domain);
  await setWhitelist(filtered);
}

async function cleanExpiredWhitelist() {
  const whitelist = await getWhitelist();
  const now = Date.now();
  const cleaned = whitelist.filter(item => 
    item.type === 'permanent' || (item.expiresAt && item.expiresAt > now)
  );
  
  if (cleaned.length !== whitelist.length) {
    await setWhitelist(cleaned);
  }
  
  return cleaned;
}

// PIN helpers
async function getPIN() {
  const { [PIN_KEY]: pin } = await browserAPI.storage.local.get(PIN_KEY);
  return pin || null;
}

async function setPIN(pin) {
  await browserAPI.storage.local.set({ [PIN_KEY]: pin });
}

async function ensurePIN() {
  const current = await getPIN();
  if (current) return true;
  const newPin = await showSetPinModal();
  if (!newPin) return false;
  await setPIN(newPin);
  return true;
}

async function requirePIN(actionLabel = 'this action') {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  const stored = await getPIN();
  let attempt = 0;
  while (attempt < 3) {
    const entered = await showPinModal(`Enter PIN to ${actionLabel}`);
    if (entered === null) return false; // Cancelled
    if (entered === stored) return true;
    attempt++;
    await showPinModal('Incorrect PIN. Try again.', { errorOnly: true });
  }
  return false;
}

// Only require PIN if one is already set (doesn't prompt to create one)
async function requirePINIfSet(actionLabel = 'this action') {
  const stored = await getPIN();
  if (!stored) return true; // No PIN set, allow action
  let attempt = 0;
  while (attempt < 3) {
    const entered = await showPinModal(`Enter PIN to ${actionLabel}`);
    if (entered === null) return false;
    if (entered === stored) return true;
    attempt++;
    await showPinModal('Incorrect PIN. Try again.', { errorOnly: true });
  }
  return false;
}

// Modal UI for PIN
function getPinElements() {
  return {
    overlay: $('pin-modal-overlay'),
    title: $('pin-modal-title'),
    desc: $('pin-modal-desc'),
    field: $('pin-field'),
    input: $('pin-input'),
    confirmField: $('pin-confirm-field'),
    confirmInput: $('pin-input-confirm'),
    toggle: $('pin-toggle'),
    error: $('pin-error'),
    ok: $('pin-ok'),
    cancel: $('pin-cancel')
  };
}

function showOverlay() {
  const { overlay } = getPinElements();
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideOverlay() {
  const { overlay } = getPinElements();
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function setupPinToggle() {
  const { toggle, input } = getPinElements();
  if (!toggle || !input) return;
  toggle.onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  };
}

async function showPinModal(description, options = {}) {
  const el = getPinElements();
  if (!el.overlay) return prompt(description || 'Enter PIN');
  el.title.textContent = 'Enter PIN';
  el.desc.textContent = description || 'Enter PIN to continue.';
  el.error.textContent = options.errorOnly ? description : '';
  el.confirmField.classList.add('hidden');
  el.input.value = '';
  showOverlay();
  setupPinToggle();
  el.input.focus();
  return new Promise(resolve => {
    const cleanup = () => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.input.onkeydown = null;
      hideOverlay();
    };
    el.ok.onclick = () => {
      const val = el.input.value.trim();
      if (val.length < 4) {
        el.error.textContent = 'PIN must be at least 4 digits.';
        return;
      }
      cleanup();
      resolve(val);
    };
    el.cancel.onclick = () => { cleanup(); resolve(null); };
    el.input.onkeydown = (e) => {
      if (e.key === 'Enter') el.ok.click();
      if (e.key === 'Escape') el.cancel.click();
    };
  });
}

async function showSetPinModal() {
  const el = getPinElements();
  if (!el.overlay) {
    const newPin = prompt('Set a new PIN (min 4 digits):');
    if (!newPin || newPin.trim().length < 4) return null;
    return newPin.trim();
  }
  el.title.textContent = 'Set PIN';
  el.desc.textContent = 'Create a PIN to protect sensitive actions.';
  el.error.textContent = '';
  el.input.value = '';
  el.confirmInput.value = '';
  el.confirmField.classList.remove('hidden');
  showOverlay();
  setupPinToggle();
  el.input.focus();
  return new Promise(resolve => {
    const cleanup = () => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.input.onkeydown = null;
      el.confirmInput.onkeydown = null;
      hideOverlay();
      el.confirmField.classList.add('hidden');
    };
    el.ok.onclick = () => {
      const a = el.input.value.trim();
      const b = el.confirmInput.value.trim();
      if (a.length < 4) { el.error.textContent = 'PIN must be at least 4 digits.'; return; }
      if (a !== b) { el.error.textContent = 'PINs do not match.'; return; }
      cleanup();
      resolve(a);
    };
    el.cancel.onclick = () => { cleanup(); resolve(null); };
    const handleEnter = (e) => { if (e.key === 'Enter') el.ok.click(); if (e.key === 'Escape') el.cancel.click(); };
    el.input.onkeydown = handleEnter;
    el.confirmInput.onkeydown = handleEnter;
  });
}

// Duration modal helpers
function getDurationElements() {
  return {
    overlay: $('duration-modal-overlay'),
    title: $('duration-modal-title'),
    desc: $('duration-modal-desc'),
    chips: $('duration-chips'),
    input: $('duration-input'),
    error: $('duration-error'),
    ok: $('duration-ok'),
    cancel: $('duration-cancel')
  };
}

async function showDurationModal(options = {}) {
  const el = getDurationElements();
  if (!el.overlay) {
    // Fallback to prompt if modal not present
    const msg = options.description || 'Enter minutes for temporary disable. Leave blank for permanent.';
    const choice = prompt(msg);
    if (choice === null) return null; // cancelled
    const trimmed = choice.trim();
    if (!trimmed) return { minutes: null }; // permanent
    const mins = parseInt(trimmed, 10);
    if (isNaN(mins) || mins <= 0) return null; // invalid treated as cancel
    return { minutes: mins };
  }
  const title = options.title || 'Choose Duration';
  const description = options.description || 'Select a duration or choose Permanent.';
  el.title.textContent = title;
  el.desc.textContent = description;
  el.error.textContent = '';
  el.input.value = '';
  // Clear chip selection
  [...el.chips.querySelectorAll('.chip')].forEach(c => c.classList.remove('selected'));
  // Show overlay
  el.overlay.classList.remove('hidden');
  el.overlay.setAttribute('aria-hidden', 'false');
  el.input.focus();

  return new Promise(resolve => {
    let selectedMinutes = undefined; // undefined = none, null = permanent, number = minutes
    const cleanup = () => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.input.onkeydown = null;
      el.chips.onclick = null;
      el.overlay.classList.add('hidden');
      el.overlay.setAttribute('aria-hidden', 'true');
    };
    el.chips.onclick = (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      // Toggle selected state
      [...el.chips.querySelectorAll('.chip')].forEach(c => c.classList.remove('selected'));
      btn.classList.add('selected');
      const minsAttr = btn.getAttribute('data-mins');
      const permAttr = btn.getAttribute('data-permanent');
      if (permAttr) {
        selectedMinutes = null; // permanent
      } else if (minsAttr) {
        selectedMinutes = parseInt(minsAttr, 10);
      }
    };
    el.ok.onclick = () => {
      // If chip selected, use it
      if (selectedMinutes === null) { cleanup(); resolve({ minutes: null }); return; }
      if (typeof selectedMinutes === 'number' && selectedMinutes > 0) { cleanup(); resolve({ minutes: selectedMinutes }); return; }
      // Otherwise, check input
      const val = el.input.value.trim();
      if (!val) { // permanent
        cleanup();
        resolve({ minutes: null });
        return;
      }
      const mins = parseInt(val, 10);
      if (isNaN(mins) || mins <= 0) {
        el.error.textContent = 'Enter a positive number of minutes or choose a chip.';
        return;
      }
      cleanup();
      resolve({ minutes: mins });
    };
    el.cancel.onclick = () => { cleanup(); resolve(null); };
    el.input.onkeydown = (e) => {
      if (e.key === 'Enter') el.ok.click();
      if (e.key === 'Escape') el.cancel.click();
    };
  });
}

async function getCurrentTabDomain() {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      return url.hostname.replace(/^www\./, '');
    }
  } catch (error) {
    console.error('Error getting current tab:', error);
  }
  return null;
}

async function isCurrentSiteWhitelisted() {
  const domain = await getCurrentTabDomain();
  if (!domain) return false;
  
  const whitelist = await getWhitelist();
  return whitelist.some(item => item.domain === domain);
}

async function resetStats() {
  await browserAPI.storage.local.set({
    [BLOCKED_STATS_KEY]: { blockedCount: 0, lastBlocked: null },
    [DAILY_STATS_KEY]: { date: new Date().toDateString(), blockedToday: 0, websiteBlocked: 0, imageBlocked: 0, searchResultBlocked: 0 }
  });
  
  await updateUI();
}

async function updateWhitelistDisplay() {
  const whitelist = await cleanExpiredWhitelist();
  const listContainer = $('whitelist-list');
  
  if (whitelist.length === 0) {
    listContainer.innerHTML = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'whitelist-empty';
    emptyDiv.textContent = 'No whitelisted sites';
    listContainer.appendChild(emptyDiv);
    return;
  }
  
  listContainer.innerHTML = '';
  
  whitelist.forEach(item => {
    const addedDate = new Date(item.addedAt).toLocaleDateString();
    
    const itemDiv = document.createElement('div');
    itemDiv.className = 'whitelist-item';
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'whitelist-info';
    
    const domainStrong = document.createElement('strong');
    domainStrong.textContent = item.domain;
    
    const typeDiv = document.createElement('div');
    typeDiv.className = 'whitelist-type';
    typeDiv.textContent = `Added ${addedDate}`;
    
    infoDiv.appendChild(domainStrong);
    infoDiv.appendChild(typeDiv);
    
    const removeButton = document.createElement('button');
    removeButton.className = 'whitelist-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', async () => {
      await removeFromWhitelist(item.domain);
      await updateWhitelistDisplay();
    });
    
    itemDiv.appendChild(infoDiv);
    itemDiv.appendChild(removeButton);
    listContainer.appendChild(itemDiv);
  });
}

async function updateUI() {
  try {
    const settings = await getSettings();
    const stats = await getStats();
    const dailyStats = await getDailyStats();
    const { [TEMP_DISABLE_UNTIL_KEY]: tempUntil } = await browserAPI.storage.local.get(TEMP_DISABLE_UNTIL_KEY);
    
    // Update status
  const status = $('status');
    if (settings.enabled) {
      status.textContent = '🛡️ Protection Active';
      status.className = 'status enabled';
    } else {
      if (tempUntil && tempUntil > Date.now()) {
        const minsLeft = Math.max(1, Math.ceil((tempUntil - Date.now()) / 60000));
        status.textContent = `⏳ Disabled (${minsLeft}m left)`;
      } else {
        status.textContent = '⚠️ Protection Disabled';
      }
      status.className = 'status disabled';
    }
    
    // Update unblock toggle visibility and state
    const domain = await getCurrentTabDomain();
    const unblockRow = $('unblock-row');
    const unblockToggle = $('unblock-toggle');
    
    if (domain && !domain.startsWith('chrome') && !domain.startsWith('moz-extension') && !domain.startsWith('edge')) {
      unblockRow.style.display = 'flex';
      const isWhitelisted = await isCurrentSiteWhitelisted();
      unblockToggle.classList.toggle('active', isWhitelisted);
    } else {
      unblockRow.style.display = 'none';
    }
    
    // Update main toggle
    const mainToggle = $('toggle');
    mainToggle.classList.toggle('active', settings.enabled);
    
    // Update SafeSearch toggle
    const safeSearchToggle = $('safesearch-toggle');
    if (safeSearchToggle) {
      safeSearchToggle.classList.toggle('active', settings.safeSearchEnabled !== false);
    }
    
    // Update stats
    $('blocked-today').textContent = dailyStats.blockedToday || 0;
    $('blocked-total').textContent = stats.blockedCount || 0;
    $('images-filtered').textContent = dailyStats.imageBlocked || 0;
    
    // Update whitelist display
    await updateWhitelistDisplay();
    
    document.body.classList.remove('loading');
  } catch (error) {
    console.error('BlockNSFW popup: Error updating UI', error);
    document.body.classList.remove('loading');
  }
}

// Streak tracking
async function initializeStreak() {
  const settings = await getSettings();
  const { [STREAK_START_KEY]: existing } = await browserAPI.storage.local.get(STREAK_START_KEY);
  if (settings.enabled && !existing) {
    await browserAPI.storage.local.set({ [STREAK_START_KEY]: Date.now() });
  }
}

async function toggleBlocking() {
  try {
    const settings = await getSettings();
    const turningOff = settings.enabled === true;
    if (turningOff) {
      // Redirect to options page for the full commitment gate flow
      const optionsUrl = browserAPI.runtime.getURL('options.html') + '?action=disable';
      browserAPI.tabs.create({ url: optionsUrl });
      window.close();
      return;
    } else {
      // Turning on always allowed
      settings.enabled = true;
      await setSettings(settings);
      await browserAPI.storage.local.remove(TEMP_DISABLE_UNTIL_KEY);
      await browserAPI.storage.local.set({ [STREAK_START_KEY]: Date.now() });
    }
    await updateUI();
  } catch (error) {
    console.error('BlockNSFW popup: Error toggling', error);
  }
}

async function toggleUnblockSite() {
  try {
    const domain = await getCurrentTabDomain();
    if (!domain) {
      alert('Cannot determine current site domain');
      return;
    }
    
    const isWhitelisted = await isCurrentSiteWhitelisted();
    
    if (isWhitelisted) {
      const ok = await requirePIN('remove whitelist');
      if (!ok) return;
      await removeFromWhitelist(domain);
    } else {
      const ok = await requirePIN('whitelist this site');
      if (!ok) return;
      // Ask for temporary duration via modal
      const result = await showDurationModal({
        title: 'Whitelist this site',
        description: 'Whitelist temporarily? Select a duration or choose Permanent.'
      });
      if (result === null) return; // cancelled
      if (result && typeof result.minutes === 'number') {
        const expiresMs = result.minutes * 60 * 1000;
        await addToWhitelist(domain, 'temporary', expiresMs);
      } else {
        await addToWhitelist(domain, 'permanent');
      }
    }
    
    await updateUI();
    await updateWhitelistDisplay();
  } catch (error) {
    console.error('BlockNSFW popup: Error toggling site unblock', error);
  }
}

function openSettings() {
  const optionsUrl = browserAPI.runtime.getURL('options.html');
  browserAPI.tabs.create({ url: optionsUrl });
  window.close();
}

function validateDomain(domain) {
  // Remove protocol and www if present
  domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  // Remove trailing slash and path
  domain = domain.split('/')[0];
  // Basic domain validation
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain) ? domain : null;
}

async function handleAddWhitelist(type) {
  const input = $('whitelist-input');
  const domain = validateDomain(input.value.trim());
  
  if (!domain) {
    alert('Please enter a valid domain (e.g., example.com)');
    return;
  }
  
  try {
    const ok = await requirePIN('add to whitelist');
    if (!ok) return;
    // Support temporary durations if requested via button
    if (type === 'temporary-15') {
      await addToWhitelist(domain, 'temporary', 15 * 60 * 1000);
    } else if (type === 'temporary-60') {
      await addToWhitelist(domain, 'temporary', 60 * 60 * 1000);
    } else {
      await addToWhitelist(domain, 'permanent');
    }
    input.value = '';
    await updateWhitelistDisplay();
  } catch (error) {
    console.error('Error adding to whitelist:', error);
    alert('Failed to add domain to whitelist');
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.add('loading');
  
  // Set up event listeners
  $('toggle').addEventListener('click', toggleBlocking);
  $('unblock-toggle').addEventListener('click', toggleUnblockSite);
  $('settings').addEventListener('click', (e) => {
    e.preventDefault();
    openSettings();
  });
  $('stats-btn').addEventListener('click', (e) => {
    e.preventDefault();
    browserAPI.runtime.openOptionsPage ? 
      browserAPI.tabs.create({ url: browserAPI.runtime.getURL('stats.html') }) :
      window.open(browserAPI.runtime.getURL('stats.html'), '_blank');
  });
  
  // Whitelist event listeners
  $('add-whitelist').addEventListener('click', () => handleAddWhitelist('permanent'));
  const btnTemp15 = $('add-whitelist-temp-15');
  const btnTemp60 = $('add-whitelist-temp-60');
  if (btnTemp15) btnTemp15.addEventListener('click', () => handleAddWhitelist('temporary-15'));
  if (btnTemp60) btnTemp60.addEventListener('click', () => handleAddWhitelist('temporary-60'));
  
  // Enter key support for whitelist input
  $('whitelist-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAddWhitelist('permanent');
    }
  });
  
  // SafeSearch toggle event listener
  const safeSearchToggle = $('safesearch-toggle');
  if (safeSearchToggle) {
    safeSearchToggle.addEventListener('click', async () => {
      try {
        const ok = await requirePIN('switch SafeSearch mode');
        if (!ok) return;
        const settings = await getSettings();
        settings.safeSearchEnabled = !settings.safeSearchEnabled;
        await setSettings(settings);
        await updateUI();
      } catch (error) {
        console.error('Error toggling SafeSearch:', error);
      }
    });
  }
  
  // Initialize streak tracking if not already started
  await initializeStreak();

  // Initial UI update
  await updateUI();
  
  // Listen for storage changes to update UI in real-time
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[BLOCKED_STATS_KEY] || changes[DAILY_STATS_KEY] || changes[WHITELIST_KEY])) {
      updateUI();
    }
  });
});

// Update stats when popup opens (in case background script updated them)
window.addEventListener('focus', updateUI);
