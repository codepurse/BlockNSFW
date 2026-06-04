const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const PIN_KEY = 'pblocker_pin';
const STREAK_START_KEY = 'pblocker_streak_start';

const DEFAULT_SETTINGS = {
  enabled: true,
  useSmartBlocking: true,
  imageFilterLevel: 'strict',
  customPatterns: [],
  customKeywordList: [],
  trustedImageDomains: [],
  debugMode: false,
  blockedPageType: 'default', // 'default', 'custom', 'plain_html'
  customBlockedPageUrl: '',
  plainBlockedPageHtml: '',
  dnsFilterEnabled: false,
  safeSearchEnabled: true,
  facebookReelsEnabled: false,
  instagramReelsEnabled: false,
};

function $(id) { return document.getElementById(id); }

function normalizeImageFilterLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'moderate' || value === 'lenient') return value;
  return 'strict';
}

function getImageFilterLevelMeta(level) {
  const normalized = normalizeImageFilterLevel(level);
  if (normalized === 'lenient') {
    return {
      label: 'Lenient',
      detail: 'Blocks only clearly explicit image content and known adult hosts.'
    };
  }
  if (normalized === 'moderate') {
    return {
      label: 'Moderate',
      detail: 'Balanced filtering that reduces false positives while catching obvious adult content.'
    };
  }
  return {
    label: 'Strict',
    detail: 'Most aggressive filtering. Best protection, but may hide more borderline images.'
  };
}

function getExtensionVersion() {
  try {
    const manifest = browserAPI.runtime.getManifest();
    return manifest && typeof manifest.version === 'string' ? manifest.version : '';
  } catch (_) {
    return '';
  }
}

function stripMarkdown(text) {
  return String(text || '').replaceAll('**', '').trim();
}

function parseVersionNotes(mdText) {
  const text = String(mdText || '');
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('# Version ')) {
      if (current) sections.push(current);
      const versionPart = line.slice('# Version '.length).trim();
      const version = versionPart.split(' - ')[0].trim();
      current = { version, title: stripMarkdown(line.replace(/^#\s+/, '')), lines: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }

  if (!current) {
    const fallbackLines = lines.filter((line) => line.trim().length > 0);
    if (fallbackLines.length > 0) {
      sections.push({
        version: '',
        title: 'What\'s New',
        lines: fallbackLines,
      });
    }
    return sections;
  }

  if (current) sections.push(current);
  return sections;
}

function renderWhatsNewSection(container, section) {
  container.textContent = '';

  if (!section) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color: var(--foreground-muted); font-size: 13px;';
    empty.textContent = 'No release notes available yet.';
    container.appendChild(empty);
    return;
  }

  const title = document.createElement('div');
  title.style.cssText = 'font-weight: 600; color: var(--foreground);';
  title.textContent = section.title;
  container.appendChild(title);

  let currentList = null;
  const ensureList = () => {
    if (currentList) return currentList;
    currentList = document.createElement('ul');
    currentList.style.cssText = 'margin: 0 0 0 18px; padding: 0; color: var(--foreground-muted);';
    container.appendChild(currentList);
    return currentList;
  };

  for (const raw of section.lines) {
    const line = stripMarkdown(raw);
    if (!line) continue;
    if (line === '---') break;

    if (line.startsWith('## ') || line.startsWith('### ')) {
      currentList = null;
      const h = document.createElement('div');
      h.style.cssText = 'margin-top: 8px; font-weight: 600; color: var(--foreground);';
      h.textContent = line.replace(/^#{2,3}\s+/, '');
      container.appendChild(h);
      continue;
    }

    const bulletMatch = raw.match(/^\s*-\s+(.*)$/);
    if (bulletMatch) {
      const li = document.createElement('li');
      li.style.cssText = 'margin: 6px 0;';
      li.textContent = stripMarkdown(bulletMatch[1]);
      ensureList().appendChild(li);
      continue;
    }

    currentList = null;
    const p = document.createElement('div');
    p.style.cssText = 'color: var(--foreground-muted); font-size: 13px;';
    p.textContent = line;
    container.appendChild(p);
  }
}

async function loadWhatsNew() {
  const version = getExtensionVersion();
  const content = $('whats-new-content');
  if (!content) return;

  let notesText = '';
  try {
    const url = browserAPI.runtime.getURL('VERSION_NOTES.md');
    const resp = await fetch(url);
    if (resp.ok) {
      notesText = await resp.text();
    }
  } catch (_) {}

  const sections = parseVersionNotes(notesText);
  let selected = null;
  if (version) {
    selected = sections.find((s) => s.version === version) || null;
  }
  if (!selected) {
    selected = sections.length > 0 ? sections[0] : null;
  }

  renderWhatsNewSection(content, selected);
}

// Toast Notification System
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  
  // Style based on type
  const styles = {
    success: { background: 'var(--success-color)', color: 'white' },
    error: { background: 'var(--error-color)', color: 'white' },
    warning: { background: 'var(--warning-color)', color: 'black' },
    info: { background: 'var(--info-color)', color: 'white' }
  };
  
  Object.assign(toast.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    padding: '12px 20px',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    zIndex: '10000',
    maxWidth: '300px',
    wordWrap: 'break-word',
    animation: 'slideIn 0.3s ease-out',
    ...styles[type]
  });
  
  document.body.appendChild(toast);
  
  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3000);
}

// Modal System for PIN Management
function createModal(config) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    const content = document.createElement('div');
    content.className = 'modal-content';
    
    // Header
    const header = document.createElement('div');
    header.className = 'modal-header';
    
    const icon = document.createElement('div');
    icon.className = 'modal-icon';
    icon.textContent = config.icon || '🔒';
    
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = config.title;
    
    const description = document.createElement('p');
    description.className = 'modal-description';
    description.textContent = config.description;
    
    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(description);
    
    // Body
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = config.bodyHTML;
    
    // Footer
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    
    config.buttons.forEach(btnConfig => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `modal-button modal-button-${btnConfig.type}`;
      btn.textContent = btnConfig.text;
      btn.onclick = () => {
        if (btnConfig.onClick) {
          const result = btnConfig.onClick();
          if (result !== false) {
            closeModal(overlay, result);
          }
        } else {
          closeModal(overlay, btnConfig.value);
        }
      };
      footer.appendChild(btn);
    });
    
    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(footer);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay, null);
      }
    });
    
    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal(overlay, null);
      }
    };
    document.addEventListener('keydown', escHandler);
    
    // Focus first input
    setTimeout(() => {
      const firstInput = body.querySelector('input');
      if (firstInput) firstInput.focus();
    }, 100);
    
    function closeModal(modalEl, value) {
      document.removeEventListener('keydown', escHandler);
      modalEl.style.opacity = '0';
      setTimeout(() => {
        if (modalEl.parentNode) {
          modalEl.parentNode.removeChild(modalEl);
        }
        resolve(value);
      }, 200);
    }
    
    overlay.closeModal = (value) => closeModal(overlay, value);
  });
}

