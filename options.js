const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const PIN_KEY = 'pblocker_pin';
const STREAK_START_KEY = 'pblocker_streak_start';
const UPDATE_INFO_KEY = 'pblocker_update_info';
const UPDATE_DISMISSED_KEY = 'pblocker_update_dismissed';
const ANNOUNCEMENT_INFO_KEY = 'pblocker_announcement_info';
const ANNOUNCEMENT_DISMISSED_KEY = 'pblocker_announcement_dismissed';
// Note: unrelated to PIN_KEY — this is the toolbar-pin prompt, not the PIN lock.
const PIN_BANNER_DISMISSED_KEY = 'pblocker_pin_banner_dismissed';

const DEFAULT_SETTINGS = {
  enabled: true,
  useSmartBlocking: true,
  imageFilterLevel: 'strict',
  customPatterns: [],
  customKeywordList: [],
  trustedImageDomains: [],
  debugMode: false,
  blockedPageType: 'default', // 'default', 'custom', 'plain_html'
  searchResultTreatment: 'hide', // 'hide' | 'overlay' — web/text results only
  searchSummaryEnabled: true, // the "N results blocked" line on search pages
  blockCountDisplay: 'badge', // 'badge' (toolbar icon) | 'floating' (in-page pill)
  customBlockedPageUrl: '',
  plainBlockedPageHtml: '',
  dnsFilterEnabled: false,
  safeSearchEnabled: true,
  facebookReelsEnabled: false,
  instagramReelsEnabled: false,
  aiImageBlocker: false,
  aiImageScanAllSites: true,
  aiStrictness: 'balanced',
  aiTextBlocker: false,
  aiTextStrictness: 'balanced',
};

// Tracks whether a plain-HTML blocked page is currently stored. Kept in sync
// by render()/upload/clear so the toggle handler can decide synchronously
// (within the click's user-gesture) whether to open the file picker.
let plainHtmlAvailable = false;

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

function normalizeAiStrictness(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'relaxed' || value === 'strict') return value;
  return 'balanced';
}

function getAiStrictnessMeta(level) {
  const normalized = normalizeAiStrictness(level);
  if (normalized === 'relaxed') {
    return {
      label: 'Relaxed',
      detail: 'Blocks only clearly explicit images. Fewest false positives.'
    };
  }
  if (normalized === 'strict') {
    return {
      label: 'Strict',
      detail: 'Also catches borderline/suggestive images. May hide some safe content.'
    };
  }
  return {
    label: 'Balanced',
    detail: 'Balanced filtering — blocks clear adult content while letting most safe images through.'
  };
}