async function showSetPINModal() {
  let pinInput, confirmInput, strengthBar, hintText;
  
  // Create modal without awaiting - this adds it to DOM immediately
  const modalPromise = createModal({
    icon: '🔐',
    title: 'Set Your PIN',
    description: 'Create a secure PIN to protect your settings (minimum 4 characters)',
    bodyHTML: `
      <div class="pin-input-group">
        <label class="pin-input-label">New PIN</label>
        <input type="password" class="pin-input" id="modal-pin-input" placeholder="Enter PIN" maxlength="20" autocomplete="off">
        <div class="pin-strength-indicator">
          <div class="pin-strength-bar" id="modal-strength-bar"></div>
        </div>
        <div class="pin-hint" id="modal-hint">Use at least 4 characters</div>
      </div>
      <div class="pin-input-group">
        <label class="pin-input-label">Confirm PIN</label>
        <input type="password" class="pin-input" id="modal-confirm-input" placeholder="Confirm PIN" maxlength="20" autocomplete="off">
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      { 
        text: 'Set PIN', 
        type: 'primary',
        onClick: () => {
          const pin = pinInput.value.trim();
          const confirm = confirmInput.value.trim();
          
          if (pin.length < 4) {
            pinInput.classList.add('error');
            hintText.textContent = '❌ PIN must be at least 4 characters';
            hintText.className = 'pin-hint error';
            setTimeout(() => pinInput.classList.remove('error'), 500);
            return false; // Don't close modal
          }
          
          if (pin !== confirm) {
            confirmInput.classList.add('error');
            hintText.textContent = '❌ PINs do not match';
            hintText.className = 'pin-hint error';
            setTimeout(() => confirmInput.classList.remove('error'), 500);
            return false; // Don't close modal
          }
          
          return pin;
        }
      }
    ]
  });
  
  // Get references immediately after modal is created (while it's still in DOM)
  // Use a small timeout to ensure DOM has been updated
  await new Promise(resolve => setTimeout(resolve, 50));
  
  pinInput = document.getElementById('modal-pin-input');
  confirmInput = document.getElementById('modal-confirm-input');
  strengthBar = document.getElementById('modal-strength-bar');
  hintText = document.getElementById('modal-hint');
  
  // PIN strength indicator
  if (pinInput) {
    pinInput.addEventListener('input', () => {
      const pin = pinInput.value;
      const length = pin.length;
      
      strengthBar.className = 'pin-strength-bar';
      if (length === 0) {
        strengthBar.className = 'pin-strength-bar';
        hintText.textContent = 'Use at least 4 characters';
        hintText.className = 'pin-hint';
      } else if (length < 4) {
        strengthBar.classList.add('weak');
        hintText.textContent = '⚠️ Too short';
        hintText.className = 'pin-hint error';
      } else if (length < 6) {
        strengthBar.classList.add('medium');
        hintText.textContent = '✓ Good';
        hintText.className = 'pin-hint';
      } else {
        strengthBar.classList.add('strong');
        hintText.textContent = '✓ Strong';
        hintText.className = 'pin-hint success';
      }
    });
  }
  
  // Enter key handling
  const handleEnter = (e) => {
    if (e.key === 'Enter') {
      const setPinBtn = document.querySelector('.modal-button-primary');
      if (setPinBtn) setPinBtn.click();
    }
  };
  
  if (pinInput) pinInput.addEventListener('keypress', handleEnter);
  if (confirmInput) confirmInput.addEventListener('keypress', handleEnter);
  
  // Now wait for the modal to close and return the result
  return await modalPromise;
}

async function showVerifyPINModal(actionLabel = 'this action') {
  let pinInput, hintText;
  
  const storedPIN = await getPIN();
  
  // Create modal without awaiting - this adds it to DOM immediately
  const modalPromise = createModal({
    icon: '🔓',
    title: 'Verify PIN',
    description: `Enter your PIN to ${actionLabel}`,
    bodyHTML: `
      <div class="pin-input-group">
        <label class="pin-input-label">Enter PIN</label>
        <input type="password" class="pin-input" id="modal-verify-input" placeholder="••••" maxlength="20" autocomplete="off">
        <div class="pin-hint" id="modal-verify-hint">Enter your PIN to continue</div>
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      { 
        text: 'Verify', 
        type: 'primary',
        onClick: () => {
          const pin = pinInput.value.trim();
          
          if (pin === storedPIN) {
            return true;
          } else {
            pinInput.classList.add('error');
            pinInput.value = '';
            hintText.textContent = '❌ Incorrect PIN';
            hintText.className = 'pin-hint error';
            setTimeout(() => pinInput.classList.remove('error'), 500);
            return false; // Don't close modal
          }
        }
      }
    ]
  });
  
  // Get references immediately after modal is created (while it's still in DOM)
  // Use a small timeout to ensure DOM has been updated
  await new Promise(resolve => setTimeout(resolve, 50));
  
  pinInput = document.getElementById('modal-verify-input');
  hintText = document.getElementById('modal-verify-hint');
  
  // Enter key handling
  if (pinInput) {
    pinInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const verifyBtn = document.querySelector('.modal-button-primary');
        if (verifyBtn) verifyBtn.click();
      }
    });
  }
  
  // Now wait for the modal to close and return the result
  return await modalPromise;
}

async function showConfirmModal(config) {
  return await createModal({
    icon: config.icon || '⚠️',
    title: config.title,
    description: config.description,
    bodyHTML: config.message ? `<p style="text-align: center; color: var(--foreground-muted); margin: 1rem 0;">${config.message}</p>` : '',
    buttons: [
      { text: 'Cancel', type: 'secondary', value: false },
      { text: config.confirmText || 'Confirm', type: config.destructive ? 'destructive' : 'primary', value: true }
    ]
  });
}

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await browserAPI.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.customPatterns = Array.isArray(merged.customPatterns) ? [...merged.customPatterns] : [];
  merged.trustedImageDomains = Array.isArray(merged.trustedImageDomains) ? [...merged.trustedImageDomains] : [];
  merged.debugMode = merged.debugMode === true;
  return merged;
}

function areStringListsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function setSettings(newSettings) {
  await browserAPI.storage.local.set({ [SETTINGS_KEY]: newSettings });
}

async function getStats() {
  const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
  return stats || { blockedCount: 0, lastBlocked: null };
}

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
  const newPin = await showSetPINModal();
  if (!newPin) return false;
  await setPIN(newPin);
  return true;
}

async function requirePIN(actionLabel = 'this action') {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  const verified = await showVerifyPINModal(actionLabel);
  return verified === true;
}

// Only require PIN if one is already set (doesn't prompt to create one)
async function requirePINIfSet(actionLabel = 'this action') {
  const stored = await getPIN();
  if (!stored) return true; // No PIN set, allow action
  const verified = await showVerifyPINModal(actionLabel);
  return verified === true;
}

// Streak tracking
async function getStreakStart() {
  const { [STREAK_START_KEY]: start } = await browserAPI.storage.local.get(STREAK_START_KEY);
  return start || null;
}

async function resetStreak() {
  await browserAPI.storage.local.remove(STREAK_START_KEY);
}

function formatStreakDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}${hours > 0 ? `, ${hours}h` : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}${minutes > 0 ? `, ${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return 'less than a minute';
}

function getStreakMessage(days) {
  if (days >= 365) return "An incredible year+ of strength. You've built something truly powerful.";
  if (days >= 180) return "Half a year of discipline. That's extraordinary willpower.";
  if (days >= 90) return "Three months strong. Your future self is grateful.";
  if (days >= 30) return "A full month of commitment. That takes real courage.";
  if (days >= 14) return "Two weeks of resilience. You're building a new habit.";
  if (days >= 7) return "A whole week of strength. Every day counts.";
  if (days >= 1) return "You've started a streak. Don't let it end here.";
  return "Every journey starts with a single step. Keep going.";
}

const COMMITMENT_SENTENCE = 'By typing this sentence, I acknowledge that I am consciously choosing to override the protection I previously put in place to guard my focus, discipline, and personal growth. I understand that this action directly contradicts the commitment I made to become a stronger, more self-controlled, and purpose-driven version of myself. I accept full responsibility for this decision, including any negative impact it may have on my goals, my time, my mental clarity, and my long-term well-being. I recognize that this choice is not accidental, not forced, and not automatic it is entirely mine. I understand that I am stepping away from the standards I set for myself, and I do so knowingly, without excuses, and without blaming circumstances, emotions, or external triggers. I acknowledge that growth requires consistency and integrity, and by proceeding, I am choosing short-term gratification over long-term self-respect. I accept that this action reflects my current priorities, and I take complete ownership of whatever follows as a result of this decision.';

async function showCommitmentGate() {
  const overlay = $('commitment-overlay');
  if (!overlay) return false;

  const streakStart = await getStreakStart();
  const streakMs = streakStart ? Date.now() - streakStart : 0;
  const streakDays = Math.floor(streakMs / 86400000);
  const streakFormatted = formatStreakDuration(streakMs);
  const streakMsg = getStreakMessage(streakDays);

  const streakNumber = $('commitment-streak-number');
  const streakUnit = $('commitment-streak-unit');
  const streakText = $('commitment-streak-text');
  streakNumber.textContent = streakDays;
  streakUnit.textContent = streakDays === 1 ? 'day' : 'days';
  streakText.textContent = streakMsg;

  const streakDetail = $('commitment-streak-detail');
  if (streakDetail) {
    streakDetail.textContent = streakMs > 0
      ? `Protected for ${streakFormatted}`
      : 'Protection just started';
  }

  const steps = overlay.querySelectorAll('.commitment-step');
  steps.forEach(s => s.classList.add('hidden'));
  steps[0].classList.remove('hidden');

  const reflectInput = $('commitment-reflect-input');
  const confirmInput = $('commitment-confirm-input');
  const confirmHint = $('commitment-confirm-hint');
  if (reflectInput) reflectInput.value = '';
  if (confirmInput) confirmInput.value = '';
  if (confirmHint) confirmHint.textContent = `Type: "${COMMITMENT_SENTENCE}"`;

  updateCommitmentProgress(1);

  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');

  return new Promise(resolve => {
    let currentStep = 1;

    const cleanup = () => {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    };

    const goToStep = (step) => {
      currentStep = step;
      steps.forEach(s => s.classList.add('hidden'));
      steps[step - 1].classList.remove('hidden');
      updateCommitmentProgress(step);

      if (step === 2 && reflectInput) {
        reflectInput.focus();
        const reflectError = $('commitment-reflect-error');
        if (reflectError) reflectError.textContent = '';
      }
      if (step === 3 && confirmInput) {
        confirmInput.value = '';
        confirmInput.focus();
        const confirmError = $('commitment-confirm-error');
        if (confirmError) confirmError.textContent = '';
        updateConfirmMatch('');
      }
    };

    const updateConfirmMatch = (value) => {
      const matchIndicator = $('commitment-confirm-match');
      if (!matchIndicator) return;
      if (!value) {
        matchIndicator.textContent = '';
        return;
      }
      const target = COMMITMENT_SENTENCE.toLowerCase();
      const current = value.toLowerCase();
      if (target === current) {
        matchIndicator.textContent = 'Sentence matches';
        matchIndicator.className = 'commitment-match valid';
      } else if (target.startsWith(current)) {
        matchIndicator.textContent = 'Keep typing...';
        matchIndicator.className = 'commitment-match partial';
      } else {
        matchIndicator.textContent = 'Doesn\'t match — check your spelling';
        matchIndicator.className = 'commitment-match invalid';
      }
    };

    const keepBtn = $('commitment-keep-btn');
    const continueBtn = $('commitment-continue-btn');
    if (keepBtn) keepBtn.onclick = () => { cleanup(); resolve(false); };
    if (continueBtn) continueBtn.onclick = () => goToStep(2);

    const reflectBack = $('commitment-reflect-back');
    const reflectNext = $('commitment-reflect-next');
    if (reflectBack) reflectBack.onclick = () => goToStep(1);
    if (reflectNext) reflectNext.onclick = () => {
      const val = reflectInput ? reflectInput.value.trim() : '';
      const reflectError = $('commitment-reflect-error');
      if (val.length < 10) {
        if (reflectError) reflectError.textContent = 'Please write a more thoughtful answer (at least 10 characters).';
        return;
      }
      if (reflectError) reflectError.textContent = '';
      goToStep(3);
    };

    if (reflectInput) {
      reflectInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); reflectNext.click(); }
        if (e.key === 'Escape') { cleanup(); resolve(false); }
      };
    }

    const confirmBack = $('commitment-confirm-back');
    const confirmDisable = $('commitment-confirm-disable');
    if (confirmBack) confirmBack.onclick = () => goToStep(2);
    if (confirmDisable) confirmDisable.onclick = () => {
      const val = confirmInput ? confirmInput.value.trim() : '';
      const confirmError = $('commitment-confirm-error');
      if (val.toLowerCase() !== COMMITMENT_SENTENCE.toLowerCase()) {
        if (confirmError) confirmError.textContent = 'The sentence doesn\'t match. Please type it exactly.';
        if (confirmInput) {
          confirmInput.style.animation = 'shake 0.5s ease-in-out';
          setTimeout(() => { confirmInput.style.animation = ''; }, 500);
        }
        return;
      }
      if (confirmError) confirmError.textContent = '';
      cleanup();
      resolve(true);
    };

    if (confirmInput) {
      confirmInput.addEventListener('input', () => updateConfirmMatch(confirmInput.value));
      confirmInput.addEventListener('paste', (e) => e.preventDefault());
      confirmInput.onkeydown = (e) => {
        if (e.key === 'Escape') { cleanup(); resolve(false); }
      };
    }

    const handleOverlayKey = (e) => {
      if (e.key === 'Escape' && currentStep === 1) {
        cleanup();
        resolve(false);
        document.removeEventListener('keydown', handleOverlayKey);
      }
    };
    document.addEventListener('keydown', handleOverlayKey);
  });
}

function updateCommitmentProgress(activeStep) {
  for (let i = 1; i <= 3; i++) {
    const dot = $(`commitment-progress-${i}`);
    if (!dot) continue;
    dot.classList.toggle('active', i === activeStep);
    dot.classList.toggle('done', i < activeStep);
  }
}

function serializePatterns(text) {
  return text
    .split(/\r?\n/) // lines
    .map(s => s.trim())
    .filter(Boolean);
}

function deserializePatterns(list) {
  return (list || []).join('\n');
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: whitelist } = await browserAPI.storage.local.get(WHITELIST_KEY);
  return whitelist || [];
}

async function setWhitelist(whitelist) {
  await browserAPI.storage.local.set({ [WHITELIST_KEY]: whitelist });
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

function validateDomain(domain) {
  domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  domain = domain.split('/')[0];
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain) ? domain : null;
}

async function renderWhitelist() {
  const whitelist = await cleanExpiredWhitelist();
  const container = $('whitelist-display');
  
  if (whitelist.length === 0) {
    container.innerHTML = '<div class="whitelist-empty">No whitelisted domains</div>';
    return;
  }
  
  container.innerHTML = '';
  
  whitelist.forEach(item => {
    const addedDate = new Date(item.addedAt).toLocaleDateString();
    
    const itemDiv = document.createElement('div');
    itemDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid color-mix(in oklab,CanvasText,transparent 85%);';
    
    const infoDiv = document.createElement('div');
    
    const domainStrong = document.createElement('strong');
    domainStrong.textContent = item.domain;
    
    const dateDiv = document.createElement('div');
    dateDiv.style.cssText = 'font-size:12px;color:GrayText;';
    dateDiv.textContent = `Added ${addedDate}`;
    
    infoDiv.appendChild(domainStrong);
    infoDiv.appendChild(dateDiv);
    
    const removeButton = document.createElement('button');
    removeButton.textContent = 'Remove';
    removeButton.style.cssText = 'background:#d32f2f;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;';
    removeButton.onclick = () => removeWhitelistItem(item.domain);
    
    itemDiv.appendChild(infoDiv);
    itemDiv.appendChild(removeButton);
    container.appendChild(itemDiv);
  });
}

window.removeWhitelistItem = async function(domain) {
  const whitelist = await getWhitelist();
  const filtered = whitelist.filter(item => item.domain !== domain);
  await setWhitelist(filtered);
  await renderWhitelist();
}

async function render() {
  const settings = await getSettings();
  const stats = await getStats();
  const pin = await getPIN();

  await loadWhatsNew();

  $('enabled').checked = !!settings.enabled;
  $('smart').checked = !!settings.useSmartBlocking;
  $('debug-mode').checked = !!settings.debugMode;
  const imageFilterLevel = normalizeImageFilterLevel(settings.imageFilterLevel);
  const imageFilterLevelSelect = $('image-filter-level');
  if (imageFilterLevelSelect) {
    imageFilterLevelSelect.value = imageFilterLevel;
  }
  const imageFilterLevelDetail = $('image-filter-level-detail');
  if (imageFilterLevelDetail) {
    imageFilterLevelDetail.textContent = getImageFilterLevelMeta(imageFilterLevel).detail;
  }
  $('patterns').value = deserializePatterns(settings.customPatterns);
  const customKeywords = $('custom-keywords');
  if (customKeywords) customKeywords.value = deserializePatterns(settings.customKeywordList || []);
  $('trusted-domains').value = deserializePatterns(settings.trustedImageDomains || []);

  $('blocked-stats').textContent = `🛡️ Blocked: ${stats.blockedCount || 0} sites`;
  $('pin-status').textContent = pin ? '🔒 PIN: Set' : '🔓 PIN: Not set';
  $('pin-status').style.color = pin ? 'var(--success)' : 'var(--warning)';
  $('pin-status').style.background = pin ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)';
  $('pin-status').style.borderColor = pin ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)';
  
  // Render DNS protection settings
  const dnsToggle = $('dns-filter-enabled');
  if (dnsToggle) {
    dnsToggle.checked = !!settings.dnsFilterEnabled;
  }
  const dnsBadge = $('dns-status');
  if (dnsBadge) {
    if (settings.dnsFilterEnabled) {
      dnsBadge.textContent = '🟢 DNS: Active';
      dnsBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      dnsBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      dnsBadge.style.color = 'var(--success)';
    } else {
      dnsBadge.textContent = '🌐 DNS: Off';
      dnsBadge.style.background = '';
      dnsBadge.style.borderColor = '';
      dnsBadge.style.color = '';
    }
  }

  // Render Safe Search + social filter settings
  const safeSearchOn = settings.safeSearchEnabled !== false;
  const facebookReelsOn = settings.facebookReelsEnabled === true;
  const instagramReelsOn = settings.instagramReelsEnabled === true;

  const safeSearchToggle = $('safe-search-enabled');
  if (safeSearchToggle) {
    safeSearchToggle.checked = safeSearchOn;
  }
  const facebookReelsToggle = $('facebook-reels-enabled');
  if (facebookReelsToggle) {
    facebookReelsToggle.checked = facebookReelsOn;
  }
  const instagramReelsToggle = $('instagram-reels-enabled');
  if (instagramReelsToggle) {
    instagramReelsToggle.checked = instagramReelsOn;
  }
  const safeSearchBadge = $('safe-search-status');
  if (safeSearchBadge) {
    if (safeSearchOn) {
      safeSearchBadge.textContent = '🔎 Safe Search: On';
      safeSearchBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      safeSearchBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      safeSearchBadge.style.color = 'var(--success)';
    } else {
      safeSearchBadge.textContent = '🔎 Safe Search: Off';
      safeSearchBadge.style.background = '';
      safeSearchBadge.style.borderColor = '';
      safeSearchBadge.style.color = '';
    }
  }
  const fbReelsBadge = $('facebook-reels-status');
  if (fbReelsBadge) {
    if (facebookReelsOn) {
      fbReelsBadge.textContent = '📵 FB Reels: Disabled';
      fbReelsBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      fbReelsBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      fbReelsBadge.style.color = 'var(--success)';
    } else {
      fbReelsBadge.textContent = '📵 FB Reels: Off';
      fbReelsBadge.style.background = '';
      fbReelsBadge.style.borderColor = '';
      fbReelsBadge.style.color = '';
    }
  }
  const igReelsBadge = $('instagram-reels-status');
  if (igReelsBadge) {
    if (instagramReelsOn) {
      igReelsBadge.textContent = '📵 IG Reels: Disabled';
      igReelsBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      igReelsBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      igReelsBadge.style.color = 'var(--success)';
    } else {
      igReelsBadge.textContent = '📵 IG Reels: Off';
      igReelsBadge.style.background = '';
      igReelsBadge.style.borderColor = '';
      igReelsBadge.style.color = '';
    }
  }

  // Render custom blocked page settings
  const useCustom = settings.blockedPageType === 'custom';
  const usePlain = settings.blockedPageType === 'plain_html';
  $('use-custom-blocked-page').checked = useCustom;
  $('use-plain-html-blocked-page').checked = usePlain;
  $('custom-blocked-page-url').value = settings.customBlockedPageUrl || '';
  $('custom-blocked-page-section').style.display = useCustom ? 'block' : 'none';
  $('plain-blocked-page-section').style.display = usePlain ? 'block' : 'none';
  const plainStatus = $('plain-html-status');
  if (plainStatus) {
    plainStatus.textContent = (settings.plainBlockedPageHtml && settings.plainBlockedPageHtml.trim())
      ? 'HTML uploaded and saved'
      : 'No HTML uploaded yet';
  }
  
  // Incognito status + link
  try {
    const extensionsBase = await getExtensionsBaseURL();
    const extId = (browserAPI && browserAPI.runtime && browserAPI.runtime.id) ? browserAPI.runtime.id : '';
    const manageUrl = extId ? (extensionsBase + '?id=' + extId) : extensionsBase;
    const manageLink = $('open-incognito-settings');
    if (manageLink) {
      manageLink.href = manageUrl;
    }

    const setIncognitoUI = function(allowed) {
      const badge = $('incognito-status');
      const toggle = $('allow-incognito');
      if (badge) {
        if (allowed) {
          badge.textContent = '🟢 Incognito: Enabled';
          badge.style.background = 'rgba(16, 185, 129, 0.1)';
          badge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
          badge.style.color = 'var(--success)';
        } else {
          badge.textContent = '🟡 Incognito: Disabled';
          badge.style.background = 'rgba(245, 158, 11, 0.1)';
          badge.style.borderColor = 'rgba(245, 158, 11, 0.2)';
          badge.style.color = 'var(--warning)';
        }
      }
      if (toggle) toggle.checked = !!allowed;
    };

    const getIncognitoAllowed = function() {
      return new Promise(function(resolve) {
        try {
          if (browserAPI && browserAPI.extension && typeof browserAPI.extension.isAllowedIncognitoAccess === 'function') {
            var maybe = browserAPI.extension.isAllowedIncognitoAccess(function(allowed) { resolve(!!allowed); });
            if (maybe && typeof maybe.then === 'function') {
              maybe.then(function(allowed) { resolve(!!allowed); }).catch(function() { resolve(false); });
            }
          } else {
            resolve(false);
          }
        } catch (e) {
          resolve(false);
        }
      });
    };

    setIncognitoUI(await getIncognitoAllowed());
  } catch (_) {}

  await renderWhitelist();
}

async function updateReportCooldown() {
  const cooldownEl = $('report-cooldown');
  const submitBtn = $('submit-report');
  if (!cooldownEl || !submitBtn || typeof PBlockerReports === 'undefined') return;

  const remaining = await PBlockerReports.getCooldownRemaining();
  if (remaining > 0) {
    submitBtn.disabled = true;
    cooldownEl.textContent = `Wait ${Math.ceil(remaining / 1000)}s`;
    setTimeout(updateReportCooldown, 1000);
  } else {
    submitBtn.disabled = false;
    cooldownEl.textContent = '';
  }
}

// Resolve the proper internal extensions page base URL for the current browser
async function getExtensionsBaseURL() {
  try {
    // Firefox uses about:addons for add-on management
    if (typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent || '')) {
      return 'about:addons';
    }
    // Brave exposes navigator.brave with isBrave()
    if (typeof navigator !== 'undefined' && navigator.brave && typeof navigator.brave.isBrave === 'function') {
      try {
        const isBrave = await navigator.brave.isBrave();
        if (isBrave) return 'brave://extensions/';
      } catch (_) {}
    }
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
    if (/Edg\//.test(ua)) return 'edge://extensions/';
    if (/OPR\//.test(ua) || /Opera/i.test(ua)) return 'opera://extensions/';
    if (/Vivaldi/i.test(ua)) return 'vivaldi://extensions/';
    // Fall back to Chrome/Chromium default
    return 'chrome://extensions/';
  } catch (_) {
    return 'chrome://extensions/';
  }
}

// Helper: robustly attempt to open the browser's extensions page
async function openExtensionsManagePage() {
  const base = await getExtensionsBaseURL();
  const id = (browserAPI && browserAPI.runtime && browserAPI.runtime.id) ? browserAPI.runtime.id : '';
  const manageUrl = id ? (base + '?id=' + id) : base;

  // 1) Try window.open with full URL
  try {
    const w = window.open(manageUrl, '_blank');
    if (w) return true;
  } catch (_) {}

  // 2) Try tabs.create with full URL (may be blocked for chrome:// / edge://)
  const tryTabsCreate = (url) => new Promise((resolve) => {
    try {
      const maybe = browserAPI && browserAPI.tabs && browserAPI.tabs.create ? browserAPI.tabs.create({ url }, (tab) => {
        const ok = !!tab && !(browserAPI && browserAPI.runtime && browserAPI.runtime.lastError);
        resolve(ok);
      }) : null;
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((tab) => resolve(!!tab)).catch(() => resolve(false));
      }
    } catch (_) { resolve(false); }
  });

  if (await tryTabsCreate(manageUrl)) return true;
  if (await tryTabsCreate(base)) return true;

  // 3) Fallback: copy link and show instructions modal
  try { await navigator.clipboard.writeText(manageUrl); } catch (_) {}

  await createModal({
    icon: 'ℹ️',
    title: 'Open Extensions Settings',
    description: 'Your browser blocks opening this page directly from extensions.',
    bodyHTML: `<div style="word-break: break-all; font-family: var(--font-mono); font-size: 12px; padding: 8px; border: 1px solid var(--input-border); border-radius: 6px; background: var(--input-bg);">${manageUrl}</div>
               <p style="margin-top:8px; color: var(--foreground-dim);">The link has been copied to your clipboard. Paste it into the address bar to open your extension details and enable "Allow in incognito".</p>`,
    buttons: [
      { text: 'Copy Link Again', type: 'secondary', onClick: () => { try { navigator.clipboard.writeText(manageUrl); } catch(_) {}; return true; } },
      { text: 'Done', type: 'primary', value: true }
    ]
  });
  return false;
}

async function init() {
  await render();

  // Community Reports form handler
  const submitReportBtn = $('submit-report');
  if (submitReportBtn) {
    submitReportBtn.addEventListener('click', async () => {
      const urlInput = $('report-url');
      const typeSelect = $('report-type');
      const categorySelect = $('report-category');
      const notesInput = $('report-notes');
      const statusHint = $('report-status');
      if (!urlInput || !typeSelect || !categorySelect || !notesInput || !statusHint) {
        showToast('Report form is not fully available. Please reload this page.', 'error');
        return;
      }

      const raw = (urlInput.value || '').trim();
      if (!raw) {
        showToast('Please enter a website URL', 'error');
        urlInput.focus();
        return;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
      } catch {
        showToast('Please enter a valid URL', 'error');
        urlInput.focus();
        return;
      }

      if (!/^https?:$/i.test(parsedUrl.protocol)) {
        showToast('Only http:// or https:// websites are allowed', 'error');
        urlInput.focus();
        return;
      }

      const domain = validateDomain(parsedUrl.hostname);
      if (!domain) {
        showToast('Please enter a valid website domain (e.g., example.com)', 'error');
        urlInput.focus();
        return;
      }

      if (!typeSelect.value) {
        showToast('Please select a report type', 'error');
        typeSelect.focus();
        return;
      }

      submitReportBtn.disabled = true;
      submitReportBtn.textContent = 'Submitting...';
      statusHint.textContent = 'Submitting your report...';
      statusHint.className = 'pin-hint';

      try {
        if (typeof PBlockerReports === 'undefined') {
          throw new Error('Report system not loaded');
        }

        await PBlockerReports.submitReport({
          url: parsedUrl.href,
          domain,
          reportType: typeSelect.value,
          category: typeSelect.value === 'incorrectly_blocked' ? 'n/a' : categorySelect.value,
          notes: notesInput.value.trim(),
        });

        const remaining = await PBlockerReports.getDailyRemaining();
        showToast('Report submitted -- thank you!', 'success');
        statusHint.textContent = `Report submitted! ${remaining} report${remaining === 1 ? '' : 's'} remaining today.`;
        statusHint.className = 'pin-hint success';

        urlInput.value = '';
        notesInput.value = '';
        const counter = $('report-notes-counter');
        if (counter) {
          counter.textContent = '0 / 500';
          counter.style.color = 'var(--foreground-dim)';
        }
        updateReportCooldown();
      } catch (error) {
        showToast(error.message || 'Failed to submit report', 'error');
        statusHint.textContent = error.message || 'Submission failed. Please try again.';
        statusHint.className = 'pin-hint error';
      } finally {
        submitReportBtn.textContent = 'Submit Report';
        await updateReportCooldown();
      }
    });

    updateReportCooldown();

    const reportTypeSelect = $('report-type');
    const categoryGroup = $('report-category-group');
    if (reportTypeSelect && categoryGroup) {
      reportTypeSelect.addEventListener('change', () => {
        categoryGroup.style.display =
          reportTypeSelect.value === 'incorrectly_blocked' ? 'none' : '';
      });
      categoryGroup.style.display =
        reportTypeSelect.value === 'incorrectly_blocked' ? 'none' : '';
    }

    const notesField = $('report-notes');
    const notesCounter = $('report-notes-counter');
    if (notesField && notesCounter) {
      notesField.addEventListener('input', () => {
        const len = notesField.value.length;
        notesCounter.textContent = `${len} / 500`;
        notesCounter.style.color = len >= 450 ? 'var(--warning)' : 'var(--foreground-dim)';
      });
    }
  }

  $('enabled').addEventListener('change', async (e) => {
    const s = await getSettings();
    if (s.enabled && !e.target.checked) {
      const ok = await requirePINIfSet('disable blocking');
      if (!ok) {
        e.target.checked = true;
        return;
      }
      const committed = await showCommitmentGate();
      if (!committed) {
        e.target.checked = true;
        return;
      }
      s.enabled = false;
      await setSettings(s);
      await resetStreak();
    } else {
      s.enabled = e.target.checked;
      await setSettings(s);
      if (s.enabled) {
        await browserAPI.storage.local.set({ [STREAK_START_KEY]: Date.now() });
      }
    }
  });

  $('smart').addEventListener('change', async (e) => {
    const s = await getSettings();
    const ok = await requirePINIfSet('switch modes');
    if (!ok) {
      e.target.checked = !!s.useSmartBlocking;
      return;
    }
    s.useSmartBlocking = e.target.checked;
    await setSettings(s);
  });


  $('debug-mode').addEventListener('change', async (e) => {
    const settings = await getSettings();
    settings.debugMode = e.target.checked;
    await setSettings(settings);
  });

  const imageFilterLevelEl = $('image-filter-level');
  if (imageFilterLevelEl) {
    imageFilterLevelEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      settings.imageFilterLevel = normalizeImageFilterLevel(e.target.value);
      await setSettings(settings);
      const detail = $('image-filter-level-detail');
      if (detail) {
        detail.textContent = getImageFilterLevelMeta(settings.imageFilterLevel).detail;
      }
      showToast(`Image filtering set to ${getImageFilterLevelMeta(settings.imageFilterLevel).label}`, 'success');
    });
  }

  // DNS Protection toggle
  const dnsFilterToggle = $('dns-filter-enabled');
  if (dnsFilterToggle) {
    dnsFilterToggle.addEventListener('change', async (e) => {
      const settings = await getSettings();
      settings.dnsFilterEnabled = e.target.checked;
      await setSettings(settings);
      await render();
      showToast(
        e.target.checked
          ? 'DNS Protection enabled — domains will be checked via Cloudflare for Families'
          : 'DNS Protection disabled',
        e.target.checked ? 'success' : 'info'
      );
    });
  }

  // Safe Search toggle
  const safeSearchToggleEl = $('safe-search-enabled');
  if (safeSearchToggleEl) {
    safeSearchToggleEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.safeSearchEnabled === true && !e.target.checked) {
        const ok = await requirePINIfSet('turn off Safe Search enforcement');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.safeSearchEnabled = e.target.checked;
      await setSettings(settings);
      await render();
      showToast(
        e.target.checked
          ? 'Safe Search enforced on Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Qwant, AOL Search & Presearch'
          : 'Safe Search enforcement disabled',
        e.target.checked ? 'success' : 'info'
      );
    });
  }

  const fbReelsEl = $('facebook-reels-enabled');
  if (fbReelsEl) {
    fbReelsEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.facebookReelsEnabled === true && !e.target.checked) {
        const ok = await requirePINIfSet('turn off Facebook Reels blocking');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.facebookReelsEnabled = e.target.checked;
      await setSettings(settings);
      await render();
      showToast(
        e.target.checked
          ? 'Facebook Reels disabled across facebook.com'
          : 'Facebook Reels blocking disabled',
        e.target.checked ? 'success' : 'info'
      );
    });
  }

  const igReelsEl = $('instagram-reels-enabled');
  if (igReelsEl) {
    igReelsEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.instagramReelsEnabled === true && !e.target.checked) {
        const ok = await requirePINIfSet('turn off Instagram Reels blocking');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.instagramReelsEnabled = e.target.checked;
      await setSettings(settings);
      await render();
      showToast(
        e.target.checked
          ? 'Instagram Reels disabled across instagram.com'
          : 'Instagram Reels blocking disabled',
        e.target.checked ? 'success' : 'info'
      );
    });
  }

  const dnsTestBtn = $('dns-test-btn');
  if (dnsTestBtn) {
    dnsTestBtn.addEventListener('click', async () => {
      const resultEl = $('dns-test-result');
      if (!resultEl) return;
      resultEl.textContent = 'Testing DNS connection...';
      resultEl.style.color = 'var(--foreground-muted)';
      dnsTestBtn.disabled = true;
      try {
        const res = await fetch(
          'https://family.cloudflare-dns.com/dns-query?name=example.com&type=A',
          { headers: { Accept: 'application/dns-json' } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (typeof data.Status === 'number') {
          resultEl.textContent = 'Cloudflare Family DNS is reachable and working correctly.';
          resultEl.style.color = 'var(--success)';
        } else {
          throw new Error('Unexpected response');
        }
      } catch (err) {
        resultEl.textContent = `DNS test failed: ${err.message}. Check your internet connection.`;
        resultEl.style.color = 'var(--destructive)';
      } finally {
        dnsTestBtn.disabled = false;
      }
    });
  }

  // Custom Blocked Page Functionality
  $('use-custom-blocked-page').addEventListener('change', async (e) => {
    const customSection = $('custom-blocked-page-section');
    const plainToggle = $('use-plain-html-blocked-page');
    const plainSection = $('plain-blocked-page-section');
    if (e.target.checked) {
      customSection.style.display = 'block';
      if (plainToggle) plainToggle.checked = false;
      if (plainSection) plainSection.style.display = 'none';
    } else {
      customSection.style.display = 'none';
    }
    
    // Auto-save settings when toggled
    const settings = await getSettings();
    settings.blockedPageType = e.target.checked ? 'custom' : 'default';
    settings.customBlockedPageUrl = e.target.checked ? $('custom-blocked-page-url').value.trim() : '';
    if (e.target.checked) {
      settings.plainBlockedPageHtml = '';
    }
    
    await setSettings(settings);
    showToast('Blocked page settings updated', 'success');
  });

  $('use-plain-html-blocked-page').addEventListener('change', async (e) => {
    const plainSection = $('plain-blocked-page-section');
    const customToggle = $('use-custom-blocked-page');
    const customSection = $('custom-blocked-page-section');
    if (e.target.checked) {
      plainSection.style.display = 'block';
      if (customToggle) customToggle.checked = false;
      if (customSection) customSection.style.display = 'none';
    } else {
      plainSection.style.display = 'none';
    }

    const settings = await getSettings();
    if (e.target.checked && !(settings.plainBlockedPageHtml && settings.plainBlockedPageHtml.trim())) {
      e.target.checked = false;
      plainSection.style.display = 'none';
      showToast('Upload an HTML file first', 'error');
      return;
    }
    settings.blockedPageType = e.target.checked ? 'plain_html' : 'default';
    if (e.target.checked) {
      settings.customBlockedPageUrl = '';
    }

    await setSettings(settings);
    showToast('Blocked page settings updated', 'success');
  });

  // Auto-save when custom URL is changed
  $('custom-blocked-page-url').addEventListener('change', async (e) => {
    if ($('use-custom-blocked-page').checked) {
      const settings = await getSettings();
      settings.customBlockedPageUrl = e.target.value.trim();
      await setSettings(settings);
      showToast('Custom blocked page URL updated', 'success');
    }
  });

  $('plain-blocked-page-file').addEventListener('change', async (e) => {
    try {
      const input = e.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file) return;

      const maxBytes = 1024 * 1024;
      if (typeof file.size === 'number' && file.size > maxBytes) {
        showToast('HTML file too large (max 1MB)', 'error');
        input.value = '';
        return;
      }

      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read_failed'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsText(file);
      });

      $('use-plain-html-blocked-page').checked = true;
      $('plain-blocked-page-section').style.display = 'block';
      $('use-custom-blocked-page').checked = false;
      $('custom-blocked-page-section').style.display = 'none';
      const plainStatus = $('plain-html-status');
      if (plainStatus) plainStatus.textContent = 'HTML uploaded and saved';

      const settings = await getSettings();
      settings.blockedPageType = 'plain_html';
      settings.plainBlockedPageHtml = text;
      settings.customBlockedPageUrl = '';
      await setSettings(settings);
      showToast('HTML uploaded and saved', 'success');
    } catch (_) {
      showToast('Failed to read HTML file', 'error');
    }
  });

  $('clear-plain-html').addEventListener('click', async () => {
    const fileInput = $('plain-blocked-page-file');
    if (fileInput) fileInput.value = '';
    const settings = await getSettings();
    settings.plainBlockedPageHtml = '';
    if (settings.blockedPageType === 'plain_html') {
      settings.blockedPageType = 'default';
    }
    await setSettings(settings);
    await render();
    showToast('Plain HTML cleared', 'success');
  });

  $('test-custom-url').addEventListener('click', async () => {
    const urlInput = $('custom-blocked-page-url');
    const url = urlInput.value.trim();
    const hint = $('url-validation-hint');
    
    if (!url) {
      hint.textContent = '❌ Please enter a URL to test';
      hint.className = 'pin-hint error';
      urlInput.focus();
      return;
    }

    // Validate URL format
    try {
      new URL(url);
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://');
      }
    } catch (error) {
      hint.textContent = '❌ Invalid URL format. Please enter a valid URL starting with http:// or https://';
      hint.className = 'pin-hint error';
      urlInput.focus();
      return;
    }

    // Test URL accessibility
    hint.textContent = '⏳ Testing URL accessibility...';
    hint.className = 'pin-hint';
    
    try {
      const response = await fetch(url, { method: 'HEAD', mode: 'no-cors' });
      // If we get here, the URL is accessible (even with CORS restrictions)
      hint.textContent = '✅ URL is accessible and valid';
      hint.className = 'pin-hint success';
    } catch (error) {
      // Even with no-cors, we might get network errors
      hint.textContent = '⚠️ URL may not be accessible. Please verify it works in your browser.';
      hint.className = 'pin-hint warning';
    }
  });

  $('reset-blocked-page-settings').addEventListener('click', async () => {
    if (!confirm('Reset blocked page settings to default?')) return;
    
    const settings = await getSettings();
    settings.blockedPageType = 'default';
    settings.customBlockedPageUrl = '';
    settings.plainBlockedPageHtml = '';
    
    await setSettings(settings);
    await render();
    
    showToast('Blocked page settings reset to default', 'success');
  });

  // Incognito handling
  const incognitoToggle = $('allow-incognito');
  if (incognitoToggle) {
    incognitoToggle.addEventListener('change', async (e) => {
      // We cannot programmatically change incognito access. Open the extensions page.
      try {
        await openExtensionsManagePage();
        showToast('Open the extensions page and toggle "Allow in incognito" for this extension.', 'info');
      } catch (err) {
        showToast('Please open the extensions page and enable Incognito manually.', 'warning');
      } finally {
        // Reset toggle to reflect actual state after a brief delay
        setTimeout(async () => {
          try {
            if (browserAPI && browserAPI.extension && typeof browserAPI.extension.isAllowedIncognitoAccess === 'function') {
              const allowed = await new Promise((resolve) => {
                try {
                  const maybe = browserAPI.extension.isAllowedIncognitoAccess((a) => resolve(!!a));
                  if (maybe && typeof maybe.then === 'function') {
                    maybe.then((a) => resolve(!!a)).catch(() => resolve(false));
                  }
                } catch (_) { resolve(false); }
              });
              if ($('allow-incognito')) $('allow-incognito').checked = !!allowed;
              if ($('incognito-status')) {
                $('incognito-status').textContent = allowed ? '🟢 Incognito: Enabled' : '🟡 Incognito: Disabled';
              }
            }
          } catch (_) {}
        }, 800);
      }
    });
  }

  // Open Extensions Page button
  const openBtn = $('open-incognito-settings');
  if (openBtn) {
    openBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await openExtensionsManagePage();
    });
  }

  $('save').addEventListener('click', async () => {
    const settings = await getSettings();
    const nextCustomPatterns = serializePatterns($('patterns').value);
    const customPatternsChanged = !areStringListsEqual(settings.customPatterns, nextCustomPatterns);
    if (customPatternsChanged) {
      const ok = await requirePINIfSet('modify custom blocklist');
      if (!ok) return;
    }
    settings.enabled = $('enabled').checked;
    settings.useSmartBlocking = $('smart').checked;
    settings.debugMode = $('debug-mode').checked;
    settings.imageFilterLevel = normalizeImageFilterLevel($('image-filter-level') ? $('image-filter-level').value : settings.imageFilterLevel);
    settings.customPatterns = nextCustomPatterns;
    const customKeywords = $('custom-keywords');
    if (customKeywords) settings.customKeywordList = serializePatterns(customKeywords.value);
    settings.trustedImageDomains = serializePatterns($('trusted-domains').value);
    await setSettings(settings);
    alert('Settings saved!');
  });

  $('refresh-blocklist').addEventListener('click', async () => {
    const btn = $('refresh-blocklist');
    btn.disabled = true;
    btn.textContent = '⏳ Refreshing...';
    try {
      const response = await browserAPI.runtime.sendMessage({ type: 'refresh_remote_blocklist' });
      if (response?.success) {
        showToast(`Blocklist updated — ${(response.count || 0).toLocaleString()} domains loaded`, 'success');
      } else {
        showToast('Failed to refresh blocklist: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Failed to refresh blocklist: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Refresh Blocklist';
    }
  });

  const saveKeywords = $('save-keywords');
  if (saveKeywords) {
    saveKeywords.addEventListener('click', async () => {
      const settings = await getSettings();
      settings.customKeywordList = serializePatterns($('custom-keywords').value);
      await setSettings(settings);
      alert('Custom blocked words saved!');
    });
  }

  const resetKeywords = $('reset-keywords');
  if (resetKeywords) {
    resetKeywords.addEventListener('click', async () => {
      if (!confirm('Reset custom blocked words to defaults?')) return;
      const settings = await getSettings();
      settings.customKeywordList = [];
      await setSettings(settings);
      await render();
    });
  }

  const clearKeywords = $('clear-keywords');
  if (clearKeywords) {
    clearKeywords.addEventListener('click', async () => {
      const ok = await requirePINIfSet('clear custom blocked words');
      if (!ok) return;
      if (!confirm('Clear your custom blocked words?')) return;
      const settings = await getSettings();
      settings.customKeywordList = [];
      await setSettings(settings);
      await render();
    });
  }

  $('save-trusted').addEventListener('click', async () => {
    const settings = await getSettings();
    settings.trustedImageDomains = serializePatterns($('trusted-domains').value);
    await setSettings(settings);
    alert('Trusted domains saved!');
  });

  $('reset-trusted').addEventListener('click', async () => {
    // Get default trusted domains from background script
    const defaultDomains = [
      'steampowered.com',
      'steamstatic.com',
      'steamcommunity.com',
      'store.steampowered.com',
      'epicgames.com',
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
      'youtube.com',
      'twitch.tv',
      'discord.com',
      'reddit.com',
      'imgur.com',
      'github.com',
      'stackoverflow.com',
      'wikipedia.org'
    ];
    
    $('trusted-domains').value = deserializePatterns(defaultDomains);
    const settings = await getSettings();
    settings.trustedImageDomains = defaultDomains;
    await setSettings(settings);
    alert('Trusted domains reset to defaults!');
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm('Clear your custom blocklist?')) return;
    const ok = await requirePINIfSet('clear custom blocklist');
    if (!ok) return;
    const s = await getSettings();
    s.customPatterns = [];
    await setSettings(s);
    await render();
  });

  $('reset').addEventListener('click', async () => {
    const currentSettings = await getSettings();
    if (currentSettings.customPatterns.length > 0) {
      const ok = await requirePINIfSet('reset settings');
      if (!ok) return;
    }
    if (!confirm('Reset settings to defaults?')) return;
    await setSettings({
      enabled: true,
      useSmartBlocking: true,
      imageFilterLevel: 'strict',
      customPatterns: [],
      customKeywordList: [],
      trustedImageDomains: [],
      debugMode: false,
    });
    await render();
  });

  // Whitelist event listeners
  $('add-whitelist').addEventListener('click', async () => {
    const okPin = await requirePIN('add domain to whitelist');
    if (!okPin) return;
    const domainInput = $('whitelist-domain');
    const domain = validateDomain(domainInput.value.trim());
    
    if (!domain) {
      alert('Please enter a valid domain (e.g., example.com)');
      return;
    }
    
    const whitelist = await getWhitelist();
    const exists = whitelist.some(item => item.domain === domain);
    
    if (exists) {
      alert('Domain is already whitelisted');
      return;
    }
    
    const newItem = {
      domain,
      type: 'permanent',
      addedAt: Date.now()
    };
    
    whitelist.push(newItem);
    await setWhitelist(whitelist);
    domainInput.value = '';
    await renderWhitelist();
  });

  $('whitelist-domain').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      $('add-whitelist').click();
    }
  });

  $('export-whitelist').addEventListener('click', async () => {
    const whitelist = await getWhitelist();
    
    if (whitelist.length === 0) {
      alert('No whitelisted domains to export. Add some domains first.');
      return;
    }
    
    const data = JSON.stringify(whitelist, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pblocker-whitelist-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    // Show success notification
    showToast(`Exported ${whitelist.length} whitelisted domains`, 'success');
  });

  $('import-whitelist').addEventListener('click', () => {
    // Require PIN before importing whitelist entries (only if PIN is set)
    requirePINIfSet('import whitelist').then(ok => {
      if (!ok) return;
      
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // Validate file size (max 1MB)
        if (file.size > 1024 * 1024) {
          alert('File too large. Maximum file size is 1MB.');
          return;
        }
        
        try {
          const text = await file.text();
          const imported = JSON.parse(text);
          
          if (!Array.isArray(imported)) {
            throw new TypeError('Invalid format: Expected array of whitelist items');
          }
          
          // Validate each item structure
          const validItems = [];
          const invalidItems = [];
          
          imported.forEach((item, index) => {
            if (!item || typeof item !== 'object') {
              invalidItems.push(`Item ${index + 1}: Not a valid object`);
              return;
            }
            
            if (!item.domain || typeof item.domain !== 'string') {
              invalidItems.push(`Item ${index + 1}: Missing or invalid domain`);
              return;
            }
            
            // Validate domain format
            const domain = item.domain.trim().toLowerCase();
            if (!validateDomain(domain)) {
              invalidItems.push(`Item ${index + 1}: Invalid domain format "${domain}"`);
              return;
            }
            
            validItems.push({
              domain: domain,
              type: item.type === 'temporary' ? 'temporary' : 'permanent',
              addedAt: item.addedAt && Number.isInteger(item.addedAt) ? item.addedAt : Date.now(),
              expiresAt: item.expiresAt && Number.isInteger(item.expiresAt) ? item.expiresAt : undefined
            });
          });
          
          if (validItems.length === 0) {
            throw new Error('No valid whitelist items found in the file');
          }
          
          const current = await getWhitelist();
          const merged = [...current];
          let newDomains = 0;
          
          validItems.forEach(item => {
            if (!merged.some(existing => existing.domain === item.domain)) {
              merged.push(item);
              newDomains++;
            }
          });
          
          await setWhitelist(merged);
          await renderWhitelist();
          
          let message = `Successfully imported ${newDomains} new domains`;
          if (invalidItems.length > 0) {
            message += ` (${invalidItems.length} invalid items skipped)`;
          }
          
          showToast(message, 'success');
          
        } catch (error) {
          showToast(`Import failed: ${error.message}`, 'error');
        }
      };
      input.click();
    });
  });

  $('clear-whitelist').addEventListener('click', async () => {
    const ok = await requirePIN('clear whitelist');
    if (!ok) return;
    if (!confirm('Clear all whitelisted domains?')) return;
    await setWhitelist([]);
    await renderWhitelist();
  });

  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[BLOCKED_STATS_KEY] || changes[WHITELIST_KEY])) {
      render();
    }
  });

  // PIN management
  $('set-pin').addEventListener('click', async () => {
    const stored = await getPIN();
    if (stored) {
      const ok = await showVerifyPINModal('change PIN');
      if (!ok) return;
    }
    const newPin = await showSetPINModal();
    if (!newPin) return;
    await setPIN(newPin);
    
    // Show success message
    const successModal = await createModal({
      icon: '✅',
      title: 'PIN Set Successfully',
      description: 'Your settings are now protected with a secure PIN',
      bodyHTML: '<div class="success-message">🔐 PIN has been set successfully!</div>',
      buttons: [
        { text: 'Done', type: 'primary', value: true }
      ]
    });
    
    await render();
  });

  $('clear-pin').addEventListener('click', async () => {
    const stored = await getPIN();
    if (!stored) {
      await createModal({
        icon: 'ℹ️',
        title: 'No PIN Set',
        description: 'There is no PIN currently set',
        bodyHTML: '<p style="text-align: center; color: var(--foreground-muted); margin: 1rem 0;">You need to set a PIN first before you can clear it.</p>',
        buttons: [
          { text: 'OK', type: 'primary', value: true }
        ]
      });
      return;
    }
    
    const confirmed = await showConfirmModal({
      icon: '⚠️',
      title: 'Clear PIN',
      description: 'Are you sure you want to remove PIN protection?',
      message: 'You will need to verify your current PIN to proceed.',
      confirmText: 'Clear PIN',
      destructive: true
    });
    
    if (!confirmed) return;
    
    const ok = await showVerifyPINModal('clear PIN');
    if (!ok) return;
    
    await browserAPI.storage.local.remove(PIN_KEY);
    
    // Show success message
    await createModal({
      icon: '✅',
      title: 'PIN Cleared',
      description: 'PIN protection has been removed',
      bodyHTML: '<div class="success-message">🔓 PIN has been cleared successfully!</div>',
      buttons: [
        { text: 'Done', type: 'primary', value: true }
      ]
    });
    
    await render();
  });

  // Auto-trigger commitment gate if redirected from popup with ?action=disable
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'disable') {
    // Clean the URL so refreshing doesn't re-trigger
    history.replaceState(null, '', window.location.pathname);

    const s = await getSettings();
    if (s.enabled) {
      const ok = await requirePINIfSet('disable blocking');
      if (!ok) return;

      const committed = await showCommitmentGate();
      if (!committed) return;

      s.enabled = false;
      await setSettings(s);
      await resetStreak();
      await render();
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