// AI Text Blocker shares the relaxed/balanced/strict scale with the image
// blocker (normalizeAiStrictness), but the copy describes whole-page text
// blocking.
function getAiTextStrictnessMeta(level) {
  const normalized = normalizeAiStrictness(level);
  // Wording note: text alone no longer blocks a page — every level below needs
  // the AI Image Blocker to have flagged an image on the same page. These
  // describe how readily the text side agrees, not what it blocks by itself.
  if (normalized === 'relaxed') {
    return {
      label: 'Relaxed',
      detail: 'Agrees only on pages it is very confident are adult. Fewest false positives.'
    };
  }
  if (normalized === 'strict') {
    return {
      label: 'Strict',
      detail: 'Also agrees on borderline pages. More likely to block benign text-heavy pages.'
    };
  }
  return {
    label: 'Balanced',
    detail: 'Balanced — agrees on confident pages while letting benign multilingual pages through.'
  };
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

const COMMENT_MIGRATION_KEY = 'pblocker_comment_syntax_migrated';

/**
 * Comments arrived after these lists did, so an entry saved earlier that happens
 * to start with '#' or '!' — `#nsfw` is a realistic blocked word — would suddenly
 * be read as a note and stop blocking anything. Such entries are rewritten once
 * with the escape (`\#nsfw`), which means exactly what they meant before.
 *
 * Runs once and records that it has. New comments typed after this point are
 * left alone, because by then the user knows what a '#' does.
 */
async function migrateCommentSyntaxOnce() {
  try {
    const store = await browserAPI.storage.local.get([COMMENT_MIGRATION_KEY, SETTINGS_KEY]);
    if (store[COMMENT_MIGRATION_KEY]) return;

    const settings = store[SETTINGS_KEY];
    if (!settings) {
      // Nothing saved yet — a fresh install has nothing to protect.
      await browserAPI.storage.local.set({ [COMMENT_MIGRATION_KEY]: true });
      return;
    }

    const escape = (typeof KeywordPattern !== 'undefined' && KeywordPattern.escapeCommentEntry)
      ? KeywordPattern.escapeCommentEntry
      : (entry) => (isCommentLine(entry) ? '\\' + String(entry).trim() : entry);

    let changed = false;
    const next = { ...settings };
    for (const key of ['customPatterns', 'customKeywordList', 'trustedImageDomains']) {
      if (!Array.isArray(next[key])) continue;
      const migrated = next[key].map((entry) => {
        const escaped = escape(entry);
        if (escaped !== entry) changed = true;
        return escaped;
      });
      next[key] = migrated;
    }

    if (changed) await browserAPI.storage.local.set({ [SETTINGS_KEY]: next });
    await browserAPI.storage.local.set({ [COMMENT_MIGRATION_KEY]: true });
  } catch (_) {
    // A failed migration must not stop the options page from opening. It will be
    // retried next time, since the flag is only set on success.
  }
}

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await browserAPI.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.customPatterns = Array.isArray(merged.customPatterns) ? [...merged.customPatterns] : [];
  merged.customKeywordList = Array.isArray(merged.customKeywordList) ? [...merged.customKeywordList] : [];
  merged.trustedImageDomains = Array.isArray(merged.trustedImageDomains) ? [...merged.trustedImageDomains] : [];
  merged.debugMode = merged.debugMode === true;
  return merged;
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

// --- Access code challenge -------------------------------------------------
//
// The rules, the charset, the config shape and the paste guards all live in
// shared/access-code.js so the popup enforces exactly the same layer (issue
// #29). Only the modal chrome is page-specific.
const AccessCode = self.AccessCode;
const ACCESS_CODE_LENGTHS = AccessCode.LENGTHS;

function normalizeAccessCodeConfig(raw) {
  return AccessCode.normalizeConfig(raw);
}

function accessCodeRequiredFor(config, isCritical) {
  return AccessCode.requiredFor(config, isCritical);
}

function generateAccessCode(length) {
  return AccessCode.generate(length);
}

async function getAccessCodeConfig() {
  return await AccessCode.readConfig(browserAPI.storage.local);
}

async function setAccessCodeConfig(config) {
  await AccessCode.writeConfig(browserAPI.storage.local, config);
}

async function showAccessCodeModal(actionLabel = 'this action') {
  const { length } = await getAccessCodeConfig();
  let expected = generateAccessCode(length);

  const modalPromise = createModal({
    icon: '⌨️',
    title: 'Access Code Required',
    description: `Type the code below exactly to ${actionLabel}.`,
    bodyHTML: `
      <div class="access-code-display" id="modal-access-code">${expected}</div>
      <input type="text" class="pin-input access-code-input" id="modal-access-code-input"
             placeholder="Type the code above" autocomplete="off" autocorrect="off"
             autocapitalize="off" spellcheck="false">
      <div class="pin-hint" id="modal-access-code-hint">Copy and paste are disabled on purpose.</div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: false },
      {
        text: 'Unlock',
        type: 'primary',
        onClick: () => {
          const input = document.getElementById('modal-access-code-input');
          const display = document.getElementById('modal-access-code');
          const hint = document.getElementById('modal-access-code-hint');
          if (!input) return false;

          if (input.value === expected) return true;

          // Wrong: issue a fresh code so the attempt can't be chipped away at.
          expected = generateAccessCode(length);
          if (display) display.textContent = expected;
          input.value = '';
          input.classList.add('error');
          setTimeout(() => input.classList.remove('error'), 500);
          if (hint) {
            hint.textContent = "❌ That didn't match. Here's a new code.";
            hint.className = 'pin-hint error';
          }
          return false; // keep the modal open
        }
      }
    ]
  });

  // Wait for the modal to reach the DOM before wiring the guards.
  await new Promise(resolve => setTimeout(resolve, 50));

  // Refuses paste/drop into the box and copy off the display — the feature is
  // worthless if the code can be moved across in two seconds.
  AccessCode.hardenEntry(
    document.getElementById('modal-access-code-input'),
    document.getElementById('modal-access-code')
  );

  return (await modalPromise) === true;
}

// Runs after the PIN check, so the two layers stack rather than replace.
// `critical` marks the master switches — see SCOPES in shared/access-code.js.
async function requireAccessCodeIfEnabled(actionLabel = 'this action', critical = false) {
  const config = await getAccessCodeConfig();
  if (!accessCodeRequiredFor(config, critical)) return true;
  return await showAccessCodeModal(actionLabel);
}

async function requirePIN(actionLabel = 'this action', opts) {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  const verified = await showVerifyPINModal(actionLabel);
  if (verified !== true) return false;
  return await requireAccessCodeIfEnabled(actionLabel, !!(opts && opts.critical));
}

// Only require PIN if one is already set (doesn't prompt to create one).
// The access code stands on its own, so it still applies when no PIN is set.
async function requirePINIfSet(actionLabel = 'this action', opts) {
  const stored = await getPIN();
  if (stored) {
    const verified = await showVerifyPINModal(actionLabel);
    if (verified !== true) return false;
  }
  return await requireAccessCodeIfEnabled(actionLabel, !!(opts && opts.critical));
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

// One line per entry, tidied on save: blank lines dropped, duplicates removed,
// then sorted A-Z. Dedup is case-insensitive because every consumer of these
// lists (keyword matching, domain matching) is case-insensitive too, so
// "Apricot" and "apricot" are the same entry — the first spelling wins.
// Pasting a long list is the normal way people fill these in, so it arrives
// unsorted and with repeats; cleaning it here keeps the stored list readable.
function isCommentLine(entry) {
  if (typeof KeywordPattern !== 'undefined' && KeywordPattern.isCommentEntry) {
    return KeywordPattern.isCommentEntry(entry);
  }
  const value = String(entry || '').trim();
  return !!value && (value.charAt(0) === '#' || value.charAt(0) === '!');
}

/**
 * Normalise a list box into what gets stored: blank lines dropped, entries
 * de-duplicated case-insensitively, and the whole thing sorted A–Z.
 *
 * Comments make the sort more than a sort. A note is almost always a heading for
 * the lines under it — `# === Social ===` — so sorting the lines individually
 * would strand every comment away from the group it labels. Entries are
 * therefore sorted in *blocks*: the comments immediately above an entry travel
 * with it. Comments are never de-duplicated, since two `# ---` rules are both
 * meant to be there, and trailing comments with no entry after them stay at the
 * end where they were written.
 */
/**
 * What an entry is filed under. Leading punctuation is skipped, so `/apricots?/`
 * files under "a" beside the literal it stands in for rather than under "/".
 *
 * Sorting on the raw text put every `/regex/` entry in a clump above the whole
 * list — above the notes written at the top of it, because a note travels with
 * the entry beneath it and that entry had been overtaken. The locale order for
 * the three markers involved is `!` then `/` then `#`, which is why the result
 * read as arbitrary.
 */
function entrySortKey(entry) {
  const value = String(entry || '').trim();
  const stripped = value.replace(/^[^\p{L}\p{N}]+/u, '');
  // An entry made only of punctuation keeps its own text, so it still sorts
  // somewhere predictable instead of collapsing to an empty key.
  return stripped || value;
}

function serializePatterns(text) {
  const byKey = new Map();
  const blocks = [];
  let pendingComments = [];

  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;

    if (isCommentLine(entry)) {
      pendingComments.push(entry);
      continue;
    }

    const key = entry.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      // The entry is a duplicate and goes, but the note above it describes that
      // same entry — so it joins the block that already owns it rather than
      // being dropped or drifting onto whatever sorts next.
      for (const comment of pendingComments) {
        if (!existing.comments.includes(comment)) existing.comments.push(comment);
      }
      pendingComments = [];
      continue;
    }

    const block = { entry, comments: pendingComments };
    byKey.set(key, block);
    blocks.push(block);
    pendingComments = [];
  }

  blocks.sort((a, b) => {
    const byName = entrySortKey(a.entry).localeCompare(
      entrySortKey(b.entry), undefined, { sensitivity: 'base' }
    );
    // `/porn/` and `porn` file under the same name; compare the raw text so the
    // order of the pair is settled rather than left to the sort's stability.
    return byName !== 0
      ? byName
      : a.entry.localeCompare(b.entry, undefined, { sensitivity: 'base' });
  });

  const out = [];
  for (const block of blocks) {
    for (const comment of block.comments) out.push(comment);
    out.push(block.entry);
  }
  // Comments after the last entry belong to nothing; keep them rather than lose
  // what someone typed.
  for (const comment of pendingComments) out.push(comment);
  return out;
}

/** Entries only — what the counts shown to the user should reflect. */
function countRealEntries(list) {
  return (list || []).filter((entry) => entry && !isCommentLine(entry)).length;
}

function deserializePatterns(list) {
  return (list || []).join('\n');
}

// --- note lines dimmed inside the list boxes --------------------------------
// A textarea paints all of its text in one colour, so the notes and the entries
// cannot be told apart at a glance. Each list box is therefore two layers: a
// <pre> mirror that paints the text with the notes dimmed, and the textarea
// itself on top with transparent text, still doing the typing, selecting,
// undo and spellcheck it always did. Nothing here changes what gets saved.

/** Repaint one mirror. Text goes in as text, never as markup. */
function paintListMirror(textarea, mirror) {
  const lines = String(textarea.value || '').split('\n');
  const frag = document.createDocumentFragment();

  lines.forEach((line, index) => {
    const span = document.createElement('span');
    if (isCommentLine(line)) span.className = 'is-note';
    span.textContent = line;
    frag.appendChild(span);
    // Keep the line breaks between the spans so the mirror wraps and grows
    // exactly as the textarea does.
    if (index < lines.length - 1) frag.appendChild(document.createTextNode('\n'));
  });

  mirror.replaceChildren(frag);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
}

function setupListSyntaxHighlighting() {
  const boxes = document.querySelectorAll('.textarea-syntax > .textarea');

  boxes.forEach((textarea) => {
    const mirror = textarea.parentElement.querySelector('.textarea-syntax__mirror');
    if (!mirror) return;

    const paint = () => paintListMirror(textarea, mirror);

    textarea.addEventListener('input', paint);
    textarea.addEventListener('scroll', () => {
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    });

    // Loading settings, importing a file and resetting all assign to `.value`,
    // which fires no event. Rather than have every one of those call sites
    // remember to repaint — and a future one forget — the setter is wrapped on
    // this element so any assignment repaints itself.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(textarea, 'value', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(next) {
          descriptor.set.call(this, next);
          paint();
        }
      });
    }

    paint();
  });
}

// Blocked words may be `/regex/` entries. A broken or pathologically slow one
// must never reach storage: the content script runs these against every page,
// so the moment to catch it is here, while the user is looking at the box and
// can fix it. Literal entries can never fail, so they never block a save.
function findKeywordPatternError(entries) {
  if (typeof KeywordPattern === 'undefined') return null;
  for (let i = 0; i < entries.length; i++) {
    const result = KeywordPattern.validateEntry(entries[i]);
    if (!result.ok && result.isRegex) {
      return { entry: entries[i], error: result.error };
    }
  }
  return null;
}

// Same check for the blocked-site list, which also accepts `/regex/` and
// `title/regex/` entries. Wildcard entries can never fail, so they never block
// a save.
function findBlocklistPatternError(entries) {
  if (typeof KeywordPattern === 'undefined' || !KeywordPattern.validateListEntry) return null;
  for (let i = 0; i < entries.length; i++) {
    const result = KeywordPattern.validateListEntry(entries[i]);
    if (!result.ok && result.kind !== 'wildcard' && result.kind !== 'empty') {
      return { entry: entries[i], error: result.error };
    }
  }
  return null;
}

// ---- List import / export -------------------------------------------------
//
// One entry per line, which is both a plain text list and a valid single-column
// CSV, so the same file opens in a spreadsheet and pastes straight back into
// the box. Import accepts either extension.
//
// Quoting matters here because blocked *words* can be phrases containing
// commas. Export quotes per RFC 4180 and import understands those quotes, so a
// phrase survives a round trip instead of being split in half.

const MAX_IMPORT_BYTES = 1024 * 1024;

function csvEscapeEntry(entry) {
  const value = String(entry);
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

function serializeListFile(entries) {
  return (Array.isArray(entries) ? entries : []).map(csvEscapeEntry).join('\r\n');
}

// Parses one entry per line. A quoted field may span lines and contain commas;
// an unquoted line is taken whole (so an unquoted "hello, world" stays one
// entry rather than becoming two, which is what a list user means).
function parseListFile(text) {
  const source = String(text || '').replace(/^﻿/, ''); // strip BOM
  const entries = [];
  let i = 0;
  while (i < source.length) {
    // Skip line breaks between records.
    if (source[i] === '\r' || source[i] === '\n') { i++; continue; }
    let value = '';
    if (source[i] === '"') {
      i++;
      for (; i < source.length; i++) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') { value += '"'; i++; continue; } // escaped
          i++;
          break;
        }
        value += source[i];
      }
      // Ignore anything trailing the closing quote up to the line break.
      while (i < source.length && source[i] !== '\r' && source[i] !== '\n') i++;
    } else {
      const end = source.indexOf('\n', i);
      const line = end === -1 ? source.slice(i) : source.slice(i, end);
      value = line;
      i = end === -1 ? source.length : end + 1;
    }
    const trimmed = value.trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function listExportFilename(label) {
  return `blocknsfw-${label}-${new Date().toISOString().split('T')[0]}.csv`;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsText(file);
  });
}

// Protection-strength helpers. The rule across the whole options page: changes
// that TIGHTEN protection are always free, changes that LOOSEN it go through
// the PIN. Adding a blocked pattern/word tightens; removing one loosens.
// Trusted image domains are the inverse — they're exempt from AI scanning, so
// ADDING one loosens protection.
// Compared case-insensitively, matching how these lists are actually used:
// dropping "apple" while "Apple" remains blocks exactly as much as before, so
// it must not count as a removal (serializePatterns collapses such pairs on
// save, and a spurious PIN prompt there would be confusing).
function normalizeEntries(list) {
  return new Set((Array.isArray(list) ? list : []).map(item => String(item).toLowerCase()));
}

function hasRemovals(prev, next) {
  const nextSet = normalizeEntries(next);
  return [...normalizeEntries(prev)].some(item => !nextSet.has(item));
}

function hasAdditions(prev, next) {
  const prevSet = normalizeEntries(prev);
  return [...normalizeEntries(next)].some(item => !prevSet.has(item));
}

// Ordered weakest → strongest so a dropdown change can be classified.
const IMAGE_FILTER_RANK = { lenient: 0, moderate: 1, strict: 2 };
const AI_STRICTNESS_RANK = { relaxed: 0, balanced: 1, strict: 2 };

function weakensImageFilter(prev, next) {
  return IMAGE_FILTER_RANK[normalizeImageFilterLevel(next)] < IMAGE_FILTER_RANK[normalizeImageFilterLevel(prev)];
}

function weakensAiStrictness(prev, next) {
  return AI_STRICTNESS_RANK[normalizeAiStrictness(next)] < AI_STRICTNESS_RANK[normalizeAiStrictness(prev)];
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

// Domain validation lives in shared/validate-domain.js (loaded before this
// script in options.html) so the popup and options page stay in sync.
function validateDomain(domain) {
  return self.DomainValidate.validateDomain(domain);
}

// --- Subscribed lists --------------------------------------------------------

function subscriptionStatusText(subscription) {
  if (subscription.error) return `Update failed: ${subscription.error}`;
  if (!subscription.updatedAt) return 'Not downloaded yet';

  const when = new Date(subscription.updatedAt).toLocaleString();
  const count = subscription.entryCount || 0;
  let text = `${count.toLocaleString()} ${count === 1 ? 'rule' : 'rules'} · updated ${when}`;
  // Say so out loud rather than quietly applying a partial list.
  if (subscription.truncated) text += ' · list was too long and was cut short';
  if (subscription.skipped) text += ` · ${subscription.skipped} unusable ${subscription.skipped === 1 ? 'line' : 'lines'} skipped`;
  return text;
}

async function renderSubscriptions() {
  const container = $('subscription-list');
  if (!container) return;

  let subscriptions = [];
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'subscription_list' });
    subscriptions = (response && response.subscriptions) || [];
  } catch (_) {
    subscriptions = [];
  }

  container.innerHTML = '';
  if (subscriptions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'whitelist-empty';
    empty.textContent = 'No subscriptions yet.';
    container.appendChild(empty);
    return;
  }

  subscriptions.forEach((subscription) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 8px;border-bottom:1px solid color-mix(in oklab,CanvasText,transparent 85%);';

    const info = document.createElement('div');
    info.style.cssText = 'min-width:0;flex:1;';

    const name = document.createElement('strong');
    name.textContent = subscription.name || subscription.url;
    name.style.cssText = 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    if (subscription.enabled === false) name.style.opacity = '0.55';
    info.appendChild(name);

    const url = document.createElement('div');
    url.textContent = subscription.url;
    url.style.cssText = 'font-size:0.78rem;opacity:0.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    info.appendChild(url);

    const status = document.createElement('div');
    status.textContent = subscriptionStatusText(subscription);
    status.style.cssText = `font-size:0.78rem;margin-top:2px;${subscription.error ? 'color:var(--error-color,#ef4444);' : 'opacity:0.65;'}`;
    info.appendChild(status);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

    const toggle = document.createElement('button');
    toggle.className = 'button';
    toggle.textContent = subscription.enabled === false ? 'Enable' : 'Disable';
    toggle.addEventListener('click', async () => {
      // Turning a list off stops it blocking, which is a protection-weakening
      // change and gated like every other one. Turning it back on is not.
      if (subscription.enabled !== false) {
        const allowed = await requirePINIfSet('disable this subscribed list');
        if (!allowed) return;
      }
      await browserAPI.runtime.sendMessage({
        type: 'subscription_toggle',
        id: subscription.id,
        enabled: subscription.enabled === false
      });
      await renderSubscriptions();
    });
    actions.appendChild(toggle);

    const remove = document.createElement('button');
    remove.className = 'button button-destructive';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const allowed = await requirePINIfSet('remove this subscribed list');
      if (!allowed) return;
      const confirmed = await showConfirmModal({
        title: 'Remove this list?',
        description: `${subscription.name || subscription.url} currently blocks ${(subscription.entryCount || 0).toLocaleString()} entries. Removing it stops all of them.`,
        confirmText: 'Remove',
        destructive: true
      });
      if (!confirmed) return;
      await browserAPI.runtime.sendMessage({ type: 'subscription_remove', id: subscription.id });
      showToast('Subscription removed', 'success');
      await renderSubscriptions();
    });
    actions.appendChild(remove);

    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  });
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
    domainStrong.textContent = item.path ? item.domain + item.path : item.domain;

    const dateDiv = document.createElement('div');
    dateDiv.style.cssText = 'font-size:12px;color:GrayText;';
    dateDiv.textContent = item.path ? `Page only · Added ${addedDate}` : `Added ${addedDate}`;

    infoDiv.appendChild(domainStrong);
    infoDiv.appendChild(dateDiv);

    const removeButton = document.createElement('button');
    removeButton.textContent = 'Remove';
    removeButton.style.cssText = 'background:#d32f2f;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;';
    removeButton.onclick = () => removeWhitelistItem(item.domain, item.path || null);
    
    itemDiv.appendChild(infoDiv);
    itemDiv.appendChild(removeButton);
    container.appendChild(itemDiv);
  });
}

window.removeWhitelistItem = async function(domain, path = null) {
  const whitelist = await getWhitelist();
  const filtered = whitelist.filter(item => !(item.domain === domain && (item.path || null) === (path || null)));
  await setWhitelist(filtered);
  await renderWhitelist();
}

const SEARCH_RESULT_TREATMENT_DETAIL = {
  hide: 'Blocked results are removed. A summary line above the results says how many.',
  overlay: 'Each blocked result is replaced with a card. Image and video results are always removed — the card needs a full-width row and cannot fit a grid tile.'
};

function normalizeSearchResultTreatment(treatment) {
  return String(treatment || '').toLowerCase() === 'overlay' ? 'overlay' : 'hide';
}

const BLOCK_COUNT_DISPLAY_DETAIL = {
  badge: "A number on the extension's toolbar icon counts what was blocked in each tab. Hidden if the icon is not pinned — Chrome tucks unpinned extensions behind the puzzle-piece menu.",
  floating: 'A small pill in the corner of the page shows the count. Click it to list the sites that were blocked; the listed sites are not links and lead nowhere.'
};

function normalizeBlockCountDisplay(display) {
  return String(display || '').toLowerCase() === 'floating' ? 'floating' : 'badge';
}

/**
 * The treatment picker plus the summary-line switch. Kept together because the
 * summary is what accounts for blocked results once they stop announcing
 * themselves individually — turning both off means a search page shows no trace
 * of the extension at all, which is a legitimate choice but worth stating.
 */
function renderSearchResultTreatment(settings) {
  const select = $('search-result-treatment');
  const detail = $('search-result-treatment-detail');
  const treatment = normalizeSearchResultTreatment(settings.searchResultTreatment);
  if (select) select.value = treatment;
  if (detail) detail.textContent = SEARCH_RESULT_TREATMENT_DETAIL[treatment];

  const summary = $('search-summary-enabled');
  if (summary) summary.checked = settings.searchSummaryEnabled !== false;

  const display = normalizeBlockCountDisplay(settings.blockCountDisplay);
  const displaySelect = $('block-count-display');
  if (displaySelect) displaySelect.value = display;
  const displayDetail = $('block-count-display-detail');
  if (displayDetail) displayDetail.textContent = BLOCK_COUNT_DISPLAY_DETAIL[display];
}

/**
 * Prompt to pin the toolbar icon, but only when it is genuinely unpinned — the
 * badge is invisible behind Chrome's puzzle-piece menu, and no API can pin it for
 * the user, so asking is the only option. Firefox has no getUserSettings, so
 * there the banner is shown once and dismissed for good.
 */
async function renderPinBanner() {
  const banner = $('pin-banner');
  if (!banner) return;
  try {
    const { [PIN_BANNER_DISMISSED_KEY]: dismissed } =
      await browserAPI.storage.local.get(PIN_BANNER_DISMISSED_KEY);
    if (dismissed) { banner.classList.add('hidden'); return; }

    // Only worth nagging about while the count is meant to be on the icon.
    const settings = await getSettings();
    if (normalizeBlockCountDisplay(settings.blockCountDisplay) !== 'badge') {
      banner.classList.add('hidden');
      return;
    }

    let pinned = null; // null = cannot tell
    try {
      if (browserAPI.action && typeof browserAPI.action.getUserSettings === 'function') {
        const userSettings = await browserAPI.action.getUserSettings();
        if (userSettings && typeof userSettings.isOnToolbar === 'boolean') {
          pinned = userSettings.isOnToolbar;
        }
      }
    } catch (_) {
      // Unsupported in this browser; fall through to showing it once.
    }

    if (pinned === true) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
  } catch (_) {
    banner.classList.add('hidden');
  }
}

async function dismissPinBanner() {
  try {
    await browserAPI.storage.local.set({ [PIN_BANNER_DISMISSED_KEY]: true });
  } catch (_) {}
  const banner = $('pin-banner');
  if (banner) banner.classList.add('hidden');
}

async function render() {
  const settings = await getSettings();
  const stats = await getStats();
  const pin = await getPIN();

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
  renderSearchResultTreatment(settings);

  const aboutVersion = $('about-version');
  const whatsNewVersion = $('whats-new-version');
  if (aboutVersion || whatsNewVersion) {
    let version = '';
    try {
      version = browserAPI.runtime.getManifest().version;
    } catch (_) {
      version = '';
    }
    if (aboutVersion) aboutVersion.textContent = version ? `version ${version}` : 'this version';
    // The highlights below the heading are written for one release. Stamping the
    // running version on it means a stale card is visible as stale rather than
    // reading as current, which is how the 1.7.4 list survived into 1.7.5.
    if (whatsNewVersion) whatsNewVersion.textContent = version ? `in ${version}` : '';
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

  const accessCode = await getAccessCodeConfig();
  const accessCodeToggle = $('access-code-enabled');
  if (accessCodeToggle) accessCodeToggle.checked = accessCode.enabled;
  const accessCodeLength = $('access-code-length');
  if (accessCodeLength) accessCodeLength.value = String(accessCode.length);
  const accessCodeScope = $('access-code-scope-all');
  if (accessCodeScope) accessCodeScope.checked = accessCode.scope === 'all';

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

  // Render AI Image Blocker
  const aiImageBlockerOn = settings.aiImageBlocker !== false;
  const aiImageBlockerToggle = $('ai-image-blocker');
  if (aiImageBlockerToggle) {
    aiImageBlockerToggle.checked = aiImageBlockerOn;
  }
  const aiImageBlockerBadge = $('ai-image-blocker-status');
  if (aiImageBlockerBadge) {
    if (aiImageBlockerOn) {
      aiImageBlockerBadge.textContent = '🖼 AI Blocker: Active';
      aiImageBlockerBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      aiImageBlockerBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      aiImageBlockerBadge.style.color = 'var(--success)';
    } else {
      aiImageBlockerBadge.textContent = '🖼 AI Blocker: Off';
      aiImageBlockerBadge.style.background = '';
      aiImageBlockerBadge.style.borderColor = '';
      aiImageBlockerBadge.style.color = '';
    }
  }
  const aiImageScanAllToggle = $('ai-image-scan-all');
  if (aiImageScanAllToggle) {
    aiImageScanAllToggle.checked = settings.aiImageScanAllSites !== false;
  }
  const aiStrictness = normalizeAiStrictness(settings.aiStrictness);
  const aiStrictnessSelect = $('ai-strictness');
  if (aiStrictnessSelect) {
    aiStrictnessSelect.value = aiStrictness;
  }
  const aiStrictnessDetail = $('ai-strictness-detail');
  if (aiStrictnessDetail) {
    aiStrictnessDetail.textContent = getAiStrictnessMeta(aiStrictness).detail;
  }

  const aiTextBlockerOn = settings.aiTextBlocker !== false;
  const aiTextBlockerToggle = $('ai-text-blocker');
  if (aiTextBlockerToggle) {
    aiTextBlockerToggle.checked = aiTextBlockerOn;
  }
  const aiTextBlockerBadge = $('ai-text-blocker-status');
  if (aiTextBlockerBadge) {
    if (aiTextBlockerOn) {
      aiTextBlockerBadge.textContent = '📝 AI Text Blocker: Active';
      aiTextBlockerBadge.style.background = 'rgba(16, 185, 129, 0.1)';
      aiTextBlockerBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      aiTextBlockerBadge.style.color = 'var(--success)';
    } else {
      aiTextBlockerBadge.textContent = '📝 AI Text Blocker: Off';
      aiTextBlockerBadge.style.background = '';
      aiTextBlockerBadge.style.borderColor = '';
      aiTextBlockerBadge.style.color = '';
    }
  }
  const aiTextStrictness = normalizeAiStrictness(settings.aiTextStrictness);
  const aiTextStrictnessSelect = $('ai-text-strictness');
  if (aiTextStrictnessSelect) {
    aiTextStrictnessSelect.value = aiTextStrictness;
  }
  const aiTextStrictnessDetail = $('ai-text-strictness-detail');
  if (aiTextStrictnessDetail) {
    aiTextStrictnessDetail.textContent = getAiTextStrictnessMeta(aiTextStrictness).detail;
  }

  // Render custom blocked page settings
  const useCustom = settings.blockedPageType === 'custom';
  const usePlain = settings.blockedPageType === 'plain_html';
  $('use-custom-blocked-page').checked = useCustom;
  $('use-plain-html-blocked-page').checked = usePlain;
  $('custom-blocked-page-url').value = settings.customBlockedPageUrl || '';
  $('custom-blocked-page-section').style.display = useCustom ? 'block' : 'none';
  $('plain-blocked-page-section').style.display = usePlain ? 'block' : 'none';
  plainHtmlAvailable = !!(settings.plainBlockedPageHtml && settings.plainBlockedPageHtml.trim());
  const plainStatus = $('plain-html-status');
  if (plainStatus) {
    plainStatus.textContent = plainHtmlAvailable
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
  await renderSubscriptions();
  applySubscribeQueryParam();
}

/**
 * A subscribe link opens Settings with ?subscribe=<url>. The address is filled
 * into the box and the section scrolled to, but nothing is added — the user
 * still presses Subscribe. A page that can link here must not be able to change
 * what gets blocked on its own.
 */
function applySubscribeQueryParam() {
  try {
    const requested = new URLSearchParams(window.location.search).get('subscribe');
    if (!requested || !/^https?:\/\//i.test(requested)) return;

    const input = $('subscription-url');
    if (!input || input.value) return;
    input.value = requested;

    const hint = $('subscription-hint');
    if (hint) hint.textContent = 'Filled in from a subscribe link. Check the address, then press Subscribe.';
    input.scrollIntoView({ block: 'center' });
    input.focus();
  } catch (_) {}
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

// --- Update-available banner ---------------------------------------------
// The background service worker fetches version.json, compares it to the
// installed version, and writes the verdict to UPDATE_INFO_KEY. We just render
// it and remember dismissals per-version.
async function renderUpdateBanner() {
  const banner = $('update-banner');
  if (!banner) return;
  try {
    const store = await browserAPI.storage.local.get([UPDATE_INFO_KEY, UPDATE_DISMISSED_KEY]);
    const info = store[UPDATE_INFO_KEY];
    const dismissed = store[UPDATE_DISMISSED_KEY];
    const show = info && info.updateAvailable && info.latest && info.latest !== dismissed;
    if (!show) { banner.classList.add('hidden'); return; }

    const sub = $('update-banner-sub');
    if (sub) {
      const notes = (typeof info.notes === 'string' && info.notes.trim())
        ? ' — ' + info.notes.trim() : '';
      sub.textContent = `You're on v${info.current}. Version v${info.latest} is available${notes}`;
    }
    const link = $('update-banner-link');
    if (link) link.href = info.url || 'https://github.com/codepurse/BlockNSFW/releases';
    banner.classList.remove('hidden');
  } catch (_) {
    banner.classList.add('hidden');
  }
}

async function dismissUpdateBanner() {
  try {
    const { [UPDATE_INFO_KEY]: info } = await browserAPI.storage.local.get(UPDATE_INFO_KEY);
    if (info && info.latest) {
      await browserAPI.storage.local.set({ [UPDATE_DISMISSED_KEY]: info.latest });
    }
  } catch (_) {}
  const banner = $('update-banner');
  if (banner) banner.classList.add('hidden');
}

function requestUpdateCheck() {
  try {
    browserAPI.runtime.sendMessage({ type: 'get_update_info' }, () => {
      void browserAPI.runtime.lastError;
    });
  } catch (_) {}
}

// --- Remote info banner ----------------------------------------------------
// The background worker fetches data/announcement.json from the repo and writes
// the payload to ANNOUNCEMENT_INFO_KEY. We render it as a dismissible info
// banner and remember dismissals per announcement id — bump the id in the repo
// to re-show it after someone has dismissed the previous one.
async function renderAnnouncementBanner() {
  const banner = $('info-banner');
  if (!banner) return;
  try {
    const store = await browserAPI.storage.local.get([ANNOUNCEMENT_INFO_KEY, ANNOUNCEMENT_DISMISSED_KEY]);
    const info = store[ANNOUNCEMENT_INFO_KEY];
    const dismissed = store[ANNOUNCEMENT_DISMISSED_KEY];
    const show = info && info.enabled && info.id && info.message && info.id !== dismissed;
    if (!show) { banner.classList.add('hidden'); return; }

    // Reset then apply the type accent (info | warning | success).
    banner.classList.remove('type-info', 'type-warning', 'type-success');
    banner.classList.add(`type-${info.type || 'info'}`);

    const title = $('info-banner-title');
    if (title) title.textContent = info.title || 'Announcement';

    // Rendered as text (not innerHTML) — the message is remote content.
    const sub = $('info-banner-sub');
    if (sub) sub.textContent = info.message;

    const link = $('info-banner-link');
    if (link) {
      if (info.link) {
        link.href = info.link;
        link.textContent = info.linkText || 'Learn more';
        link.classList.remove('hidden');
      } else {
        link.classList.add('hidden');
      }
    }
    banner.classList.remove('hidden');
  } catch (_) {
    banner.classList.add('hidden');
  }
}

async function dismissAnnouncementBanner() {
  try {
    const { [ANNOUNCEMENT_INFO_KEY]: info } = await browserAPI.storage.local.get(ANNOUNCEMENT_INFO_KEY);
    if (info && info.id) {
      await browserAPI.storage.local.set({ [ANNOUNCEMENT_DISMISSED_KEY]: info.id });
    }
  } catch (_) {}
  const banner = $('info-banner');
  if (banner) banner.classList.add('hidden');
}

function requestAnnouncement() {
  try {
    // forceRefresh bypasses the background's 6h TTL: opening this page always
    // pulls the latest announcement.json (it's tiny), so edits go live for the
    // user on their next Settings visit instead of waiting out the cache.
    browserAPI.runtime.sendMessage({ type: 'get_announcement', forceRefresh: true }, () => {
      void browserAPI.runtime.lastError;
      // Re-render once the refreshed payload has landed in storage.
      renderAnnouncementBanner();
    });
  } catch (_) {}
}

async function init() {
  // Before the first render, so the boxes never show an unmigrated list.
  await migrateCommentSyntaxOnce();
  // Before render() too, so the first list painted is already highlighted.
  setupListSyntaxHighlighting();
  await render();

  // Update-available banner
  const dismissBtn = $('update-banner-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', dismissUpdateBanner);
  await renderUpdateBanner();
  requestUpdateCheck();

  // Remote info/announcement banner
  const infoDismissBtn = $('info-banner-dismiss');
  if (infoDismissBtn) infoDismissBtn.addEventListener('click', dismissAnnouncementBanner);
  await renderAnnouncementBanner();
  requestAnnouncement();

  // Toolbar pin prompt
  const pinDismissBtn = $('pin-banner-dismiss');
  if (pinDismissBtn) pinDismissBtn.addEventListener('click', dismissPinBanner);
  await renderPinBanner();

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
      const ok = await requirePINIfSet('disable blocking', { critical: true });
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
      const nextLevel = normalizeImageFilterLevel(e.target.value);
      // Raising the level is free; lowering it loosens protection.
      if (weakensImageFilter(settings.imageFilterLevel, nextLevel)) {
        const ok = await requirePINIfSet('lower image filtering');
        if (!ok) {
          e.target.value = normalizeImageFilterLevel(settings.imageFilterLevel);
          return;
        }
      }
      settings.imageFilterLevel = nextLevel;
      await setSettings(settings);
      const detail = $('image-filter-level-detail');
      if (detail) {
        detail.textContent = getImageFilterLevelMeta(settings.imageFilterLevel).detail;
      }
      showToast(`Image filtering set to ${getImageFilterLevelMeta(settings.imageFilterLevel).label}`, 'success');
    });
  }

  const aiStrictnessEl = $('ai-strictness');
  if (aiStrictnessEl) {
    aiStrictnessEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      const nextStrictness = normalizeAiStrictness(e.target.value);
      if (weakensAiStrictness(settings.aiStrictness, nextStrictness)) {
        const ok = await requirePINIfSet('lower AI image strictness');
        if (!ok) {
          e.target.value = normalizeAiStrictness(settings.aiStrictness);
          return;
        }
      }
      settings.aiStrictness = nextStrictness;
      await setSettings(settings);
      const detail = $('ai-strictness-detail');
      if (detail) {
        detail.textContent = getAiStrictnessMeta(settings.aiStrictness).detail;
      }
      // Drop cached verdicts so the new thresholds apply without a restart.
      try { await browserAPI.storage.session.remove('pblocker_ai_image_cache_v1'); } catch (_) {}
      showToast(`AI strictness set to ${getAiStrictnessMeta(settings.aiStrictness).label}`, 'success');
    });
  }

  const aiTextStrictnessEl = $('ai-text-strictness');
  if (aiTextStrictnessEl) {
    aiTextStrictnessEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      const nextStrictness = normalizeAiStrictness(e.target.value);
      if (weakensAiStrictness(settings.aiTextStrictness, nextStrictness)) {
        const ok = await requirePINIfSet('lower AI text strictness');
        if (!ok) {
          e.target.value = normalizeAiStrictness(settings.aiTextStrictness);
          return;
        }
      }
      settings.aiTextStrictness = nextStrictness;
      await setSettings(settings);
      const detail = $('ai-text-strictness-detail');
      if (detail) {
        detail.textContent = getAiTextStrictnessMeta(settings.aiTextStrictness).detail;
      }
      showToast(`AI text strictness set to ${getAiTextStrictnessMeta(settings.aiTextStrictness).label}`, 'success');
    });
  }

  // DNS Protection toggle
  const dnsFilterToggle = $('dns-filter-enabled');
  if (dnsFilterToggle) {
    dnsFilterToggle.addEventListener('change', async (e) => {
      const settings = await getSettings();
      // Turning DNS protection off removes a blocking layer, so it's gated
      // like every other weakening toggle. Turning it on stays free.
      if (settings.dnsFilterEnabled === true && !e.target.checked) {
        const ok = await requirePINIfSet('turn off DNS Protection');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
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
          ? 'Safe Search enforced on Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Qwant, AOL Search, Presearch & Yandex'
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

  const aiImageBlockerEl = $('ai-image-blocker');
  if (aiImageBlockerEl) {
    aiImageBlockerEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.aiImageBlocker !== false && !e.target.checked) {
        const ok = await requirePINIfSet('turn off AI image blocker');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.aiImageBlocker = e.target.checked;
      await setSettings(settings);
      await render();
    });
  }

  const aiImageScanAllEl = $('ai-image-scan-all');
  if (aiImageScanAllEl) {
    aiImageScanAllEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      // Turning this off narrows coverage, so gate it behind the PIN if set.
      if (settings.aiImageScanAllSites !== false && !e.target.checked) {
        const ok = await requirePINIfSet('limit AI image scanning to third-party images');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.aiImageScanAllSites = e.target.checked;
      await setSettings(settings);
      await render();
    });
  }

  const aiTextBlockerEl = $('ai-text-blocker');
  if (aiTextBlockerEl) {
    aiTextBlockerEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.aiTextBlocker !== false && !e.target.checked) {
        const ok = await requirePINIfSet('turn off AI text blocker');
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.aiTextBlocker = e.target.checked;
      await setSettings(settings);
      await render();
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
    // Sending blocked pages somewhere of your own choosing replaces the
    // deterrent screen, so switching away from the default is gated. Switching
    // back to the built-in page is not.
    if (e.target.checked) {
      const ok = await requirePINIfSet('use a custom blocked page');
      if (!ok) {
        e.target.checked = false;
        customSection.style.display = 'none';
        return;
      }
    }
    settings.blockedPageType = e.target.checked ? 'custom' : 'default';
    settings.customBlockedPageUrl = e.target.checked ? $('custom-blocked-page-url').value.trim() : '';
    if (e.target.checked) {
      settings.plainBlockedPageHtml = '';
    }

    await setSettings(settings);
    showToast('Blocked page settings updated', 'success');
  });

  const addSubscriptionBtn = $('add-subscription');
  if (addSubscriptionBtn) {
    addSubscriptionBtn.addEventListener('click', async () => {
      const input = $('subscription-url');
      const url = (input.value || '').trim();
      if (!url) {
        showToast('Enter the address of a ruleset file', 'warning');
        return;
      }

      addSubscriptionBtn.disabled = true;
      addSubscriptionBtn.textContent = 'Downloading…';
      try {
        const result = await browserAPI.runtime.sendMessage({ type: 'subscription_add', url });
        if (!result || !result.ok) {
          showToast((result && result.error) || 'Could not add that list', 'error');
          return;
        }
        // Adding succeeds even when the download fails, so the failure has to be
        // reported separately or a dead URL looks like it worked.
        if (result.fetch && !result.fetch.ok) {
          showToast(`Added, but the download failed: ${result.fetch.error}`, 'warning');
        } else {
          const count = (result.fetch && result.fetch.entryCount) || 0;
          showToast(`Subscribed · ${count.toLocaleString()} rules added`, 'success');
        }
        input.value = '';
        await renderSubscriptions();
      } catch (error) {
        showToast('Could not add that list', 'error');
      } finally {
        addSubscriptionBtn.disabled = false;
        addSubscriptionBtn.textContent = 'Subscribe';
      }
    });
  }

  const refreshSubscriptionsBtn = $('refresh-subscriptions');
  if (refreshSubscriptionsBtn) {
    refreshSubscriptionsBtn.addEventListener('click', async () => {
      refreshSubscriptionsBtn.disabled = true;
      refreshSubscriptionsBtn.textContent = 'Updating…';
      try {
        await browserAPI.runtime.sendMessage({ type: 'subscription_refresh' });
        await renderSubscriptions();
        showToast('Subscriptions updated', 'success');
      } catch (_) {
        showToast('Could not update subscriptions', 'error');
      } finally {
        refreshSubscriptionsBtn.disabled = false;
        refreshSubscriptionsBtn.textContent = 'Update Now';
      }
    });
  }

  $('search-result-treatment').addEventListener('change', async (e) => {
    // Presentation only — a hidden result and an overlaid one are both blocked —
    // so this is not PIN-gated. Neither option reveals anything.
    const settings = await getSettings();
    settings.searchResultTreatment = normalizeSearchResultTreatment(e.target.value);
    await setSettings(settings);
    renderSearchResultTreatment(settings);
    showToast('Blocked search result style updated', 'success');
  });

  $('search-summary-enabled').addEventListener('change', async (e) => {
    const settings = await getSettings();
    settings.searchSummaryEnabled = !!e.target.checked;
    await setSettings(settings);
    showToast(settings.searchSummaryEnabled ? 'Summary line enabled' : 'Summary line hidden', 'success');
  });

  $('block-count-display').addEventListener('change', async (e) => {
    const settings = await getSettings();
    settings.blockCountDisplay = normalizeBlockCountDisplay(e.target.value);
    await setSettings(settings);
    renderSearchResultTreatment(settings);
    // Pinning only matters while the count lives on the icon.
    await renderPinBanner();
    showToast('Block count display updated', 'success');
  });

  $('use-plain-html-blocked-page').addEventListener('change', async (e) => {
    const plainSection = $('plain-blocked-page-section');
    const customToggle = $('use-custom-blocked-page');
    const customSection = $('custom-blocked-page-section');
    const fileInput = $('plain-blocked-page-file');
    if (e.target.checked) {
      plainSection.style.display = 'block';
      if (customToggle) customToggle.checked = false;
      if (customSection) customSection.style.display = 'none';
      // No HTML stored yet: open the file picker straight away. This must run
      // before any await so it stays inside the toggle's user-gesture window,
      // otherwise the browser blocks the programmatic file dialog.
      if (!plainHtmlAvailable && fileInput) fileInput.click();
    } else {
      plainSection.style.display = 'none';
    }

    const settings = await getSettings();
    const hasHtml = !!(settings.plainBlockedPageHtml && settings.plainBlockedPageHtml.trim());
    plainHtmlAvailable = hasHtml;

    if (e.target.checked && !hasHtml) {
      // Toggle stays on and the section stays visible so the picker/button is
      // reachable, but plain-HTML mode isn't activated until a file is chosen
      // — the file 'change' handler commits blockedPageType. No toast here:
      // the open file dialog is the prompt.
      settings.blockedPageType = 'default';
      settings.customBlockedPageUrl = '';
      await setSettings(settings);
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
      const nextUrl = e.target.value.trim();
      // Repointing where blocked pages land is the same weakening as turning
      // the custom page on, so it needs the same gate.
      if (nextUrl !== (settings.customBlockedPageUrl || '')) {
        const ok = await requirePINIfSet('change the custom blocked page URL');
        if (!ok) {
          e.target.value = settings.customBlockedPageUrl || '';
          return;
        }
      }
      settings.customBlockedPageUrl = nextUrl;
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

      // Gated here rather than on the toggle: the toggle has to open the file
      // picker synchronously to stay inside its user-gesture window, and an
      // await for the PIN would break that. Nothing is stored until this
      // passes, so the effect is the same.
      const uploadOk = await requirePINIfSet('replace the blocked page with your own HTML');
      if (!uploadOk) {
        input.value = '';
        return;
      }

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
      plainHtmlAvailable = true;
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
    const customKeywords = $('custom-keywords');
    const nextKeywords = customKeywords
      ? serializePatterns(customKeywords.value)
      : (Array.isArray(settings.customKeywordList) ? settings.customKeywordList : []);
    const nextTrusted = serializePatterns($('trusted-domains').value);
    const nextImageFilterLevel = normalizeImageFilterLevel($('image-filter-level') ? $('image-filter-level').value : settings.imageFilterLevel);
    const nextAiStrictness = normalizeAiStrictness($('ai-strictness') ? $('ai-strictness').value : settings.aiStrictness);
    const nextAiTextStrictness = normalizeAiStrictness($('ai-text-strictness') ? $('ai-text-strictness').value : settings.aiTextStrictness);

    const savePatternError = findKeywordPatternError(nextKeywords);
    if (savePatternError) {
      showToast(`Blocked words: "${savePatternError.entry}" — ${savePatternError.error}`, 'error');
      return;
    }

    const blocklistError = findBlocklistPatternError(nextCustomPatterns);
    if (blocklistError) {
      showToast(`Blocklist: "${blocklistError.entry}" — ${blocklistError.error}`, 'error');
      return;
    }

    // Adding to a blocklist only tightens protection, so it never needs the
    // PIN. Anything that loosens protection is gated — mirroring the popup's
    // append-only "Block" button (#11). One prompt covers the whole save; the
    // label names the first weakening change found so the reason is clear.
    let weakenLabel = '';
    if (hasRemovals(settings.customPatterns, nextCustomPatterns)) {
      weakenLabel = 'remove from custom blocklist';
    } else if (hasRemovals(settings.customKeywordList, nextKeywords)) {
      weakenLabel = 'remove custom blocked words';
    } else if (hasAdditions(settings.trustedImageDomains, nextTrusted)) {
      weakenLabel = 'add a trusted image domain';
    } else if (weakensImageFilter(settings.imageFilterLevel, nextImageFilterLevel)) {
      weakenLabel = 'lower image filtering';
    } else if (weakensAiStrictness(settings.aiStrictness, nextAiStrictness)) {
      weakenLabel = 'lower AI image strictness';
    } else if (weakensAiStrictness(settings.aiTextStrictness, nextAiTextStrictness)) {
      weakenLabel = 'lower AI text strictness';
    }
    if (weakenLabel) {
      const ok = await requirePINIfSet(weakenLabel);
      if (!ok) return;
    }

    settings.enabled = $('enabled').checked;
    settings.useSmartBlocking = $('smart').checked;
    settings.debugMode = $('debug-mode').checked;
    settings.imageFilterLevel = nextImageFilterLevel;
    settings.aiStrictness = nextAiStrictness;
    settings.aiTextStrictness = nextAiTextStrictness;
    settings.customPatterns = nextCustomPatterns;
    if (customKeywords) settings.customKeywordList = nextKeywords;
    settings.trustedImageDomains = nextTrusted;
    await setSettings(settings);
    // Show the tidied lists back, so the sorting and dedup are visible rather
    // than only taking effect on the next page load.
    $('patterns').value = deserializePatterns(nextCustomPatterns);
    if (customKeywords) customKeywords.value = deserializePatterns(nextKeywords);
    $('trusted-domains').value = deserializePatterns(nextTrusted);
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
      const nextKeywords = serializePatterns($('custom-keywords').value);
      const patternError = findKeywordPatternError(nextKeywords);
      if (patternError) {
        showToast(`"${patternError.entry}" — ${patternError.error}`, 'error');
        return;
      }
      // Adding a blocked word tightens protection (free); deleting one loosens
      // it, so it needs the PIN — otherwise a blocked word is a two-second
      // bypass, which defeats the point of setting one.
      if (hasRemovals(settings.customKeywordList, nextKeywords)) {
        const ok = await requirePINIfSet('remove custom blocked words');
        if (!ok) return;
      }
      settings.customKeywordList = nextKeywords;
      await setSettings(settings);
      $('custom-keywords').value = deserializePatterns(nextKeywords);
      alert('Custom blocked words saved!');
    });
  }

  const resetKeywords = $('reset-keywords');
  if (resetKeywords) {
    resetKeywords.addEventListener('click', async () => {
      const ok = await requirePINIfSet('reset custom blocked words');
      if (!ok) return;
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
    const ok = await requirePINIfSet('reset trusted domains');
    if (!ok) return;
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
    if (currentSettings.customPatterns.length > 0 ||
        currentSettings.customKeywordList.length > 0) {
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
      aiStrictness: 'balanced',
    });
    await render();
  });

  // Whitelist event listeners
  $('add-whitelist').addEventListener('click', async () => {
    const domainInput = $('whitelist-domain');
    // Accepts a bare domain or a domain + path (e.g. reddit.com/r/NoFap).
    const parsed = self.DomainValidate.parseWhitelistInput(domainInput.value.trim());

    if (!parsed) {
      alert('Please enter a valid domain or page (e.g., example.com or example.com/r/Name)');
      return;
    }

    const whitelist = await getWhitelist();
    const exists = whitelist.some(item => item.domain === parsed.domain && (item.path || null) === (parsed.path || null));

    if (exists) {
      alert(parsed.path ? 'This page is already whitelisted' : 'Domain is already whitelisted');
      return;
    }

    // Gate last, so a typo or a duplicate never costs someone a 256-character
    // code. A bare domain unlocks the whole site — as total as switching
    // blocking off — so it counts as critical; a path-scoped entry opens one
    // section and doesn't.
    const okPin = await requirePIN(
      parsed.path ? 'whitelist this page' : 'whitelist this whole site',
      { critical: !parsed.path }
    );
    if (!okPin) return;

    const newItem = {
      domain: parsed.domain,
      path: parsed.path || null,
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
    // A whitelist file is a bulk whole-site unlock, so it faces the same bar
    // as whitelisting a site by hand.
    requirePINIfSet('import a whitelist file', { critical: true }).then(ok => {
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
            
            // Optional path scope — normalize the same way as typed entries.
            const path = typeof item.path === 'string'
              ? self.DomainValidate.normalizeWhitelistPath(item.path)
              : null;

            validItems.push({
              domain: domain,
              path: path,
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
            if (!merged.some(existing => existing.domain === item.domain && (existing.path || null) === (item.path || null))) {
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
    if (area === 'local' && (changes[UPDATE_INFO_KEY] || changes[UPDATE_DISMISSED_KEY])) {
      renderUpdateBanner();
    }
  });

  // PIN management
  // Import/export for the three list boxes. Import merges into the textarea
  // and leaves saving to the user: the entries are visible before they take
  // effect, and the existing Save handler still applies the PIN rules (so an
  // imported trusted domain is gated exactly as a typed one is). Merging is
  // union-only, so importing can never silently drop entries already present.
  [
    { key: 'patterns', textarea: 'patterns', settingsKey: 'customPatterns', label: 'blocklist', noun: 'blocklist entries' },
    { key: 'keywords', textarea: 'custom-keywords', settingsKey: 'customKeywordList', label: 'blocked-words', noun: 'blocked words' },
    { key: 'trusted', textarea: 'trusted-domains', settingsKey: 'trustedImageDomains', label: 'trusted-sites', noun: 'trusted sites' }
  ].forEach(list => {
    const exportBtn = $(`export-${list.key}`);
    const importBtn = $(`import-${list.key}`);
    const fileInput = $(`import-${list.key}-file`);
    const textarea = $(list.textarea);
    if (!textarea) return;

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        // Exports what is on screen, including unsaved edits — the list you
        // can see is the list you get.
        const entries = serializePatterns(textarea.value);
        const realCount = countRealEntries(entries);
        if (realCount === 0) {
          showToast(`No ${list.noun} to export yet`, 'warning');
          return;
        }
        // Comments go into the file so a shared list keeps its headings, but the
        // count reported is entries — that is what the user means by "how many".
        downloadTextFile(listExportFilename(list.label), serializeListFile(entries));
        showToast(`Exported ${realCount} ${list.noun}`, 'success');
      });
    }

    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES) {
            showToast('File too large (max 1MB)', 'error');
            return;
          }
          const imported = parseListFile(await readFileAsText(file));
          if (imported.length === 0) {
            showToast('No entries found in that file', 'warning');
            return;
          }
          const existing = serializePatterns(textarea.value);
          const before = countRealEntries(existing);
          // serializePatterns dedups (case-insensitively) and sorts the union,
          // keeping each comment with the entry it was written above.
          const merged = serializePatterns(existing.concat(imported).join('\n'));
          textarea.value = deserializePatterns(merged);
          const added = countRealEntries(merged) - before;
          const importedCount = countRealEntries(imported);
          showToast(
            added > 0
              ? `Added ${added} new ${list.noun} — review, then click Save`
              : `Nothing new to add — all ${importedCount} were already in your list`,
            added > 0 ? 'success' : 'info'
          );
        } catch (_) {
          showToast('Could not read that file', 'error');
        } finally {
          e.target.value = ''; // allow re-importing the same file
        }
      });
    }
  });

  const accessCodeToggleEl = $('access-code-enabled');
  if (accessCodeToggleEl) {
    accessCodeToggleEl.addEventListener('change', async (e) => {
      const config = await getAccessCodeConfig();
      // Turning it ON tightens protection, so it's free. Turning it OFF
      // removes a deterrent, so it has to survive the deterrent itself.
      if (config.enabled && !e.target.checked) {
        const ok = await requirePINIfSet('turn off the access code', { critical: true });
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      await setAccessCodeConfig({ ...config, enabled: e.target.checked });
      showToast(e.target.checked ? 'Access code enabled' : 'Access code disabled', 'success');
    });
  }

  const accessCodeScopeEl = $('access-code-scope-all');
  if (accessCodeScopeEl) {
    accessCodeScopeEl.addEventListener('change', async (e) => {
      const config = await getAccessCodeConfig();
      // Narrowing the scope means fewer moments guarded, so it's gated as a
      // critical change. Widening it is free.
      if (config.scope === 'all' && !e.target.checked) {
        const ok = await requirePINIfSet('ask for the code less often', { critical: true });
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      await setAccessCodeConfig({ ...config, scope: e.target.checked ? 'all' : 'critical' });
      showToast(
        e.target.checked
          ? 'Access code will be asked for every weakening change'
          : 'Access code will only be asked for major changes',
        'success'
      );
    });
  }

  const accessCodeLengthEl = $('access-code-length');
  if (accessCodeLengthEl) {
    accessCodeLengthEl.addEventListener('change', async (e) => {
      const config = await getAccessCodeConfig();
      const nextLength = normalizeAccessCodeConfig({ length: Number(e.target.value) }).length;
      // A shorter code is a weaker deterrent, so shortening is gated. Only
      // matters while the feature is on — otherwise there's nothing to weaken.
      if (config.enabled && nextLength < config.length) {
        const ok = await requirePINIfSet('shorten the access code', { critical: true });
        if (!ok) {
          e.target.value = String(config.length);
          return;
        }
      }
      await setAccessCodeConfig({ ...config, length: nextLength });
      showToast(`Access code length set to ${nextLength} characters`, 'success');
    });
  }

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

    // Dropping the PIN removes protection, so the access code applies here too.
    const codeOk = await requireAccessCodeIfEnabled('clear PIN', true);
    if (!codeOk) return;

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
      const ok = await requirePINIfSet('disable blocking', { critical: true });
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
