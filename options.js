const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const PIN_KEY = 'pblocker_pin';
const STREAK_START_KEY = 'pblocker_streak_start';
const UPDATE_INFO_KEY = 'pblocker_update_info';
const UPDATE_DISMISSED_KEY = 'pblocker_update_dismissed';
// Note: unrelated to PIN_KEY — this is the toolbar-pin prompt, not the PIN lock.
const PIN_BANNER_DISMISSED_KEY = 'pblocker_pin_banner_dismissed';

// Mirrors DnsProviders.CUSTOM_PROVIDER_ID, with a literal fallback so the DNS
// card still renders if the shared script failed to load.
const CUSTOM_DNS_ID = (self.DnsProviders && self.DnsProviders.CUSTOM_PROVIDER_ID) || 'custom';

const DEFAULT_SETTINGS = {
  enabled: true,
  useSmartBlocking: true,
  imageFilterLevel: 'strict',
  customPatterns: [],
  customKeywordList: [],
  trustedImageDomains: [],
  debugMode: false,
  blockedPageType: 'default', // 'default', 'custom', 'plain_html'
  blockedPageTheme: 'classic', // design of the built-in page; see blocked-themes.js
  searchResultTreatment: 'hide', // 'hide' | 'overlay' — web/text results only
  searchSummaryEnabled: true, // the "N results blocked" line on search pages
  blockCountDisplay: 'badge', // 'badge' (toolbar icon) | 'floating' (in-page pill)
  customBlockedPageUrl: '',
  plainBlockedPageHtml: '',
  dnsFilterEnabled: false,
  dnsProvider: 'cloudflare', // see shared/dns-providers.js for the roster
  dnsCustomUrl: '', // DoH endpoint used when dnsProvider is 'custom'
  safeSearchEnabled: true,
  facebookReelsEnabled: false,
  instagramReelsEnabled: false,
  aiImageBlocker: false,
  aiImageScanAllSites: true,
  aiImageModel: 'nsfwjs',
  aiStrictness: 'balanced',
  aiTextBlocker: false,
  aiTextStrictness: 'balanced',
};

// The 24 sites Reset puts back on the trusted list.
const DEFAULT_TRUSTED_DOMAINS = [
  'steampowered.com', 'steamstatic.com', 'steamcommunity.com', 'store.steampowered.com',
  'epicgames.com', 'gog.com', 'origin.com', 'battle.net', 'blizzard.com', 'ubisoft.com',
  'ea.com', 'nintendo.com', 'playstation.com', 'xbox.com', 'microsoft.com', 'amazon.com',
  'youtube.com', 'twitch.tv', 'discord.com', 'reddit.com', 'imgur.com', 'github.com',
  'stackoverflow.com', 'wikipedia.org'
];

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

// ── AI image model picker ────────────────────────────────────────────────
// Two classifiers, one of which is not in the extension package: vit384's
// weights (~22 MB) are fetched on first use and cached locally, so the store
// download stays small for the majority who never enable the AI blocker.
// This section has to make that download visible rather than have the feature
// mysteriously do nothing on a metered connection.

function normalizeAiImageModel(id) {
  return typeof AiImageModels !== 'undefined'
    ? AiImageModels.normalizeModelId(id)
    : (id === 'vit384' ? 'vit384' : 'nsfwjs');
}

function askBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function describeAiImageModel(modelId, status) {
  const model = typeof AiImageModels !== 'undefined'
    ? AiImageModels.resolveModel(modelId)
    : null;
  const blurb = model ? model.blurb : '';
  if (!model || model.bundled) return blurb;
  // This build may predate the model conversion, in which case there is
  // nothing to download and retrying can never help. Say that plainly rather
  // than offering a button that silently does nothing.
  if (status && status.available === false) {
    return 'Not available in this build — the model files have not been ' +
      'published yet, so the bundled NSFW.js model is being used instead.';
  }
  if (status && status.progress && status.progress.phase === 'weights') {
    const { loaded, total } = status.progress;
    return blurb + ' Downloading weights (' + loaded + ' of ' + total + ' parts)...';
  }
  if (status && status.cached) return blurb + ' Downloaded and ready.';
  return blurb + ' Not downloaded yet — it will fetch the first time an image ' +
    'is scanned, and images go unfiltered until it finishes.';
}

async function renderAiImageModel(settings) {
  const select = $('ai-image-model');
  const detail = $('ai-image-model-detail');
  const actions = $('ai-image-model-download');
  const downloadBtn = $('ai-image-model-download-btn');
  const clearBtn = $('ai-image-model-clear-btn');
  const modelId = normalizeAiImageModel(settings.aiImageModel);

  if (select) select.value = modelId;

  const bundled = modelId === 'nsfwjs';
  let status = null;
  if (!bundled) status = await askBackground({ type: 'ai_model_status', model: modelId });

  if (detail) detail.textContent = describeAiImageModel(modelId, status);
  if (actions) actions.style.display = bundled ? 'none' : 'block';
  const cached = !!(status && status.cached);
  const unavailable = !!(status && status.available === false);
  if (actions && unavailable) actions.style.display = 'none';
  if (downloadBtn) {
    downloadBtn.style.display = bundled || cached || unavailable ? 'none' : 'inline-flex';
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download the model';
  }
  if (clearBtn) clearBtn.style.display = !bundled && cached ? 'inline-flex' : 'none';
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
  // Each level is a threshold the model file carries, chosen on held-out pages
  // for a target false-positive rate (tools/text_corpus/EVAL.md). Keep the
  // copy in line with what that report measures.
  if (normalized === 'relaxed') {
    return {
      label: 'Relaxed',
      detail: 'Blocks only pages it is almost certain are adult. Fewest false positives.'
    };
  }
  if (normalized === 'strict') {
    return {
      label: 'Strict',
      detail: 'Also blocks borderline pages. Catches more, and will sometimes block an ordinary page.'
    };
  }
  return {
    label: 'Balanced',
    detail: 'Balanced — blocks clearly adult pages; tested not to block health, recovery or sex-education pages.'
  };
}

// Notices: one plain-text line at the foot of the window. Success and news go
// to a polite status region; a problem goes to an alert region and is read out
// at once. Status is a word, never a colour, so the two look the same.
let noticeTimer = null;
function showToast(message, type = 'info') {
  const problem = type === 'error' || type === 'warning';
  const shown = $(problem ? 'notice-alert' : 'notice-status');
  const other = $(problem ? 'notice-status' : 'notice-alert');
  if (!shown) return;
  if (other) {
    other.classList.remove('is-shown');
    other.textContent = '';
  }
  shown.textContent = message;
  shown.classList.add('is-shown');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    shown.classList.remove('is-shown');
    setTimeout(() => {
      if (!shown.classList.contains('is-shown')) shown.textContent = '';
    }, 200);
  }, problem ? 6000 : 3500);
}

// A hint line under a field, with its tone as a class: 'error' for a problem,
// 'success' when something checked out. The words carry the meaning.
function setHint(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.className = 'field-hint pin-hint' + (tone ? ' ' + tone : '');
  el.removeAttribute('style');
}

// Dialogs. Every confirmation, PIN and access-code prompt on this page is one
// of these: a sheet on a flat scrim with a title, one line of description, the
// fields and the buttons. Focus moves in, stays in, and goes back to whatever
// opened it; Escape and a click on the scrim cancel.
let modalCount = 0;
const MODAL_BUTTON_CLASS = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-ghost',
  destructive: 'btn btn-danger-confirm'
};

function createModal(config) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const id = 'modal-' + (++modalCount);

    const overlay = document.createElement('div');
    overlay.className = 'dialog-scrim modal-overlay';

    const content = document.createElement('div');
    content.className = 'dialog modal-content';
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', id + '-title');
    content.setAttribute('aria-describedby', id + '-desc');

    const title = document.createElement('h2');
    title.className = 'dialog-title modal-title';
    title.id = id + '-title';
    title.textContent = config.title;

    const description = document.createElement('p');
    description.className = 'dialog-desc modal-description';
    description.id = id + '-desc';
    description.textContent = config.description;

    // Body: static markup written in this file, plus plain-text parts that
    // may carry an address or a list name and so are only ever text.
    const body = document.createElement('div');
    body.className = 'dialog-body modal-body';
    if (config.bodyHTML) body.innerHTML = config.bodyHTML;
    if (config.code) {
      const code = document.createElement('div');
      code.className = 'access-code-display dialog-code';
      code.textContent = config.code;
      body.appendChild(code);
    }
    if (config.message) {
      const message = document.createElement('p');
      message.className = 'dialog-message';
      message.textContent = config.message;
      body.appendChild(message);
    }
    if (!body.childNodes.length) body.hidden = true;

    const footer = document.createElement('div');
    footer.className = 'dialog-actions modal-footer';

    config.buttons.forEach(btnConfig => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `${MODAL_BUTTON_CLASS[btnConfig.type] || 'btn btn-ghost'} modal-button modal-button-${btnConfig.type}`;
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

    content.appendChild(title);
    content.appendChild(description);
    content.appendChild(body);
    content.appendChild(footer);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Close on a click on the scrim
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay, null);
      }
    });

    // Escape cancels; Tab stays inside the dialog.
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal(overlay, null);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [...content.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.disabled && node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyHandler);

    // First focus: the first field, or Cancel when the dialog confirms
    // something destructive, or else the main button.
    setTimeout(() => {
      // A choice of options opens on the one already chosen.
      const firstInput = body.querySelector('input:checked') || body.querySelector('input');
      const destructive = footer.querySelector('.modal-button-destructive');
      const target = firstInput ||
        (destructive ? footer.querySelector('.modal-button-secondary') : null) ||
        footer.querySelector('.modal-button-primary') ||
        footer.querySelector('button');
      if (target) target.focus();
    }, 100);

    let closed = false;
    function closeModal(modalEl, value) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keyHandler);
      modalEl.style.opacity = '0';
      setTimeout(() => {
        if (modalEl.parentNode) {
          modalEl.parentNode.removeChild(modalEl);
        }
        if (opener && document.contains(opener) && typeof opener.focus === 'function') {
          try { opener.focus({ preventScroll: true }); } catch (_) {}
        }
        resolve(value);
      }, 180);
    }

    overlay.closeModal = (value) => closeModal(overlay, value);
  });
}

async function showSetPINModal() {
  let pinInput, confirmInput, strengthBar, hintText;
  
  // Create modal without awaiting - this adds it to DOM immediately
  const modalPromise = createModal({
    title: 'Set a PIN',
    description: 'A PIN guards anything that loosens protection. Use at least 4 characters.',
    bodyHTML: `
      <div class="field pin-input-group">
        <label class="field-label pin-input-label" for="modal-pin-input">New PIN</label>
        <input type="password" class="input pin-input" id="modal-pin-input" maxlength="20" autocomplete="off" aria-describedby="modal-hint">
        <div class="pin-strength-indicator" hidden>
          <div class="pin-strength-bar" id="modal-strength-bar"></div>
        </div>
        <p class="field-hint pin-hint" id="modal-hint" aria-live="polite">At least 4 characters.</p>
      </div>
      <div class="field pin-input-group">
        <label class="field-label pin-input-label" for="modal-confirm-input">Type it again</label>
        <input type="password" class="input pin-input" id="modal-confirm-input" maxlength="20" autocomplete="off" aria-describedby="modal-hint">
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
            pinInput.setAttribute('aria-invalid', 'true');
            setHint(hintText, 'A PIN has at least 4 characters. Choose a longer one.', 'error');
            setTimeout(() => pinInput.classList.remove('error'), 500);
            return false; // Don't close modal
          }

          if (pin !== confirm) {
            confirmInput.classList.add('error');
            confirmInput.setAttribute('aria-invalid', 'true');
            setHint(hintText, 'The two PINs don’t match. Type them again.', 'error');
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
      pinInput.removeAttribute('aria-invalid');
      if (confirmInput) confirmInput.removeAttribute('aria-invalid');

      // The length is said in words; the old coloured bar stays in the markup
      // for anything that reads its class, but is never shown.
      strengthBar.className = 'pin-strength-bar';
      if (length === 0) {
        strengthBar.className = 'pin-strength-bar';
        setHint(hintText, 'At least 4 characters.');
      } else if (length < 4) {
        strengthBar.classList.add('weak');
        setHint(hintText, 'Too short. Use at least 4 characters.');
      } else if (length < 6) {
        strengthBar.classList.add('medium');
        setHint(hintText, 'Long enough.');
      } else {
        strengthBar.classList.add('strong');
        setHint(hintText, 'Long enough, and harder to guess.', 'success');
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

// Resolves true for the right PIN, 'witness' when a code from the witness's
// app was typed instead (it vouches for the change, so callers under a Pact
// apply it at once), or null when cancelled.
//
// With a witness paired, a code from their app is accepted here too. Both are
// short numbers that come from the witness, so people type one where the
// other was asked for; refusing a valid code because it went in the wrong box
// helps nobody.
async function showVerifyPINModal(actionLabel = 'this action', opts) {
  let pinInput, hintText;
  let checking = false;
  const pact = await readPact();
  const witnessOn = !!(Pact && pact && pact.witness);
  const sealed = opts && typeof opts.sealed === 'boolean' ? opts.sealed : !!(pact && pact.pinSealed);

  const close = (value) => {
    const overlay = pinInput && pinInput.closest('.modal-overlay');
    if (overlay && overlay.closeModal) overlay.closeModal(value);
  };

  // The PIN is hashed, so checking it is asynchronous: the button keeps the
  // dialog open and closes it itself once the answer is in.
  const checkTyped = async () => {
    if (checking || !pinInput) return;
    const pin = pinInput.value.trim();
    if (!pin) return;
    checking = true;
    const result = await checkPIN(pin);
    let codeReply = null;
    if (!result.ok && witnessOn && Pact.looksLikeWitnessCode(pin)) {
      codeReply = await Pact.ask({ type: 'pact_verify_code', code: pin });
    }
    checking = false;
    if (result.ok) {
      close(true);
      return;
    }
    if (codeReply && codeReply.ok) {
      // The PIN check counted it as a wrong PIN; it wasn't one.
      if (PinHash) await browserAPI.storage.local.remove(PinHash.LOCK_KEY);
      if (codeReply.via === 'recovery') showToast(`Recovery code used. ${codeReply.recoveryLeft} left.`, 'info');
      close('witness');
      return;
    }
    pinInput.classList.add('error');
    pinInput.setAttribute('aria-invalid', 'true');
    pinInput.value = '';
    let message = 'That PIN didn’t match. Try again.';
    if (codeReply && codeReply.locked) {
      message = `Too many wrong codes. Try again in ${PinHash ? PinHash.describeWait(codeReply.waitMs) : 'a while'}.`;
    } else if (result.waitMs) {
      message = `Too many wrong tries. Try again in ${PinHash.describeWait(result.waitMs)}.`;
    } else if (witnessOn) {
      message = 'That isn’t your PIN or your witness’s current code. Their code changes every 30 seconds.';
    }
    setHint(hintText, message, 'error');
    setTimeout(() => pinInput.classList.remove('error'), 500);
  };

  // Create modal without awaiting - this adds it to DOM immediately
  const modalPromise = createModal({
    title: 'Enter your PIN',
    description: sealed
      ? `Your witness holds your PIN. Ask them for it, or for the code in their app, to ${actionLabel}.`
      : `Enter your PIN to ${actionLabel}.`,
    bodyHTML: `
      <div class="field pin-input-group">
        <label class="field-label pin-input-label" for="modal-verify-input">PIN</label>
        <input type="password" class="input pin-input" id="modal-verify-input" maxlength="20" autocomplete="off" aria-describedby="modal-verify-hint">
        <p class="field-hint pin-hint" id="modal-verify-hint" aria-live="polite"></p>
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      {
        text: 'Continue',
        type: 'primary',
        onClick: () => {
          checkTyped();
          return false; // checkTyped closes the dialog when the PIN is right
        }
      }
    ]
  });
  
  // Get references immediately after modal is created (while it's still in DOM)
  // Use a small timeout to ensure DOM has been updated
  await new Promise(resolve => setTimeout(resolve, 50));
  
  pinInput = document.getElementById('modal-verify-input');
  hintText = document.getElementById('modal-verify-hint');
  if (witnessOn) {
    setHint(hintText, sealed
      ? 'The PIN is the number they were shown when you paired. The changing code from their app works too.'
      : 'Or type the code from your witness’s app: it works here too.');
  }

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

// The confirm step. For a destructive action the confirm button is the one
// place the danger fill appears.
async function showConfirmModal(config) {
  return await createModal({
    title: config.title,
    description: config.description,
    message: config.message || '',
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

// The Pact and the modules it needs (shared/pact.js, totp.js, pin-hash.js,
// qr.js). Any of them may be missing in a stripped-down test context; the
// gates below then behave exactly as they did before the Pact existed.
const Pact = self.Pact || null;
const Totp = self.Totp || null;
const PinHash = self.PinHash || null;
const QrCode = self.QrCode || null;
// Storm Mode, Risk Hours, own words, slips (shared/boost.js, moments.js).
const Boost = self.Boost || null;
const Moments = self.Moments || null;

// During Storm Mode or Risk Hours nothing that loosens protection can be done,
// not even with a pact's wait or a witness code. Resolves true, after saying
// so, when that is why a change is refused.
async function refusedByBoost() {
  if (!Boost) return false;
  const state = await Boost.readState(browserAPI.storage.local);
  if (!state) return false;
  await createModal({
    title: state.active === 'storm' ? 'Storm Mode is on' : 'Your risk hours are on',
    description: Boost.refusal(state, Date.now()),
    message: 'Anything that makes protection stronger still works.',
    buttons: [{ text: 'OK', type: 'primary', value: true }]
  });
  return true;
}

// The stored PIN is a salted hash now (shared/pin-hash.js); a PIN saved by an
// older version is a plain string until it is next entered.
async function getPIN() {
  const { [PIN_KEY]: pin } = await browserAPI.storage.local.get(PIN_KEY);
  return pin || null;
}

function pinIsSet(stored) {
  return PinHash ? PinHash.isSet(stored) : !!stored;
}

async function setPIN(pin) {
  const stored = PinHash ? await PinHash.hash(pin) : pin;
  await browserAPI.storage.local.set({ [PIN_KEY]: stored });
  if (PinHash) await browserAPI.storage.local.remove(PinHash.LOCK_KEY);
}

// Checks a typed PIN, under the lockout: five free tries, then a wait that
// doubles. Resolves { ok, waitMs }. A correct PIN still stored as plain text
// is re-saved as a hash on the way through.
async function checkPIN(entered) {
  if (PinHash) return await PinHash.check(browserAPI.storage.local, entered, Date.now());
  const stored = await getPIN();
  return { ok: !!stored && entered === stored, waitMs: 0 };
}

async function ensurePIN() {
  const current = await getPIN();
  if (pinIsSet(current)) return true;
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

function accessCodeRequiredFor(config, tier) {
  return AccessCode.requiredFor(config, tier);
}

// Gate callers pass `{ critical: true }` for a master switch or
// `{ tier: 'tuning' }` for a sensitivity dial; plain calls are 'normal'.
// See TIERS in shared/access-code.js.
function accessCodeTier(opts) {
  if (!opts) return 'normal';
  if (opts.tier) return opts.tier;
  return opts.critical === true ? 'critical' : 'normal';
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

  // The code goes in as text after the dialog exists. Written into the markup
  // it was parsed as HTML, and an "&" followed by letters in the code could
  // show as a different character from the one being checked.
  const modalPromise = createModal({
    title: 'Type the access code',
    description: `Type the code below exactly to ${actionLabel}.`,
    bodyHTML: `
      <div class="access-code-display" id="modal-access-code"></div>
      <div class="field">
        <label class="field-label" for="modal-access-code-input">The code, typed by hand</label>
        <input type="text" class="input input-mono pin-input access-code-input" id="modal-access-code-input"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
               aria-describedby="modal-access-code-hint">
        <p class="field-hint pin-hint" id="modal-access-code-hint" aria-live="polite">Copy and paste are turned off on purpose.</p>
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: false },
      {
        text: 'Continue',
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
          input.setAttribute('aria-invalid', 'true');
          setTimeout(() => input.classList.remove('error'), 500);
          setHint(hint, 'That didn’t match. Type the new code above.', 'error');
          return false; // keep the modal open
        }
      }
    ]
  });

  // Wait for the modal to reach the DOM before wiring the guards.
  await new Promise(resolve => setTimeout(resolve, 50));

  const codeDisplay = document.getElementById('modal-access-code');
  if (codeDisplay) codeDisplay.textContent = expected;

  // Refuses paste/drop into the box and copy off the display — the feature is
  // worthless if the code can be moved across in two seconds.
  AccessCode.hardenEntry(
    document.getElementById('modal-access-code-input'),
    document.getElementById('modal-access-code')
  );

  return (await modalPromise) === true;
}

// Runs after the PIN check, so the two layers stack rather than replace.
// `tier` says how much the action gives away — see TIERS in
// shared/access-code.js.
async function requireAccessCodeIfEnabled(actionLabel = 'this action', tier = 'normal') {
  const config = await getAccessCodeConfig();
  if (!accessCodeRequiredFor(config, tier)) return true;
  return await showAccessCodeModal(actionLabel);
}

async function requirePIN(actionLabel = 'this action', opts) {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  const verified = await showVerifyPINModal(actionLabel);
  if (!verified) return false;
  return await requireAccessCodeIfEnabled(actionLabel, accessCodeTier(opts));
}

// Only require PIN if one is already set (doesn't prompt to create one).
// The access code stands on its own, so it still applies when no PIN is set —
// unless the change is 'tuning', which never faces it.
async function requirePINIfSet(actionLabel = 'this action', opts) {
  const stored = await getPIN();
  if (pinIsSet(stored)) {
    const verified = await showVerifyPINModal(actionLabel);
    if (!verified) return false;
  }
  return await requireAccessCodeIfEnabled(actionLabel, accessCodeTier(opts));
}

// --- The Pact ----------------------------------------------------------------
//
// Every change that loosens protection comes through guardWeakening. Without a
// Pact it is the PIN and access-code check it always was. With one, the
// change waits: `change` ({ kind, payload }, see KINDS in shared/pact.js) is
// what the background applies once the wait is over. Resolves true when the
// caller should make the change now (no Pact and the locks passed, or the
// witness let it through), false when it was cancelled or queued.

function settingsChange(set) {
  return { kind: 'settings', payload: { set } };
}

async function readPact() {
  return Pact ? await Pact.readPact(browserAPI.storage.local) : null;
}

async function guardWeakening(actionLabel, opts, change) {
  return (await guardWeakeningOutcome(actionLabel, opts, change)) === 'now';
}

// Resolves 'now' (make the change), 'queued' (the background will) or
// 'cancelled'. For a caller that saves several things at once and must keep
// the parts that don't wait.
async function guardWeakeningOutcome(actionLabel, opts, change) {
  const options = opts || {};
  if (await refusedByBoost()) return 'cancelled';
  const pact = await readPact();
  // Sensitivity dials never wait: they're how someone fixes a block we got
  // wrong, and at their loosest the filters are still on.
  if (!Pact || !Pact.isActive(pact) || !change || accessCodeTier(options) === 'tuning') {
    const ok = options.ensurePin
      ? await requirePIN(actionLabel, options)
      : await requirePINIfSet(actionLabel, options);
    return ok ? 'now' : 'cancelled';
  }

  const choice = await showPactGate(actionLabel, pact);
  if (choice === 'witness') return 'now';
  if (choice !== 'wait') return 'cancelled';

  // The PIN still stops anyone else from queuing changes. The access code and
  // the commitment sentence don't apply: the wait replaces them. A sealed PIN
  // can always be cleared by waiting, or nobody could ever get back in.
  const sealedEscape = change.kind === 'pin-clear' && pact.pinSealed;
  if (!sealedEscape && pinIsSet(await getPIN())) {
    const verified = await showVerifyPINModal(actionLabel, { sealed: pact.pinSealed });
    if (!verified) return 'cancelled';
    // A witness code typed into the PIN box vouches for the change: no wait.
    if (verified === 'witness') return 'now';
  }

  const reply = await Pact.ask({ type: 'pact_enqueue', change: { ...change, label: actionLabel } });
  if (!reply || !reply.ok) {
    showToast('That change couldn’t be queued. Try again.', 'error');
    return 'cancelled';
  }
  const now = Date.now();
  const when = Pact.formatWhen(now + (reply.remainingMs || 0), now);
  showToast(reply.existing
    ? `That change is already waiting. It takes effect around ${when}.`
    : `Waiting. It takes effect around ${when}. You can cancel it under Security, The Pact.`, 'success');
  renderPact();
  return 'queued';
}

// For changes that were never gated before the Pact (a DNS resolver, the
// trusted sites list): without a Pact they stay free.
async function guardIfPact(actionLabel, change) {
  const pact = await readPact();
  if (!Pact || !Pact.isActive(pact)) return true;
  return await guardWeakening(actionLabel, {}, change);
}

// Resolves 'wait', 'witness' (a code let it through) or null (cancelled).
async function showPactGate(actionLabel, pact) {
  const now = Date.now();
  const delay = Pact.formatDelay(pact.delayMs);
  // Two buttons, Cancel and Wait; the witness's code is a link in the body,
  // so the row never wraps and waiting stays the plain choice.
  const choicePromise = createModal({
    title: 'This change waits',
    description: `This will ${actionLabel} after your pact’s wait of ${delay}, around ${Pact.formatWhen(now + pact.delayMs, now)}.`,
    bodyHTML: `
      <p class="dialog-message">Most urges pass if you wait them out. You can cancel it any time before then.</p>
      ${pact.witness
        ? '<p class="dialog-message pact-code-line">Have a code from your witness? <button type="button" class="link" data-pact-code>Use it now</button></p>'
        : '<p class="dialog-message pact-code-line">To let a change through without the wait, add a witness in Security.</p>'}
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      { text: `Wait ${delay}`, type: 'primary', value: 'wait' }
    ]
  });
  const codeLink = [...document.querySelectorAll('.modal-overlay [data-pact-code]')].pop();
  if (codeLink) {
    codeLink.addEventListener('click', () => {
      const overlay = codeLink.closest('.modal-overlay');
      if (overlay && overlay.closeModal) overlay.closeModal('code');
    });
  }
  const choice = await choicePromise;
  if (choice !== 'code') return choice;
  return (await showWitnessCodeModal(actionLabel)) ? 'witness' : null;
}

// Asks for the witness's code. With `entryId`, the background applies that
// waiting change at once; without, it only checks the code and the caller
// makes the change. Resolves true when the code was accepted.
async function showWitnessCodeModal(actionLabel, entryId) {
  let input, hint;
  let busy = false;
  const submit = async () => {
    if (busy || !input) return;
    const code = input.value.trim();
    if (!code) return;
    busy = true;
    const reply = await Pact.ask(entryId
      ? { type: 'pact_apply_now', id: entryId, code }
      : { type: 'pact_verify_code', code });
    busy = false;
    if (reply && reply.ok) {
      if (reply.via === 'recovery') {
        showToast(`Recovery code used. ${reply.recoveryLeft} left.`, 'info');
      }
      const overlay = input.closest('.modal-overlay');
      if (overlay && overlay.closeModal) overlay.closeModal(true);
      return;
    }
    input.value = '';
    input.setAttribute('aria-invalid', 'true');
    setHint(hint, reply && reply.locked
      ? `Too many wrong codes. Try again in ${PinHash ? PinHash.describeWait(reply.waitMs) : 'a while'}.`
      : 'That code didn’t match. Codes change every 30 seconds: ask for the one showing now.', 'error');
  };

  const modalPromise = createModal({
    title: 'Enter your witness’s code',
    description: `Ask your witness for the six-digit code in their authenticator app to ${actionLabel} now.`,
    bodyHTML: `
      <div class="field">
        <label class="field-label" for="modal-witness-code">Code from your witness</label>
        <input type="text" class="input input-mono pin-input" id="modal-witness-code" inputmode="numeric"
               autocomplete="one-time-code" maxlength="12" spellcheck="false" aria-describedby="modal-witness-hint">
        <p class="field-hint pin-hint" id="modal-witness-hint" aria-live="polite">One of their recovery codes works too, once.</p>
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: false },
      { text: 'Continue', type: 'primary', onClick: () => { submit(); return false; } }
    ]
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  input = $('modal-witness-code');
  hint = $('modal-witness-hint');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }
  return (await modalPromise) === true;
}

async function writePact(pact) {
  if (pact) await browserAPI.storage.local.set({ [Pact.PACT_KEY]: pact });
  else await browserAPI.storage.local.remove(Pact.PACT_KEY);
}

async function clearSealedFlag() {
  const pact = await readPact();
  if (pact && pact.pinSealed) await writePact({ ...pact, pinSealed: false });
}

// The same as the background's 'pact' branch (pactApply), for when the
// witness lets a change to the Pact itself through on the spot.
async function applyPactChangeNow(payload) {
  const pact = await readPact();
  if (!pact) return;
  if (payload.action === 'end') {
    await writePact(null);
  } else if (payload.action === 'remove-witness') {
    await writePact({ ...pact, witness: null, pinSealed: false });
  } else if (payload.action === 'delay') {
    await writePact({ ...pact, delayMs: Pact.normalizeDelay(payload.delayMs) });
  }
  // A sealed PIN was only ever known to the witness; it goes with them.
  if (pact.pinSealed && payload.action !== 'delay') {
    await browserAPI.storage.local.remove([PIN_KEY, PinHash ? PinHash.LOCK_KEY : 'pblocker_pin_lock']);
  }
}

function delayChoicesHTML(selected) {
  return Pact.DELAYS.map((ms) => `
    <label class="segment">
      <input class="segment-input" type="radio" name="pact-delay-choice" value="${ms}"${ms === selected ? ' checked' : ''}>
      <span class="segment-label">${Pact.formatDelay(ms)}</span>
    </label>`).join('');
}

async function showMakePactModal() {
  const choice = await createModal({
    title: 'Make a pact',
    description: 'Choose how long a change that loosens protection has to wait. Choose it now, while you’re calm: it’s for the moments you won’t be.',
    bodyHTML: `
      <fieldset class="field pact-delay-field">
        <legend class="field-label">How long changes wait</legend>
        <div class="segmented pact-delay-choices">${delayChoicesHTML(Pact.DEFAULT_DELAY)}</div>
        <p class="field-hint">Start short; you can lengthen it at any time. Shortening it later waits too.</p>
      </fieldset>
      <ul class="pact-terms">
        <li>Turning protection off, whitelisting a site, switching off a layer or clearing your PIN only happens once the wait is over.</li>
        <li>Making protection stronger never waits.</li>
        <li>You can cancel a waiting change at any time.</li>
        <li>The sensitivity settings still apply at once, so you can fix a mistaken block.</li>
      </ul>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      {
        text: 'Make the pact',
        type: 'primary',
        onClick: () => {
          const picked = document.querySelector('input[name="pact-delay-choice"]:checked');
          return picked ? Number(picked.value) : Pact.DEFAULT_DELAY;
        }
      }
    ]
  });
  return typeof choice === 'number' ? choice : null;
}

// The QR the witness scans: their authenticator app reads the key from it.
function buildQrSvg(text) {
  const qr = QrCode.encode(text);
  const size = qr.size + 8; // four modules of quiet zone each side
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'pact-qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for your witness to scan');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const ground = document.createElementNS(ns, 'rect');
  ground.setAttribute('width', String(size));
  ground.setAttribute('height', String(size));
  ground.setAttribute('class', 'pact-qr-ground');
  const ink = document.createElementNS(ns, 'path');
  ink.setAttribute('d', QrCode.toPath(qr));
  ink.setAttribute('class', 'pact-qr-ink');
  svg.appendChild(ground);
  svg.appendChild(ink);
  return svg;
}

// Pairing, in four steps: who and whether they hold the PIN; the key to
// scan; their first code, which proves the pairing works; and the recovery
// codes to hand them. Nothing is saved until the code checks out.
async function pairWitnessFlow() {
  if (!Totp || !QrCode) return;
  const intro = await createModal({
    title: 'Add a witness',
    description: 'Choose someone you trust: a friend, a partner, a sponsor. They add a key to the authenticator app on their phone. When you want a change without the wait, you ask them for the code it shows. They never see your browsing.',
    bodyHTML: `
      <label class="pact-check">
        <input type="checkbox" id="modal-pact-seal">
        <span>Let them hold my PIN too. BlockNSFW makes up a new PIN and shows it only to them, so anything that asks for the PIN needs them. Clearing it yourself waits like any other change.</span>
      </label>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      {
        text: 'Show the key',
        type: 'primary',
        onClick: () => ({ seal: !!(document.getElementById('modal-pact-seal') || {}).checked })
      }
    ]
  });
  if (!intro) return;

  // Sealing replaces the PIN, so it takes the PIN to do it.
  if (intro.seal && pinIsSet(await getPIN())) {
    const ok = await showVerifyPINModal('hand your PIN to your witness');
    if (!ok) return;
  }

  const secret = Totp.generateSecret();
  const keyPromise = createModal({
    title: 'Ask them to scan this',
    description: 'In Google Authenticator, Aegis, 1Password or any authenticator app, they add an account and scan this code.',
    bodyHTML: `
      <div class="pact-qr-frame" id="modal-pact-qr"></div>
      <p class="field-hint">Or they type this key: <span class="pact-key" id="modal-pact-key"></span></p>
      <p class="dialog-message">This key is shown once. Don’t keep a copy yourself: a key you hold lets you skip your own wait.</p>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      { text: 'They’ve added it', type: 'primary', value: true }
    ]
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const frame = $('modal-pact-qr');
  if (frame) frame.appendChild(buildQrSvg(Totp.otpauthUri(secret, 'Pact')));
  const keyEl = $('modal-pact-key');
  if (keyEl) keyEl.textContent = Totp.formatSecret(secret);
  if ((await keyPromise) !== true) return;

  // Their first code proves the key reached their app intact.
  let counter = null;
  let codeInput, codeHint;
  const checkFirst = async () => {
    const result = await Totp.verify(secret, codeInput.value, { times: [Date.now()] });
    if (result.ok) {
      counter = result.counter;
      const overlay = codeInput.closest('.modal-overlay');
      if (overlay && overlay.closeModal) overlay.closeModal(true);
      return;
    }
    codeInput.value = '';
    codeInput.setAttribute('aria-invalid', 'true');
    setHint(codeHint, 'That code didn’t match. Check they scanned the code just shown, then try the one showing now.', 'error');
  };
  const confirmPromise = createModal({
    title: 'Ask them for the code',
    description: 'Their app now shows a six-digit code that changes every 30 seconds. Type the one showing now.',
    bodyHTML: `
      <div class="field">
        <label class="field-label" for="modal-pact-first-code">Code from their app</label>
        <input type="text" class="input input-mono pin-input" id="modal-pact-first-code" inputmode="numeric"
               autocomplete="one-time-code" maxlength="8" spellcheck="false" aria-describedby="modal-pact-first-hint">
        <p class="field-hint pin-hint" id="modal-pact-first-hint" aria-live="polite"></p>
      </div>
    `,
    buttons: [
      { text: 'Cancel', type: 'secondary', value: null },
      { text: 'Check the code', type: 'primary', onClick: () => { checkFirst(); return false; } }
    ]
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  codeInput = $('modal-pact-first-code');
  codeHint = $('modal-pact-first-hint');
  if (codeInput) {
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); checkFirst(); }
    });
  }
  if ((await confirmPromise) !== true || counter === null) return;

  const recovery = Totp.generateRecoveryCodes();
  const sealedPin = intro.seal && PinHash ? PinHash.generatePin() : null;
  const handoverPromise = createModal({
    title: 'Give these to your witness',
    description: sealedPin
      ? 'Their PIN for you, and eight recovery codes. Each recovery code works once, if they lose their phone. Shown once.'
      : 'Eight recovery codes. Each works once, if they lose their phone. Shown once.',
    bodyHTML: `
      <div class="pact-handover">
        <div class="pact-pin" id="modal-pact-pin" hidden>
          <span class="meta">Your PIN, for them to keep</span>
          <span class="pact-pin-value" id="modal-pact-pin-value"></span>
        </div>
        <ol class="pact-recovery" id="modal-pact-recovery"></ol>
      </div>
    `,
    buttons: [{ text: 'They have them', type: 'primary', value: true }]
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const list = $('modal-pact-recovery');
  if (list) {
    recovery.forEach((code) => {
      const item = document.createElement('li');
      item.textContent = code;
      list.appendChild(item);
    });
  }
  if (sealedPin) {
    const box = $('modal-pact-pin');
    const value = $('modal-pact-pin-value');
    if (box) box.hidden = false;
    if (value) value.textContent = sealedPin;
  }
  await handoverPromise;

  const hashes = await Promise.all(recovery.map(code => Totp.hashRecoveryCode(code)));
  if (sealedPin) await setPIN(sealedPin);
  const pact = await readPact();
  await writePact({
    ...pact,
    witness: {
      secret,
      pairedAt: Date.now(),
      lastCounter: counter,
      recovery: hashes.map(hash => ({ hash, used: false }))
    },
    pinSealed: !!sealedPin
  });
  showToast(sealedPin ? 'Your witness is set, and holds your PIN.' : 'Your witness is set.', 'success');
  await render();
}

async function renderPact() {
  const group = $('pact-group');
  if (!group) return;
  if (!Pact) {
    group.hidden = true;
    return;
  }
  const { pact, queue, clock } = await Pact.readAll(browserAPI.storage.local);
  const on = Pact.isActive(pact);
  setStatusWord($('pact-status'), on ? 'on' : 'off', on);
  $('pact-off').hidden = on;
  $('pact-on').hidden = !on;
  if (!on) return;

  const delaySelect = $('pact-delay');
  if (delaySelect) delaySelect.value = String(pact.delayMs);

  const witnessDesc = $('pact-witness-desc');
  const witnessBtn = $('pact-witness-btn');
  if (pact.witness) {
    const left = Pact.recoveryLeft(pact);
    const paired = new Date(pact.witness.pairedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    witnessDesc.textContent = `Added ${paired}. ${left} recovery ${left === 1 ? 'code' : 'codes'} left.` +
      (pact.pinSealed ? ' They also hold your PIN.' : '');
    witnessBtn.textContent = 'Remove witness';
    witnessBtn.className = 'btn btn-danger btn-sm';
  } else {
    witnessDesc.textContent = 'Someone you trust holds a code that lets a change through without the wait. They never see your browsing.';
    witnessBtn.textContent = 'Add a witness';
    witnessBtn.className = 'btn btn-ghost btn-sm';
  }

  const listEl = $('pact-pending-list');
  listEl.textContent = '';
  if (!queue.length) {
    const empty = document.createElement('p');
    empty.className = 'domain-empty';
    empty.textContent = 'Nothing is waiting.';
    listEl.appendChild(empty);
    return;
  }
  const now = Date.now();
  queue.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'domain-row';
    const main = document.createElement('div');
    main.className = 'domain-main';
    const name = document.createElement('span');
    name.className = 'domain pact-entry-label';
    name.textContent = Pact.sentenceCase(entry.label);
    const meta = document.createElement('span');
    meta.className = 'domain-meta';
    const left = Pact.remainingMs(entry, clock, now);
    meta.textContent = left > 0
      ? `In ${Pact.formatRemaining(left)}, around ${Pact.formatWhen(now + left, now)}`
      : 'Due now';
    main.appendChild(name);
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'row-control';
    if (pact.witness) {
      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'btn-text';
      code.textContent = 'Use a code';
      code.setAttribute('aria-label', `Use a witness code to ${entry.label} now`);
      code.addEventListener('click', async () => {
        if (await showWitnessCodeModal(entry.label, entry.id)) showToast('Done.', 'success');
        renderPact();
      });
      actions.appendChild(code);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('aria-label', `Cancel: ${entry.label}`);
    cancel.addEventListener('click', async () => {
      const reply = await Pact.ask({ type: 'pact_cancel', id: entry.id });
      showToast(reply && reply.ok ? 'Cancelled. Nothing changed.' : 'That didn’t cancel. Try again.', reply && reply.ok ? 'success' : 'error');
      renderPact();
    });
    actions.appendChild(cancel);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

function initPact() {
  if (!Pact || !$('pact-group')) return;

  $('pact-start').addEventListener('click', async () => {
    const delayMs = await showMakePactModal();
    if (!delayMs) return;
    await writePact(Pact.createPact(delayMs, Date.now()));
    showToast(`Your pact is made. Changes that loosen protection now wait ${Pact.formatDelay(delayMs)}.`, 'success');
    await render();
  });

  $('pact-delay').addEventListener('change', async (e) => {
    const pact = await readPact();
    if (!pact) return;
    const next = Pact.normalizeDelay(e.target.value);
    if (next === pact.delayMs) return;
    if (next > pact.delayMs) {
      // Longer is stronger, so it applies at once.
      await writePact({ ...pact, delayMs: next });
      showToast(`Changes now wait ${Pact.formatDelay(next)}.`, 'success');
    } else {
      // Pluckeye's rule: a shorter wait has to wait out the current one.
      const payload = { action: 'delay', delayMs: next };
      const now = await guardWeakening(`shorten the wait to ${Pact.formatDelay(next)}`, { critical: true }, { kind: 'pact', payload });
      if (now) await applyPactChangeNow(payload);
    }
    await render();
  });

  $('pact-witness-btn').addEventListener('click', async () => {
    const pact = await readPact();
    if (!pact) return;
    if (!pact.witness) {
      await pairWitnessFlow();
      return;
    }
    const payload = { action: 'remove-witness' };
    const now = await guardWeakening('remove your witness', { critical: true }, { kind: 'pact', payload });
    if (now) {
      await applyPactChangeNow(payload);
      showToast('Your witness is removed.', 'success');
    }
    await render();
  });

  $('pact-end').addEventListener('click', async () => {
    const payload = { action: 'end' };
    const now = await guardWeakening('end the pact', { critical: true }, { kind: 'pact', payload });
    if (now) {
      await applyPactChangeNow(payload);
      showToast('The pact is ended.', 'success');
    }
    await render();
  });

  // Anything due is applied as the page opens, and the countdown stays true
  // while it is open.
  Pact.ask({ type: 'pact_process' });
  setInterval(() => {
    if (document.visibilityState === 'visible') renderPact();
  }, 30000);
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[Pact.PACT_KEY] || changes[Pact.QUEUE_KEY])) renderPact();
  });
}

// --- Your own words, Storm Mode, Risk hours ----------------------------------

function fillRiskTimes(select, selected) {
  if (!select) return;
  if (!select.options.length) {
    for (let minutes = 0; minutes < 1440; minutes += 30) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = Boost.formatMinutes(minutes);
      select.appendChild(option);
    }
  }
  select.value = String(selected);
}

// The minutes of the day a Risk Hours window covers.
function riskMinutes(risk) {
  const r = Boost.normalizeRisk(risk);
  const covered = new Set();
  if (!r.enabled) return covered;
  for (let m = r.start; m !== r.end; m = (m + 1) % 1440) covered.add(m);
  return covered;
}

// Switching Risk Hours on, or widening them, makes protection stronger and
// applies at once. Anything that drops a minute loosens it.
function riskTightens(prev, next) {
  const after = riskMinutes(next);
  for (const minute of riskMinutes(prev)) if (!after.has(minute)) return false;
  return true;
}

async function renderHardMoments() {
  if (!Boost || !Moments || !$('own-words-group')) return;
  const store = await browserAPI.storage.local.get([Moments.WORDS_KEY, Boost.RISK_KEY, Boost.STATE_KEY]);

  // A field someone is typing in is never overwritten by a re-render.
  const words = Moments.normalizeWords(store[Moments.WORDS_KEY]);
  const fill = (id, value) => {
    const el = $(id);
    if (el && document.activeElement !== el && el.dataset.dirty !== 'true') el.value = value;
  };
  fill('own-words-plan', words.plan);
  fill('own-words-note', words.note);
  fill('own-words-name', words.person.name);
  fill('own-words-phone', words.person.phone);

  const now = Date.now();
  const state = Boost.normalizeState(store[Boost.STATE_KEY]);
  const stormOn = !!(state && state.active === 'storm');
  setStatusWord($('storm-status'), stormOn ? 'on' : 'off', stormOn);
  const stormDesc = $('storm-on-desc');
  if (stormDesc) {
    stormDesc.hidden = !stormOn;
    stormDesc.textContent = stormOn
      ? `On until ${Boost.formatUntil(state.until, now)}. It can’t be stopped early, but it can be made longer.`
      : '';
  }

  const risk = Boost.normalizeRisk(store[Boost.RISK_KEY]);
  const riskNow = !!(state && state.active === 'risk');
  setStatusWord($('risk-status'), riskNow ? 'on now' : (risk.enabled ? 'on' : 'off'), risk.enabled);
  const toggle = $('risk-enabled');
  if (toggle) toggle.checked = risk.enabled;
  fillRiskTimes($('risk-start'), risk.start);
  fillRiskTimes($('risk-end'), risk.end);
}

async function changeRiskHours() {
  const { [Boost.RISK_KEY]: stored } = await browserAPI.storage.local.get(Boost.RISK_KEY);
  const prev = Boost.normalizeRisk(stored);
  const next = Boost.normalizeRisk({
    enabled: $('risk-enabled').checked,
    start: Number($('risk-start').value),
    end: Number($('risk-end').value)
  });
  if (!riskTightens(prev, next)) {
    const label = prev.enabled && !next.enabled ? 'turn off your risk hours' : 'shorten your risk hours';
    const now = await guardWeakening(label, {}, { kind: 'risk-hours', payload: { risk: next } });
    if (!now) {
      await renderHardMoments();
      return;
    }
  }
  await browserAPI.storage.local.set({ [Boost.RISK_KEY]: next });
  await askBackground({ type: 'boost_reconcile' });
  showToast(next.enabled
    ? `Risk hours set: ${Boost.formatMinutes(next.start)} to ${Boost.formatMinutes(next.end)}, every day.`
    : 'Risk hours are off.', 'success');
  await renderHardMoments();
}

function initHardMoments() {
  if (!Boost || !Moments || !$('own-words-group')) return;

  ['own-words-plan', 'own-words-note', 'own-words-name', 'own-words-phone'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { el.dataset.dirty = 'true'; });
  });
  $('own-words-save').addEventListener('click', async () => {
    const words = Moments.normalizeWords({
      plan: $('own-words-plan').value,
      note: $('own-words-note').value,
      person: { name: $('own-words-name').value, phone: $('own-words-phone').value }
    });
    await browserAPI.storage.local.set({ [Moments.WORDS_KEY]: words });
    ['own-words-plan', 'own-words-note', 'own-words-name', 'own-words-phone'].forEach((id) => {
      const el = $(id);
      if (el) delete el.dataset.dirty;
    });
    const phoneHint = $('own-words-phone-hint');
    if (phoneHint) {
      setHint(phoneHint, words.person.phone && !Moments.telHref(words.person.phone)
        ? 'That doesn’t look like a phone number, so it shows as written, without a call link.'
        : 'Optional. Where calls are possible, the blocked page links to it.');
    }
    showToast(Moments.hasWords(words)
      ? 'Your words are saved. They’re the first thing on a held page.'
      : 'Your words are cleared.', 'success');
    await renderHardMoments();
  });

  document.querySelectorAll('[data-storm-hours]').forEach((button) => {
    button.addEventListener('click', async () => {
      const hours = Number(button.dataset.stormHours);
      const now = Date.now();
      const length = hours === 1 ? '1 hour' : `${hours} hours`;
      const start = await createModal({
        title: `Start Storm Mode for ${length}?`,
        description: `Until about ${Boost.formatUntil(now + hours * 3600000, now)}, every protection is at its strongest and nothing that loosens it can be changed. It can’t be stopped early.`,
        buttons: [
          { text: 'Cancel', type: 'secondary', value: false },
          { text: 'Start Storm Mode', type: 'primary', value: true }
        ]
      });
      if (!start) return;
      const reply = await askBackground({ type: 'boost_storm_start', hours });
      if (reply && reply.ok) {
        showToast(`Storm Mode is on until ${Boost.formatUntil(reply.until, Date.now())}.`, 'success');
      } else {
        showToast('Storm Mode didn’t start. Try again.', 'error');
      }
      await render();
    });
  });

  $('risk-enabled').addEventListener('change', changeRiskHours);
  $('risk-start').addEventListener('change', changeRiskHours);
  $('risk-end').addEventListener('change', changeRiskHours);

  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[Boost.STATE_KEY] || changes[Boost.RISK_KEY] || changes[Moments.WORDS_KEY]) renderHardMoments();
  });
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

// Said plainly: what has been kept, never a judgement of the person.
function getStreakMessage(days) {
  if (days >= 365) return 'More than a year of protection, kept one day at a time.';
  if (days >= 180) return 'Half a year of protection, kept one day at a time.';
  if (days >= 90) return 'Three months of protection.';
  if (days >= 30) return 'A month of protection.';
  if (days >= 14) return 'Two weeks of protection.';
  if (days >= 7) return 'A week of protection.';
  if (days >= 1) return 'Your days of protection have started.';
  return 'Protection was turned on recently.';
}

const COMMITMENT_SENTENCE = 'By typing this sentence, I acknowledge that I am consciously choosing to override the protection I previously put in place to guard my focus, discipline, and personal growth. I understand that this action directly contradicts the commitment I made to become a stronger, more self-controlled, and purpose-driven version of myself. I accept full responsibility for this decision, including any negative impact it may have on my goals, my time, my mental clarity, and my long-term well-being. I recognize that this choice is not accidental, not forced, and not automatic it is entirely mine. I understand that I am stepping away from the standards I set for myself, and I do so knowingly, without excuses, and without blaming circumstances, emotions, or external triggers. I acknowledge that growth requires consistency and integrity, and by proceeding, I am choosing short-term gratification over long-term self-respect. I accept that this action reflects my current priorities, and I take complete ownership of whatever follows as a result of this decision.';

async function showCommitmentGate() {
  const overlay = $('commitment-overlay');
  if (!overlay) return false;
  const opener = document.activeElement;

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
  const firstChoice = $('commitment-keep-btn');
  if (firstChoice) setTimeout(() => firstChoice.focus(), 0);

  return new Promise(resolve => {
    let currentStep = 1;
    let handleOverlayKey = null;

    const cleanup = () => {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      if (handleOverlayKey) document.removeEventListener('keydown', handleOverlayKey);
      if (opener && document.contains(opener) && typeof opener.focus === 'function') {
        try { opener.focus({ preventScroll: true }); } catch (_) {}
      }
    };

    const goToStep = (step) => {
      currentStep = step;
      steps.forEach(s => s.classList.add('hidden'));
      steps[step - 1].classList.remove('hidden');
      updateCommitmentProgress(step);

      if (step === 1 && $('commitment-keep-btn')) $('commitment-keep-btn').focus();
      if (step === 2 && reflectInput) {
        reflectInput.focus();
        const reflectError = $('commitment-reflect-error');
        if (reflectError) reflectError.textContent = '';
        reflectInput.removeAttribute('aria-invalid');
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
        matchIndicator.textContent = 'It matches.';
        matchIndicator.className = 'commitment-match valid';
      } else if (target.startsWith(current)) {
        matchIndicator.textContent = 'Keep typing…';
        matchIndicator.className = 'commitment-match partial';
      } else {
        matchIndicator.textContent = 'It doesn’t match yet. Check the spelling.';
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
        if (reflectError) reflectError.textContent = 'Write a little more: at least 10 characters.';
        if (reflectInput) reflectInput.setAttribute('aria-invalid', 'true');
        return;
      }
      if (reflectError) reflectError.textContent = '';
      if (reflectInput) reflectInput.removeAttribute('aria-invalid');
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
        if (confirmError) confirmError.textContent = 'The sentence doesn’t match. Type it exactly as shown.';
        if (confirmInput) confirmInput.setAttribute('aria-invalid', 'true');
        return;
      }
      if (confirmError) confirmError.textContent = '';
      if (confirmInput) confirmInput.removeAttribute('aria-invalid');
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

    handleOverlayKey = (e) => {
      if (e.key === 'Escape' && currentStep === 1) {
        cleanup();
        resolve(false);
      }
    };
    document.addEventListener('keydown', handleOverlayKey);
  });
}

// Turning protection off. With a Pact the wait replaces the commitment
// sentence; without one, the PIN, the access code and the sentence apply as
// they always have. Resolves true when protection was turned off now.
async function disableProtectionFlow() {
  if (await refusedByBoost()) return false;
  const pact = await readPact();
  if (Pact && Pact.isActive(pact)) {
    const now = await guardWeakening('turn protection off', { critical: true }, { kind: 'disable', payload: {} });
    if (!now) return false;
  } else {
    const ok = await requirePINIfSet('disable blocking', { critical: true });
    if (!ok) return false;
    const committed = await showCommitmentGate();
    if (!committed) return false;
  }
  const s = await getSettings();
  s.enabled = false;
  await setSettings(s);
  await resetStreak();
  return true;
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

/**
 * Normalise a list box into what gets stored: blank lines dropped, entries
 * de-duplicated case-insensitively, and sorted A–Z.
 *
 * Comments are not sorted at all. They stay on the line where they were
 * written, and entries are sorted only within the stretch between two
 * comments, so a note works as a section heading: `# A` keeps every entry
 * written under it, in order, until the next note. A list with no comments is
 * one stretch and sorts exactly as a plain list.
 *
 * This replaced sorting in blocks, where each note travelled with the single
 * entry below it. That broke the common case of a heading over several
 * entries: under `# A`, `/anana/` sorted ahead of `/apricot/`, the entry the
 * heading was attached to, and landed above the heading.
 *
 * Comments are never de-duplicated, since two `# ---` rules are both meant to
 * be there. A repeated entry is dropped wherever it appears after the first, so
 * the first spelling wins, even across sections.
 */
function serializePatterns(text) {
  const seen = new Set();
  const out = [];
  let stretch = [];

  const flushStretch = () => {
    stretch.sort((a, b) => {
      const byName = entrySortKey(a).localeCompare(
        entrySortKey(b), undefined, { sensitivity: 'base' }
      );
      // `/porn/` and `porn` file under the same name; compare the raw text so
      // the order of the pair is settled rather than left to the sort's stability.
      return byName !== 0
        ? byName
        : a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    for (const entry of stretch) out.push(entry);
    stretch = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;

    if (isCommentLine(entry)) {
      flushStretch();
      out.push(entry);
      continue;
    }

    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    stretch.push(entry);
  }
  flushStretch();
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

// The entries themselves, as they were written, for a Pact change to carry.
function removedEntries(prev, next) {
  const nextSet = normalizeEntries(next);
  return (Array.isArray(prev) ? prev : []).filter(item => !nextSet.has(String(item).toLowerCase()));
}

function addedEntries(prev, next) {
  const prevSet = normalizeEntries(prev);
  return (Array.isArray(next) ? next : []).filter(item => !prevSet.has(String(item).toLowerCase()));
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
  const count = subscription.entryCount || 0;
  const rules = `${count.toLocaleString()} ${count === 1 ? 'rule' : 'rules'}`;

  if (subscription.error) {
    let text = `Update failed: ${subscription.error}`;
    if (subscription.retryAfterAt && subscription.retryAfterAt > Date.now()) {
      text += ` · will try again after ${new Date(subscription.retryAfterAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    // A failed refresh leaves the last good download in force. Saying only
    // "failed" made a working list look like it was blocking nothing.
    if (count && subscription.updatedAt) {
      text += ` · still blocking the ${rules} from ${new Date(subscription.updatedAt).toLocaleString()}`;
    }
    return text;
  }
  if (!subscription.updatedAt) return 'Not downloaded yet';

  const when = new Date(subscription.updatedAt).toLocaleString();
  let text = `${rules} · updated ${when}`;
  // Say so out loud rather than quietly applying a partial list.
  if (subscription.truncated) text += ' · list was too long and was cut short';
  if (subscription.skipped) text += ` · ${subscription.skipped} unusable ${subscription.skipped === 1 ? 'line' : 'lines'} skipped`;
  return text;
}

/**
 * One line for the toast after "Update Now". It used to say "Subscriptions
 * updated" whatever happened, including when every list failed.
 *
 * @returns {[string, string]} message and toast type
 */
function subscriptionRefreshSummary(results) {
  if (results.length === 0) return ['No enabled lists to update', 'info'];

  const failed = results.filter((result) => result && result.checked && !result.ok).length;
  if (failed) {
    return [failed === results.length
      ? (results.length === 1 ? 'The list could not be updated' : 'None of your lists could be updated')
      : `${failed} of ${results.length} lists could not be updated`, 'warning'];
  }

  const checked = results.filter((result) => result && result.checked);
  if (checked.length === 0) {
    // Nothing was downloaded: every list was checked moments ago, or its
    // server asked to be left alone for a while.
    if (results.some((result) => result && result.reason === 'rate-limited')) {
      return ["The list's server asked BlockNSFW to wait. It will try again later.", 'warning'];
    }
    return ['Already checked in the last few minutes', 'info'];
  }
  return checked.some((result) => result.changed)
    ? ['Subscriptions updated', 'success']
    : ['Subscriptions are up to date', 'success'];
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

  container.textContent = '';
  if (subscriptions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'domain-empty whitelist-empty';
    empty.textContent = 'You don’t follow any lists yet.';
    container.appendChild(empty);
    return;
  }

  subscriptions.forEach((subscription) => {
    const row = document.createElement('div');
    row.className = 'domain-row subscription-row';
    if (subscription.enabled === false) row.dataset.state = 'off';

    const info = document.createElement('div');
    info.className = 'domain-main';

    const name = document.createElement('span');
    name.className = 'subscription-name';
    name.textContent = subscription.name || subscription.url;
    info.appendChild(name);

    const url = document.createElement('span');
    url.className = 'domain';
    url.textContent = subscription.url;
    url.title = subscription.url;
    info.appendChild(url);

    const status = document.createElement('span');
    status.className = 'domain-meta' + (subscription.error ? ' is-problem' : '');
    status.textContent = (subscription.enabled === false ? 'Off · ' : '') + subscriptionStatusText(subscription);
    info.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'row-control';

    const label = subscription.name || subscription.url;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-sm';
    toggle.textContent = subscription.enabled === false ? 'Turn on' : 'Turn off';
    toggle.setAttribute('aria-label', `${subscription.enabled === false ? 'Turn on' : 'Turn off'} ${label}`);
    toggle.addEventListener('click', async () => {
      // Turning a list off stops it blocking, which is a protection-weakening
      // change and gated like every other one. Turning it back on is not.
      if (subscription.enabled !== false) {
        const allowed = await guardWeakening(`turn off the list ${label}`, {},
          { kind: 'subscription', payload: { id: subscription.id, action: 'off' } });
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
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-sm';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', async () => {
      const allowed = await guardWeakening(`remove the list ${label}`, {},
        { kind: 'subscription', payload: { id: subscription.id, action: 'remove' } });
      if (!allowed) return;
      const confirmed = await showConfirmModal({
        title: 'Remove this list?',
        description: `${subscription.name || subscription.url} blocks ${(subscription.entryCount || 0).toLocaleString()} entries now. Removing it stops all of them.`,
        confirmText: 'Remove list',
        destructive: true
      });
      if (!confirmed) return;
      await browserAPI.runtime.sendMessage({ type: 'subscription_remove', id: subscription.id });
      showToast('List removed.', 'success');
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
  
  container.textContent = '';

  if (whitelist.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'domain-empty whitelist-empty';
    empty.textContent = 'No sites are whitelisted.';
    container.appendChild(empty);
    return;
  }

  whitelist.forEach(item => {
    const addedDate = new Date(item.addedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const label = item.path ? item.domain + item.path : item.domain;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'domain-row';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'domain-main';

    const domainStrong = document.createElement('span');
    domainStrong.className = 'domain';
    domainStrong.textContent = label;
    domainStrong.title = label;

    const dateDiv = document.createElement('span');
    dateDiv.className = 'domain-meta';
    const scope = item.path ? 'Page only · ' : '';
    dateDiv.textContent = item.type === 'temporary' && item.expiresAt
      ? `${scope}Until ${new Date(item.expiresAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
      : `${scope}Added ${addedDate}`;

    infoDiv.appendChild(domainStrong);
    infoDiv.appendChild(dateDiv);

    // Removing an entry tightens protection, so it is a plain text action.
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn-text';
    removeButton.textContent = 'Remove';
    removeButton.setAttribute('aria-label', `Remove ${label} from the whitelist`);
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

// --- Blocked page design ----------------------------------------------------
//
// The picker is built from blocked-themes.js, the registry blocked.html renders
// from, so a design added there appears here too. Each thumbnail is a CSS
// sketch styled in options.html.

function buildDesignThumb(id) {
  const thumb = document.createElement('span');
  thumb.className = 'design-thumb design-thumb-' + id;
  thumb.setAttribute('aria-hidden', 'true');
  const part = (className, parent = thumb, text = '') => {
    const span = document.createElement('span');
    span.className = className;
    if (text) span.textContent = text;
    parent.appendChild(span);
    return span;
  };
  if (id === 'classic') {
    const card = part('t-card');
    part('t-dot', card);
    part('t-line', card);
    part('t-line t-short', card);
  } else if (id === 'calm') {
    part('t-line');
    part('t-line t-short');
    const ns = 'http://www.w3.org/2000/svg';
    const ring = document.createElementNS(ns, 'svg');
    ring.setAttribute('class', 't-enso');
    ring.setAttribute('viewBox', '0 0 40 40');
    const stroke = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: 15, transform: 'rotate(120 20 20)', 'stroke-dasharray': '88 95' })) {
      stroke.setAttribute(k, String(v));
    }
    ring.appendChild(stroke);
    thumb.appendChild(ring);
    part('t-seal');
  } else if (id === 'verse') {
    part('t-joint t-joint-v');
    part('t-joint t-joint-v t-joint-far');
    part('t-joint t-joint-h');
    part('t-light t-upright');
    part('t-light t-arm');
    part('t-context');
    const text = part('t-text');
    part('t-line', text);
    part('t-line', text);
    part('t-line', text);
    part('t-line t-short', text);
  } else if (id === 'motivation') {
    // Three weeks of seven days: the first eighteen crossed, the nineteenth today.
    const ns = 'http://www.w3.org/2000/svg';
    const cal = document.createElementNS(ns, 'svg');
    cal.setAttribute('class', 't-calendar');
    cal.setAttribute('viewBox', '0 0 70 30');
    let cells = '';
    let marks = '';
    for (let i = 0; i < 21; i++) {
      const x = (i % 7) * 10;
      const y = Math.floor(i / 7) * 10;
      cells += 'M' + x + ' ' + y + 'h10v10h-10z';
      if (i < 18) marks += 'M' + (x + 2.5) + ' ' + (y + 2.5) + 'l5 5M' + (x + 7.5) + ' ' + (y + 2.5) + 'l-5 5';
    }
    for (const [cls, d] of [['t-cells', cells], ['t-x', marks], ['t-today', 'M41 21h8v8h-8z']]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      cal.appendChild(path);
    }
    thumb.appendChild(cal);
  } else if (id === 'play') {
    // A board of six by five tiles: the river in ink from the spring to the
    // sea, a few loose pieces of empty channel, and the sea's red seal.
    const ns = 'http://www.w3.org/2000/svg';
    const board = document.createElementNS(ns, 'svg');
    board.setAttribute('class', 't-river');
    board.setAttribute('viewBox', '0 0 80 50');
    let cells = '';
    for (let i = 0; i < 30; i++) {
      cells += 'M' + (16 + (i % 6) * 8) + ' ' + (5 + Math.floor(i / 6) * 8) + 'h8v8h-8z';
    }
    for (const [cls, d] of [
      ['t-cells', cells],
      ['t-dry', 'M20 9H36M52 9V17M20 41H36M60 17V25M28 33V41M60 41H64'],
      ['t-ink', 'M8 25H28V17H44V33H72'],
      ['t-waves', 'M73 30q1.5-2 3 0t3 0M73 36q1.5-2 3 0t3 0'],
      ['t-seal', 'M73 40h5v5h-5z']
    ]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      board.appendChild(path);
    }
    const pool = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({ class: 't-pool', cx: 8, cy: 25, r: 2.6 })) pool.setAttribute(k, String(v));
    board.appendChild(pool);
    thumb.appendChild(board);
  }
  return thumb;
}

function buildDesignPicker(picker) {
  const themes = globalThis.BlockedThemes;
  if (!themes || picker.childElementCount) return;
  for (const theme of themes.list) {
    const option = document.createElement('label');
    option.className = 'design-option';
    option.dataset.design = theme.id;

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'blocked-design';
    input.value = theme.id;

    const name = document.createElement('span');
    name.className = 'design-name';
    name.textContent = theme.name;

    const blurb = document.createElement('span');
    blurb.className = 'design-blurb';
    blurb.textContent = theme.blurb;

    // A link inside a label follows the link without selecting the option.
    const preview = document.createElement('a');
    preview.className = 'design-preview';
    preview.href = 'blocked.html?preview=' + encodeURIComponent(theme.id);
    preview.target = '_blank';
    preview.rel = 'noopener';
    preview.textContent = 'Preview';
    preview.setAttribute('aria-label', `Preview the ${theme.name} design`);

    option.append(input, buildDesignThumb(theme.id), name, blurb, preview);
    picker.appendChild(option);
  }
}

function renderDesignPicker(settings) {
  const picker = $('blocked-design-picker');
  if (!picker) return;
  buildDesignPicker(picker);
  const themes = globalThis.BlockedThemes;
  const current = themes ? themes.normalize(settings.blockedPageTheme) : 'classic';
  picker.querySelectorAll('.design-option').forEach((option) => {
    const selected = option.dataset.design === current;
    option.classList.toggle('is-selected', selected);
    const input = option.querySelector('input');
    if (input) input.checked = selected;
  });
  // A custom URL or custom HTML replaces the built-in page, designs and all.
  const overridden =
    (settings.blockedPageType === 'custom' && !!String(settings.customBlockedPageUrl || '').trim()) ||
    (settings.blockedPageType === 'plain_html' && !!String(settings.plainBlockedPageHtml || '').trim());
  picker.classList.toggle('is-overridden', overridden);
  const note = $('blocked-design-note');
  if (note) note.hidden = !overridden;
}

// A status is a word in a meta label: pine when the thing is on, ink-3 when
// it is off. No dots, no colours of its own.
function setStatusWord(el, word, on) {
  if (!el) return;
  el.textContent = word;
  el.dataset.state = on ? 'on' : 'off';
  el.removeAttribute('style');
}

// The sentence beside each guarded control says what changing it will ask
// for, so nothing is ever greyed out without a reason. It reads the same
// settings the gates read and decides nothing itself.
// Markup: data-lock="<tier>" (critical, normal or tuning), plus " set" where
// the gate makes you create a PIN first, and data-lock-when for what triggers
// it ("Turning it off"). With nothing to ask, the note stays hidden.
function renderLockNotes(hasPin, accessCode, pact) {
  const asks = (tier) => !!accessCodeRequiredFor(accessCode, tier);
  const waits = Pact && Pact.isActive(pact) ? Pact.formatDelay(pact.delayMs) : null;
  const predicate = (tier, mustSetPin) => {
    // Under a Pact the wait is what stands in the way; the dials still only
    // ask for the PIN.
    if (waits && tier !== 'tuning') return `waits ${waits}`;
    const code = asks(tier);
    if (!hasPin && mustSetPin) return code
      ? 'asks you to set a PIN first, then for an access code'
      : 'asks you to set a PIN first';
    if (!hasPin) return code ? 'asks for an access code' : '';
    return code ? 'asks for your PIN and an access code' : 'asks for your PIN';
  };
  const textFor = (el) => {
    const [tier, mode] = String(el.dataset.lock).split(' ');
    return predicate(tier, mode === 'set');
  };
  document.querySelectorAll('[data-lock]').forEach((el) => {
    const text = textFor(el);
    el.textContent = text ? `${el.dataset.lockWhen || 'Changing this'} ${text}.` : '';
    el.hidden = !text;
  });
  // A pact's wait replaces the commitment steps, so their note goes with it.
  document.querySelectorAll('[data-unless-pact]').forEach((el) => { el.hidden = !!waits; });

  // When every guarded control in a section asks for the same thing, say it
  // once under the section head instead of under every row. The dials keep
  // their own line: they never wait.
  document.querySelectorAll('.section').forEach((section) => {
    const notes = [...section.querySelectorAll('[data-lock]')]
      .filter((el) => String(el.dataset.lock).split(' ')[0] !== 'tuning');
    const texts = notes.map(textFor);
    const shared = notes.length > 1 && texts[0] && texts.every((t) => t === texts[0]) ? texts[0] : '';
    const header = section.querySelector(':scope > .section-header');
    let line = header && header.querySelector(':scope > .section-lock');
    if (!line && shared && header) {
      line = document.createElement('p');
      line.className = 'section-lock';
      header.appendChild(line);
    }
    if (line) {
      line.textContent = !shared ? ''
        : (waits && shared === `waits ${waits}`
          ? `Under your pact, anything here that loosens protection waits ${waits}.`
          : `Anything here that loosens protection ${shared}.`);
      line.hidden = !shared;
    }
    if (shared) notes.forEach((el) => { el.hidden = true; });
  });
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

  $('blocked-stats').textContent = (Number(stats.blockedCount) || 0).toLocaleString();
  setStatusWord($('pin-status'), pinIsSet(pin) ? 'set' : 'not set', pinIsSet(pin));
  // Nothing to clear without a PIN; with one, the same button changes it.
  const clearPinRow = $('clear-pin') && $('clear-pin').closest('.btn-row');
  if (clearPinRow) clearPinRow.hidden = !pinIsSet(pin);
  if ($('set-pin')) $('set-pin').textContent = pinIsSet(pin) ? 'Change PIN' : 'Set PIN';
  renderLockNotes(pinIsSet(pin), await getAccessCodeConfig(), await readPact());
  await renderPact();
  await renderHardMoments();

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
  const dnsProviders = (self.DnsProviders && self.DnsProviders.DNS_PROVIDERS) || [];
  const isCustomDns = settings.dnsProvider === CUSTOM_DNS_ID;
  const activeDnsProvider =
    dnsProviders.find((p) => p.id === settings.dnsProvider) || dnsProviders[0] || null;

  const dnsProviderSelect = $('dns-provider');
  if (dnsProviderSelect) {
    // Built from the shared registry rather than hardcoded <option>s so adding
    // a resolver is a one-line change in shared/dns-providers.js.
    if (dnsProviderSelect.options.length !== dnsProviders.length + 1) {
      dnsProviderSelect.innerHTML = '';
      dnsProviders.forEach((provider) => {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = `${provider.label} — ${provider.blocks}`;
        dnsProviderSelect.appendChild(option);
      });
      const customOption = document.createElement('option');
      customOption.value = CUSTOM_DNS_ID;
      customOption.textContent = 'Custom — your own DoH address';
      dnsProviderSelect.appendChild(customOption);
    }
    dnsProviderSelect.value = isCustomDns ? CUSTOM_DNS_ID : (activeDnsProvider ? activeDnsProvider.id : '');
    dnsProviderSelect.disabled = !settings.dnsFilterEnabled;
  }

  const dnsProviderDetail = $('dns-provider-detail');
  if (dnsProviderDetail) {
    dnsProviderDetail.textContent = isCustomDns
      ? 'Queries go only to the address below. Unlike the presets, a custom resolver has no second resolver to fall back on — that is deliberate, so your choice of who sees your browsing is never quietly overridden.'
      : (activeDnsProvider ? activeDnsProvider.note : '');
  }

  const dnsCustomRow = $('dns-custom-row');
  if (dnsCustomRow) dnsCustomRow.hidden = !isCustomDns;
  const dnsCustomInput = $('dns-custom-url');
  if (dnsCustomInput && document.activeElement !== dnsCustomInput) {
    dnsCustomInput.value = settings.dnsCustomUrl || '';
    dnsCustomInput.disabled = !settings.dnsFilterEnabled;
  }

  const dnsBadge = $('dns-status');
  if (dnsBadge) {
    if (settings.dnsFilterEnabled) {
      setStatusWord(dnsBadge, isCustomDns
        ? 'on · custom resolver'
        : (activeDnsProvider ? `on · ${activeDnsProvider.label}` : 'on'), true);
    } else {
      setStatusWord(dnsBadge, 'off', false);
    }
  }
  const dnsProviderLocked = $('dns-provider-locked');
  if (dnsProviderLocked) dnsProviderLocked.hidden = !!settings.dnsFilterEnabled;

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
  // Each of these switches already shows its own state; the status words are
  // kept for screen readers and anything that reads them.
  setStatusWord($('safe-search-status'), safeSearchOn ? 'Safe Search on' : 'Safe Search off', safeSearchOn);
  setStatusWord($('facebook-reels-status'), facebookReelsOn ? 'Facebook Reels hidden' : 'Facebook Reels shown', facebookReelsOn);
  setStatusWord($('instagram-reels-status'), instagramReelsOn ? 'Instagram Reels hidden' : 'Instagram Reels shown', instagramReelsOn);

  // Render AI Image Blocker
  const aiImageBlockerOn = settings.aiImageBlocker !== false;
  const aiImageBlockerToggle = $('ai-image-blocker');
  if (aiImageBlockerToggle) {
    aiImageBlockerToggle.checked = aiImageBlockerOn;
  }
  setStatusWord($('ai-image-blocker-status'), aiImageBlockerOn ? 'on' : 'off', aiImageBlockerOn);
  const aiImageScanAllToggle = $('ai-image-scan-all');
  if (aiImageScanAllToggle) {
    aiImageScanAllToggle.checked = settings.aiImageScanAllSites !== false;
  }
  renderAiImageModel(settings);

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
  setStatusWord($('ai-text-blocker-status'), aiTextBlockerOn ? 'on' : 'off', aiTextBlockerOn);
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
      ? 'Your HTML page is saved.'
      : 'No HTML file yet.';
  }
  renderDesignPicker(settings);
  
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
      setStatusWord(badge, allowed ? 'allowed' : 'not allowed', !!allowed);
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
    if (window.BlockNSFWSettings) window.BlockNSFWSettings.reveal(input);
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
    title: 'Open the extensions page',
    description: 'Your browser doesn’t let an extension open this page itself.',
    code: manageUrl,
    message: 'The link is copied. Paste it into the address bar, then turn on “Allow in incognito”.',
    buttons: [
      { text: 'Copy the link again', type: 'secondary', onClick: () => { try { navigator.clipboard.writeText(manageUrl); } catch(_) {}; return true; } },
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
        ? ' · ' + info.notes.trim() : '';
      sub.textContent = `Version ${info.latest} is ready. You have ${info.current}.${notes}`;
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

// --- Sieve sidebar promo --------------------------------------------------
// options.html ships byte-identical to every bundle, so the store link for the
// companion extension has to be chosen here. Mirrors detectBrowserKey() in
// background.js: Edge's UA also carries "Chrome/", so it must be tested first.
// Chromium forks (Brave, Opera, Vivaldi) fall through to the Chrome Web Store,
// which is where they install from anyway.
function applySievePromoLink() {
  const promo = $('sieve-promo');
  if (!promo) return;
  const key = BrowserKey.detectBrowserKey();
  const url = promo.dataset[`store${key.charAt(0).toUpperCase()}${key.slice(1)}`];
  // Leave the markup's Chrome fallback in place if this browser has no entry.
  if (url) promo.href = url;
}


// The theme: system, light or dark. ui/scheme.js keeps the choice and applies
// it; this only connects the three radios. It changes how pages look, not
// what is blocked, so no PIN or access code stands in front of it.
function setupColorSchemePicker() {
  const picker = $('color-scheme-picker');
  if (!picker || typeof UiScheme === 'undefined') return;
  const radios = Array.from(picker.querySelectorAll('input[name="color-scheme"]'));
  const show = (scheme) => {
    radios.forEach((radio) => { radio.checked = radio.value === scheme; });
  };
  show(UiScheme.get());
  UiScheme.onChange(show);
  radios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      UiScheme.set(radio.value).catch(() => {
        showToast('The theme couldn’t be saved. It applies until you close this page.', 'error');
      });
    });
  });
}

async function init() {
  setupColorSchemePicker();
  // Before the first render, so the boxes never show an unmigrated list.
  await migrateCommentSyntaxOnce();
  // Before render() too, so the first list painted is already highlighted.
  setupListSyntaxHighlighting();
  initPact();
  initHardMoments();
  await render();

  // Update-available banner
  const dismissBtn = $('update-banner-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', dismissUpdateBanner);
  await renderUpdateBanner();
  requestUpdateCheck();

  // Companion-extension promo in the sidebar
  applySievePromoLink();

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
        showToast('The report form didn’t load. Reload this page to try again.', 'error');
        return;
      }

      const raw = (urlInput.value || '').trim();
      if (!raw) {
        showToast('Enter the address of the site first.', 'error');
        urlInput.focus();
        return;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
      } catch {
        showToast('That doesn’t look like a web address. Check it and try again.', 'error');
        urlInput.focus();
        return;
      }

      if (!/^https?:$/i.test(parsedUrl.protocol)) {
        showToast('Only addresses that start with http:// or https:// can be reported.', 'error');
        urlInput.focus();
        return;
      }

      const domain = validateDomain(parsedUrl.hostname);
      if (!domain) {
        showToast('That doesn’t look like a website. Check the address and try again.', 'error');
        urlInput.focus();
        return;
      }

      if (!typeSelect.value) {
        showToast('Choose what kind of report this is.', 'error');
        typeSelect.focus();
        return;
      }

      submitReportBtn.disabled = true;
      submitReportBtn.setAttribute('aria-busy', 'true');
      submitReportBtn.textContent = 'Sending…';
      setHint(statusHint, 'Sending your report…');

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
        showToast('Report sent. Thank you.', 'success');
        setHint(statusHint, remaining > 0
          ? `Report sent. You can send ${remaining} more today.`
          : 'Report sent. That was your last report for today.', 'success');

        urlInput.value = '';
        notesInput.value = '';
        const counter = $('report-notes-counter');
        if (counter) {
          counter.textContent = '0 / 500';
          counter.classList.remove('is-near-limit');
        }
        updateReportCooldown();
      } catch (error) {
        showToast(error.message || 'The report didn’t send. Try again in a minute.', 'error');
        setHint(statusHint, error.message || 'The report didn’t send. Try again in a minute.', 'error');
      } finally {
        submitReportBtn.removeAttribute('aria-busy');
        submitReportBtn.textContent = 'Send report';
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
        notesCounter.textContent = len >= 450 ? `${len} / 500 · near the limit` : `${len} / 500`;
        notesCounter.classList.toggle('is-near-limit', len >= 450);
      });
    }
  }

  $('enabled').addEventListener('change', async (e) => {
    const s = await getSettings();
    if (s.enabled && !e.target.checked) {
      const turnedOff = await disableProtectionFlow();
      if (!turnedOff) e.target.checked = true;
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
    const ok = s.useSmartBlocking && !e.target.checked
      ? await guardWeakening('turn off smart detection', {}, settingsChange({ useSmartBlocking: false }))
      : await requirePINIfSet('switch modes');
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
      // Raising the level is free; lowering it loosens protection. It's a
      // sensitivity dial, not a way out, so the PIN guards it but the access
      // code never does — see TIERS in shared/access-code.js.
      if (weakensImageFilter(settings.imageFilterLevel, nextLevel)) {
        const ok = !(await refusedByBoost()) && await requirePINIfSet('lower image filtering', { tier: 'tuning' });
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
      // A dial, not a switch: at Relaxed the blocker is still on and still
      // catches clearly explicit images, so this is 'tuning' (no access code).
      if (weakensAiStrictness(settings.aiStrictness, nextStrictness)) {
        const ok = !(await refusedByBoost()) && await requirePINIfSet('lower AI image strictness', { tier: 'tuning' });
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
        const ok = !(await refusedByBoost()) && await requirePINIfSet('lower AI text strictness', { tier: 'tuning' });
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
        const ok = await guardWeakening('turn off DNS Protection', {}, settingsChange({ dnsFilterEnabled: false }));
        if (!ok) {
          e.target.checked = true;
          return;
        }
      }
      settings.dnsFilterEnabled = e.target.checked;
      await setSettings(settings);
      await render();
      const enabledProvider =
        self.DnsProviders && self.DnsProviders.getProviderOrDefault(settings.dnsProvider);
      showToast(
        e.target.checked
          ? `DNS Protection enabled — domains will be checked via ${
              enabledProvider ? enabledProvider.label : 'a family-safe resolver'
            }`
          : 'DNS Protection disabled',
        e.target.checked ? 'success' : 'info'
      );
    });
  }

  // DNS resolver choice. Not PIN-gated: every resolver in the list blocks adult
  // content, so switching between them swaps who answers the query rather than
  // weakening the layer — unlike turning DNS off entirely, which is gated above.
  // The one exception is a resolver of your own, which may not filter at all:
  // under a Pact, switching to it waits.
  const dnsProviderSelectEl = $('dns-provider');
  if (dnsProviderSelectEl) {
    dnsProviderSelectEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (e.target.value === CUSTOM_DNS_ID && settings.dnsProvider !== CUSTOM_DNS_ID) {
        const ok = await guardIfPact('use your own DNS resolver', settingsChange({ dnsProvider: CUSTOM_DNS_ID }));
        if (!ok) {
          e.target.value = settings.dnsProvider;
          return;
        }
      }
      settings.dnsProvider = e.target.value;
      await setSettings(settings);
      await render();
      if (settings.dnsProvider === CUSTOM_DNS_ID) {
        const input = $('dns-custom-url');
        if (input) input.focus();
        showToast('Enter your DNS-over-HTTPS address below.', 'info');
        return;
      }
      const chosen =
        self.DnsProviders && self.DnsProviders.getProviderOrDefault(settings.dnsProvider);
      showToast(`DNS resolver set to ${chosen ? chosen.label : settings.dnsProvider}`, 'success');
    });
  }

  // Custom DoH address. Saved on blur / Enter rather than on every keystroke —
  // validating mid-typing would flag every half-written URL as an error.
  const dnsCustomInputEl = $('dns-custom-url');
  if (dnsCustomInputEl) {
    const saveCustomDns = async () => {
      const errorEl = $('dns-custom-error');
      const raw = dnsCustomInputEl.value.trim();
      const settings = await getSettings();

      if (!raw) {
        // An empty box is not an error, it is just unfinished. Clear it and say
        // nothing; the resolver stays whatever was last saved.
        if (errorEl) errorEl.textContent = '';
        settings.dnsCustomUrl = '';
        await setSettings(settings);
        return;
      }

      const check = self.DnsProviders
        ? self.DnsProviders.validateCustomDohUrl(raw)
        : { ok: true, url: raw };
      if (!check.ok) {
        if (errorEl) errorEl.textContent = check.error;
        return;
      }

      if (errorEl) errorEl.textContent = '';
      if (check.url !== settings.dnsCustomUrl) {
        const ok = await guardIfPact('change your own DNS resolver', settingsChange({ dnsCustomUrl: check.url }));
        if (!ok) {
          dnsCustomInputEl.value = settings.dnsCustomUrl || '';
          return;
        }
      }
      settings.dnsCustomUrl = check.url;
      await setSettings(settings);
      showToast('Custom resolver saved. Press Test DNS connection to check it.', 'success');
    };

    dnsCustomInputEl.addEventListener('blur', saveCustomDns);
    dnsCustomInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dnsCustomInputEl.blur(); }
    });
  }

  // Safe Search toggle
  const safeSearchToggleEl = $('safe-search-enabled');
  if (safeSearchToggleEl) {
    safeSearchToggleEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      if (settings.safeSearchEnabled === true && !e.target.checked) {
        const ok = await guardWeakening('turn off Safe Search enforcement', {}, settingsChange({ safeSearchEnabled: false }));
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
        const ok = await guardWeakening('turn off Facebook Reels blocking', {}, settingsChange({ facebookReelsEnabled: false }));
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
        const ok = await guardWeakening('turn off Instagram Reels blocking', {}, settingsChange({ instagramReelsEnabled: false }));
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
        const ok = await guardWeakening('turn off the AI image blocker', {}, settingsChange({ aiImageBlocker: false }));
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

  const aiImageModelEl = $('ai-image-model');
  if (aiImageModelEl) {
    aiImageModelEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      settings.aiImageModel = normalizeAiImageModel(e.target.value);
      await setSettings(settings);
      await render();
      // Warming the model here means the download starts while the user is
      // still on this page looking at the progress, instead of silently on
      // whatever page they happen to open next.
      if (settings.aiImageModel !== 'nsfwjs' && settings.aiImageBlocker !== false) {
        askBackground({ type: 'ai_ping_model', model: settings.aiImageModel });
      }
    });
  }

  const aiImageModelDownloadEl = $('ai-image-model-download-btn');
  if (aiImageModelDownloadEl) {
    aiImageModelDownloadEl.addEventListener('click', async () => {
      const settings = await getSettings();
      const modelId = normalizeAiImageModel(settings.aiImageModel);
      aiImageModelDownloadEl.disabled = true;
      aiImageModelDownloadEl.setAttribute('aria-busy', 'true');
      aiImageModelDownloadEl.textContent = 'Downloading…';
      // ai_ping_model resolves only once the weights are loaded, so awaiting
      // it is the download finishing (or failing).
      const res = await askBackground({ type: 'ai_ping_model', model: modelId, forceRetry: true });
      // `ready` alone is NOT success: the service worker falls back to the
      // bundled model rather than leave pages unfiltered, so a fallback also
      // answers ready:true. Only treat this as a completed download if the
      // model we asked for is the one that came up — otherwise the button
      // silently resets and looks broken.
      const succeeded = !!(res && res.ready && res.model === modelId && !res.fellBackFrom);
      if (!succeeded) {
        const detail = $('ai-image-model-detail');
        if (detail) {
          const why = (res && (res.requestedError || res.error)) ||
            'could not reach the model host';
          detail.textContent = 'Download failed: ' + why +
            '. The bundled model is still filtering in the meantime.';
        }
        aiImageModelDownloadEl.disabled = false;
        aiImageModelDownloadEl.removeAttribute('aria-busy');
        aiImageModelDownloadEl.textContent = 'Try the download again';
        return;
      }
      aiImageModelDownloadEl.removeAttribute('aria-busy');
      await render();
    });
  }

  const aiImageModelClearEl = $('ai-image-model-clear-btn');
  if (aiImageModelClearEl) {
    aiImageModelClearEl.addEventListener('click', async () => {
      const settings = await getSettings();
      const modelId = normalizeAiImageModel(settings.aiImageModel);
      // Removing the weights leaves the selected model unusable, so this also
      // narrows protection — gate it like the other weakening actions.
      const ok = await guardWeakening('remove the downloaded detection model', {}, { kind: 'model-clear', payload: { model: modelId } });
      if (!ok) return;
      await askBackground({ type: 'ai_clear_model_weights', model: modelId });
      await render();
    });
  }

  const aiImageScanAllEl = $('ai-image-scan-all');
  if (aiImageScanAllEl) {
    aiImageScanAllEl.addEventListener('change', async (e) => {
      const settings = await getSettings();
      // Turning this off narrows coverage, so gate it behind the PIN if set.
      if (settings.aiImageScanAllSites !== false && !e.target.checked) {
        const ok = await guardWeakening('limit AI image scanning to third-party images', {}, settingsChange({ aiImageScanAllSites: false }));
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
        const ok = await guardWeakening('turn off the AI text blocker', {}, settingsChange({ aiTextBlocker: false }));
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
      setHint(resultEl, 'Testing the resolver…');
      dnsTestBtn.disabled = true;
      dnsTestBtn.setAttribute('aria-busy', 'true');
      try {
        if (!self.DnsProviders) throw new Error('DNS provider list failed to load');
        const settings = await getSettings();
        const provider = self.DnsProviders.resolveProvider(
          settings.dnsProvider,
          settings.dnsCustomUrl
        );

        // Two probes, because reachability alone proves nothing. A resolver
        // that answers but has stopped filtering — hijacked by the network,
        // over quota, or misconfigured — looks identical to a healthy one
        // unless we check that something which *should* be blocked actually is.
        const [adultVerdict, benignVerdict] = await Promise.all([
          self.DnsProviders.queryProvider(provider, 'pornhub.com', 5000),
          self.DnsProviders.queryProvider(provider, 'example.com', 5000),
        ]);

        if (adultVerdict === null && benignVerdict === null) {
          setHint(resultEl,
            `${provider.label} did not respond. Check your internet connection, ` +
            'or pick a different resolver above.', 'error');
        } else if (adultVerdict !== true) {
          setHint(resultEl,
            `${provider.label} is reachable but did not filter a known adult domain. ` +
            'Something on your network may be intercepting DNS. Try another resolver.', 'error');
        } else if (benignVerdict === true) {
          setHint(resultEl,
            `${provider.label} blocked a domain that should be safe. ` +
            'That usually means a captive portal is answering instead of the resolver.', 'error');
        } else {
          setHint(resultEl, `${provider.label} is reachable and filtering correctly.`, 'success');
        }
      } catch (err) {
        setHint(resultEl, `The test didn’t run: ${err.message}. Check your connection and try again.`, 'error');
      } finally {
        dnsTestBtn.disabled = false;
        dnsTestBtn.removeAttribute('aria-busy');
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
    showToast('Blocked page updated.', 'success');
  });

  const addSubscriptionBtn = $('add-subscription');
  if (addSubscriptionBtn) {
    addSubscriptionBtn.addEventListener('click', async () => {
      const input = $('subscription-url');
      const url = (input.value || '').trim();
      if (!url) {
        showToast('Enter the address of a ruleset file first.', 'warning');
        return;
      }

      addSubscriptionBtn.disabled = true;
      addSubscriptionBtn.textContent = 'Downloading…';
      try {
        const result = await browserAPI.runtime.sendMessage({ type: 'subscription_add', url });
        if (!result || !result.ok) {
          showToast((result && result.error) || 'That list couldn’t be added. Check the address and try again.', 'error');
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
        showToast('That list couldn’t be added. Check the address and try again.', 'error');
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
        const response = await browserAPI.runtime.sendMessage({ type: 'subscription_refresh' });
        await renderSubscriptions();
        const [message, type] = subscriptionRefreshSummary((response && response.results) || []);
        showToast(message, type);
      } catch (_) {
        showToast('The lists didn’t update. Try again in a few minutes.', 'error');
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
    showToast('Search results setting saved.', 'success');
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
    showToast('Count setting saved.', 'success');
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
    showToast('Blocked page updated.', 'success');
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
      showToast('Your page’s address is saved.', 'success');
    }
  });

  $('plain-blocked-page-file').addEventListener('change', async (e) => {
    try {
      const input = e.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file) return;

      const maxBytes = 1024 * 1024;
      if (typeof file.size === 'number' && file.size > maxBytes) {
        showToast('That file is over 1 MB. Choose a smaller one.', 'error');
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
      if (plainStatus) plainStatus.textContent = 'Your HTML page is saved.';

      const settings = await getSettings();
      settings.blockedPageType = 'plain_html';
      settings.plainBlockedPageHtml = text;
      settings.customBlockedPageUrl = '';
      await setSettings(settings);
      plainHtmlAvailable = true;
      showToast('Your HTML page is saved.', 'success');
    } catch (_) {
      showToast('That file couldn’t be read. Try another .html file.', 'error');
    }
  });

  $('clear-plain-html').addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      title: 'Remove your HTML page?',
      description: 'The HTML you uploaded is deleted, and the blocked page goes back to the design chosen above.',
      confirmText: 'Remove HTML',
      destructive: true
    });
    if (!confirmed) return;
    const fileInput = $('plain-blocked-page-file');
    if (fileInput) fileInput.value = '';
    const settings = await getSettings();
    settings.plainBlockedPageHtml = '';
    if (settings.blockedPageType === 'plain_html') {
      settings.blockedPageType = 'default';
    }
    await setSettings(settings);
    await render();
    showToast('Your HTML page is removed.', 'success');
  });

  $('test-custom-url').addEventListener('click', async () => {
    const urlInput = $('custom-blocked-page-url');
    const url = urlInput.value.trim();
    const hint = $('url-validation-hint');
    
    if (!url) {
      setHint(hint, 'Enter the address of your page first.', 'error');
      urlInput.setAttribute('aria-invalid', 'true');
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
      setHint(hint, 'That doesn’t look like a web address. It needs to start with http:// or https://.', 'error');
      urlInput.setAttribute('aria-invalid', 'true');
      urlInput.focus();
      return;
    }
    urlInput.removeAttribute('aria-invalid');

    // Test URL accessibility
    setHint(hint, 'Checking the address…');

    try {
      const response = await fetch(url, { method: 'HEAD', mode: 'no-cors' });
      // If we get here, the URL is accessible (even with CORS restrictions)
      setHint(hint, 'The address answers. It will be shown when a page is held.', 'success');
    } catch (error) {
      // Even with no-cors, we might get network errors
      setHint(hint, 'The address didn’t answer. Open it in a tab to check it works.', 'warning');
    }
  });

  const designPicker = $('blocked-design-picker');
  if (designPicker) {
    designPicker.addEventListener('change', async (e) => {
      if (!e.target || e.target.name !== 'blocked-design') return;
      // Presentation only: every design is still the blocked page, so this is
      // not PIN-gated. Replacing the page with your own URL or HTML still is.
      const themes = globalThis.BlockedThemes;
      const settings = await getSettings();
      settings.blockedPageTheme = themes ? themes.normalize(e.target.value) : 'classic';
      await setSettings(settings);
      renderDesignPicker(settings);
      const theme = themes && themes.get(settings.blockedPageTheme);
      showToast(`Blocked page design: ${theme ? theme.name : 'Classic'}`, 'success');
    });
  }

  $('reset-blocked-page-settings').addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      title: 'Reset the blocked page?',
      description: 'The blocked page goes back to Classic, and your own page or HTML is switched off.',
      confirmText: 'Reset blocked page',
      destructive: true
    });
    if (!confirmed) return;

    const settings = await getSettings();
    settings.blockedPageType = 'default';
    settings.blockedPageTheme = DEFAULT_SETTINGS.blockedPageTheme;
    settings.customBlockedPageUrl = '';
    settings.plainBlockedPageHtml = '';

    await setSettings(settings);
    await render();

    showToast('The blocked page is back to Classic.', 'success');
  });

  // Incognito handling
  const incognitoToggle = $('allow-incognito');
  if (incognitoToggle) {
    incognitoToggle.addEventListener('change', async (e) => {
      // We cannot programmatically change incognito access. Open the extensions page.
      try {
        await openExtensionsManagePage();
        showToast('On the extensions page, turn on “Allow in incognito” for BlockNSFW.', 'info');
      } catch (err) {
        showToast('The extensions page didn’t open. Open it yourself and turn on “Allow in incognito”.', 'warning');
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
              setStatusWord($('incognito-status'), allowed ? 'allowed' : 'not allowed', !!allowed);
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
    let nextCustomPatterns = serializePatterns($('patterns').value);
    const customKeywords = $('custom-keywords');
    let nextKeywords = customKeywords
      ? serializePatterns(customKeywords.value)
      : (Array.isArray(settings.customKeywordList) ? settings.customKeywordList : []);
    let nextTrusted = serializePatterns($('trusted-domains').value);
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
    //
    // The tier decides whether the access code joins the PIN: the sensitivity
    // dials are 'tuning' and never face it. A save that mixes a dial with a
    // real loosening takes the stronger of the two, so listing order here
    // can't quietly downgrade the gate.
    const weakenings = [
      [hasRemovals(settings.customPatterns, nextCustomPatterns), 'remove from custom blocklist', 'normal'],
      [hasRemovals(settings.customKeywordList, nextKeywords), 'remove custom blocked words', 'normal'],
      [hasAdditions(settings.trustedImageDomains, nextTrusted), 'add a trusted image domain', 'normal'],
      [weakensImageFilter(settings.imageFilterLevel, nextImageFilterLevel), 'lower image filtering', 'tuning'],
      [weakensAiStrictness(settings.aiStrictness, nextAiStrictness), 'lower AI image strictness', 'tuning'],
      [weakensAiStrictness(settings.aiTextStrictness, nextAiTextStrictness), 'lower AI text strictness', 'tuning']
    ].filter(([applies]) => applies);

    // Under a Pact, the real loosenings in this save (entries removed, trusted
    // sites added) wait, and everything else in it saves now. The dials are
    // 'tuning' and never wait, but they keep their PIN check.
    if (weakenings.length && await refusedByBoost()) return;
    const pact = await readPact();
    const realLoosening = weakenings.filter(([, , t]) => t === 'normal');
    let queued = false;
    if (Pact && Pact.isActive(pact) && realLoosening.length) {
      const removedPatterns = removedEntries(settings.customPatterns, nextCustomPatterns);
      const removedKeywords = customKeywords ? removedEntries(settings.customKeywordList, nextKeywords) : [];
      const addedTrusted = addedEntries(settings.trustedImageDomains, nextTrusted);
      const outcome = await guardWeakeningOutcome(realLoosening[0][1], { tier: 'normal' }, {
        kind: 'settings',
        payload: {
          removeFrom: { customPatterns: removedPatterns, customKeywordList: removedKeywords },
          addTo: { trustedImageDomains: addedTrusted }
        }
      });
      if (outcome === 'cancelled') return;
      if (outcome === 'queued') {
        queued = true;
        nextCustomPatterns = serializePatterns(nextCustomPatterns.concat(removedPatterns).join('\n'));
        nextKeywords = serializePatterns(nextKeywords.concat(removedKeywords).join('\n'));
        nextTrusted = removedEntries(nextTrusted, addedTrusted);
      }
      const dials = weakenings.filter(([, , t]) => t === 'tuning');
      if (dials.length && !(await requirePINIfSet(dials[0][1], { tier: 'tuning' }))) return;
    } else if (weakenings.length) {
      const tier = weakenings.some(([, , t]) => t === 'normal') ? 'normal' : 'tuning';
      const ok = await requirePINIfSet(weakenings[0][1], { tier });
      if (!ok) return;
    }

    // Save can switch these on but never off: turning them off goes through
    // their own switches, which are gated. Copying the boxes straight across
    // let a box unticked mid-dialog slip past every lock.
    settings.enabled = settings.enabled || $('enabled').checked;
    settings.useSmartBlocking = settings.useSmartBlocking || $('smart').checked;
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
    if (!queued) showToast('Settings saved.', 'success');
  });

  $('refresh-blocklist').addEventListener('click', async () => {
    const btn = $('refresh-blocklist');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Refreshing…';
    try {
      const response = await browserAPI.runtime.sendMessage({ type: 'refresh_remote_blocklist' });
      if (response?.success) {
        showToast(`Blocklist updated — ${(response.count || 0).toLocaleString()} domains loaded`, 'success');
      } else {
        showToast('The blocklist didn’t refresh: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('The blocklist didn’t refresh: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Refresh blocklist';
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
      let saving = nextKeywords;
      let queued = false;
      if (hasRemovals(settings.customKeywordList, nextKeywords)) {
        // Under a Pact the removals wait; anything added saves now.
        const removed = removedEntries(settings.customKeywordList, nextKeywords);
        const outcome = await guardWeakeningOutcome('remove custom blocked words', {},
          { kind: 'settings', payload: { removeFrom: { customKeywordList: removed } } });
        if (outcome === 'cancelled') return;
        if (outcome === 'queued') {
          queued = true;
          saving = serializePatterns(nextKeywords.concat(removed).join('\n'));
        }
      }
      settings.customKeywordList = saving;
      await setSettings(settings);
      $('custom-keywords').value = deserializePatterns(saving);
      if (!queued) showToast('Blocked words saved.', 'success');
    });
  }

  const resetKeywords = $('reset-keywords');
  if (resetKeywords) {
    resetKeywords.addEventListener('click', async () => {
      const current = (await getSettings()).customKeywordList;
      const ok = await guardWeakening('reset custom blocked words', {},
        { kind: 'settings', payload: { removeFrom: { customKeywordList: current } } });
      if (!ok) return;
      const confirmed = await showConfirmModal({
        title: 'Reset your blocked words?',
        description: 'Your list of blocked words goes back to its default, which is empty.',
        confirmText: 'Reset blocked words',
        destructive: true
      });
      if (!confirmed) return;
      const settings = await getSettings();
      settings.customKeywordList = [];
      await setSettings(settings);
      await render();
    });
  }

  const clearKeywords = $('clear-keywords');
  if (clearKeywords) {
    clearKeywords.addEventListener('click', async () => {
      const current = (await getSettings()).customKeywordList;
      const ok = await guardWeakening('clear custom blocked words', {},
        { kind: 'settings', payload: { removeFrom: { customKeywordList: current } } });
      if (!ok) return;
      const confirmed = await showConfirmModal({
        title: 'Clear your blocked words?',
        description: 'Every word on the list is removed. Pages are no longer blocked for containing them.',
        confirmText: 'Clear blocked words',
        destructive: true
      });
      if (!confirmed) return;
      const settings = await getSettings();
      settings.customKeywordList = [];
      await setSettings(settings);
      await render();
    });
  }

  $('save-trusted').addEventListener('click', async () => {
    const settings = await getSettings();
    let nextTrusted = serializePatterns($('trusted-domains').value);
    // A trusted site's images skip the AI check, so adding one loosens
    // protection. It was never gated on its own; under a Pact it waits.
    const added = addedEntries(settings.trustedImageDomains, nextTrusted);
    let queued = false;
    if (added.length) {
      const pactOn = Pact && Pact.isActive(await readPact());
      if (pactOn) {
        const outcome = await guardWeakeningOutcome('add a trusted image domain', {},
          { kind: 'settings', payload: { addTo: { trustedImageDomains: added } } });
        if (outcome === 'cancelled') return;
        if (outcome === 'queued') {
          queued = true;
          nextTrusted = removedEntries(nextTrusted, added);
        }
      }
    }
    settings.trustedImageDomains = nextTrusted;
    await setSettings(settings);
    $('trusted-domains').value = deserializePatterns(nextTrusted);
    if (!queued) showToast('Trusted sites saved.', 'success');
  });

  $('reset-trusted').addEventListener('click', async () => {
    const ok = await guardWeakening('reset trusted sites to the default list', {},
      settingsChange({ trustedImageDomains: DEFAULT_TRUSTED_DOMAINS.slice() }));
    if (!ok) return;
    const confirmed = await showConfirmModal({
      title: 'Reset trusted sites?',
      description: 'Your list is replaced with the default list of 24 sites. Sites you added yourself are removed.',
      confirmText: 'Reset trusted sites',
      destructive: true
    });
    if (!confirmed) return;
    const defaultDomains = DEFAULT_TRUSTED_DOMAINS.slice();
    $('trusted-domains').value = deserializePatterns(defaultDomains);
    const settings = await getSettings();
    settings.trustedImageDomains = defaultDomains;
    await setSettings(settings);
    showToast('Trusted sites are back to the default list.', 'success');
  });

  $('clear').addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      title: 'Clear your blocklist?',
      description: 'Every entry you added is removed. Sites on BlockNSFW’s own list stay blocked.',
      confirmText: 'Clear blocklist',
      destructive: true
    });
    if (!confirmed) return;
    const current = (await getSettings()).customPatterns;
    const ok = await guardWeakening('clear your blocklist', {},
      { kind: 'settings', payload: { removeFrom: { customPatterns: current } } });
    if (!ok) return;
    const s = await getSettings();
    s.customPatterns = [];
    await setSettings(s);
    await render();
  });

  $('reset').addEventListener('click', async () => {
    const currentSettings = await getSettings();
    const resetTo = {
      enabled: true,
      useSmartBlocking: true,
      imageFilterLevel: 'strict',
      customPatterns: [],
      customKeywordList: [],
      trustedImageDomains: [],
      debugMode: false,
      aiStrictness: 'balanced',
    };
    // A reset also switches off DNS, the AI layers and Reels blocking (their
    // defaults are off), so under a Pact the whole reset waits.
    const pactOn = Pact && Pact.isActive(await readPact());
    if (pactOn || currentSettings.customPatterns.length > 0 ||
        currentSettings.customKeywordList.length > 0) {
      const ok = await guardWeakening('reset settings to their defaults', {},
        { kind: 'settings-replace', payload: { settings: resetTo } });
      if (!ok) return;
    }
    const confirmed = await showConfirmModal({
      title: 'Reset settings to their defaults?',
      description: 'Your blocklist, blocked words and trusted sites are cleared, and the other settings on this page go back to their defaults.',
      confirmText: 'Reset settings',
      destructive: true
    });
    if (!confirmed) return;
    await setSettings(resetTo);
    await render();
  });

  // Whitelist event listeners
  $('add-whitelist').addEventListener('click', async () => {
    const domainInput = $('whitelist-domain');
    const errorEl = $('whitelist-error');
    const fieldError = (message) => {
      if (errorEl) errorEl.textContent = message;
      if (message) domainInput.setAttribute('aria-invalid', 'true');
      else domainInput.removeAttribute('aria-invalid');
    };
    // Accepts a bare domain or a domain + path (e.g. reddit.com/r/NoFap).
    const parsed = self.DomainValidate.parseWhitelistInput(domainInput.value.trim());

    if (!parsed) {
      fieldError('That doesn’t look like a web address. Check it and try again.');
      domainInput.focus();
      return;
    }

    const whitelist = await getWhitelist();
    const exists = whitelist.some(item => item.domain === parsed.domain && (item.path || null) === (parsed.path || null));

    if (exists) {
      fieldError(parsed.path ? 'That page is already on the whitelist.' : 'That site is already on the whitelist.');
      domainInput.focus();
      return;
    }
    fieldError('');

    // Gate last, so a typo or a duplicate never costs someone a 256-character
    // code. A bare domain unlocks the whole site — as total as switching
    // blocking off — so it counts as critical; a path-scoped entry opens one
    // section and doesn't.
    const shown = parsed.path ? parsed.domain + parsed.path : parsed.domain;
    const outcome = await guardWeakeningOutcome(
      `whitelist ${shown}`,
      { critical: !parsed.path, ensurePin: true },
      { kind: 'whitelist-add', payload: { domain: parsed.domain, path: parsed.path || null, type: 'permanent' } }
    );
    if (outcome === 'queued') domainInput.value = '';
    if (outcome !== 'now') return;

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
      showToast('There’s nothing on the whitelist to export yet.', 'warning');
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

  $('import-whitelist').addEventListener('click', async () => {
    // A whitelist file is a bulk whole-site unlock, so it faces the same bar
    // as whitelisting a site by hand. Without a Pact the PIN comes first, as
    // it always has; with one, the file is read first so the waiting change
    // carries exactly what it will add.
    const pactOn = Pact && Pact.isActive(await readPact());
    const ok = pactOn ? true : await requirePINIfSet('import a whitelist file', { critical: true });
    {
      if (!ok) return;

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // Validate file size (max 1MB)
        if (file.size > 1024 * 1024) {
          showToast('That file is over 1 MB. Choose a smaller one.', 'error');
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

          if (pactOn && newDomains > 0) {
            const added = merged.slice(current.length).map(item => ({ domain: item.domain, path: item.path || null }));
            const now = await guardWeakening(
              `whitelist ${newDomains} ${newDomains === 1 ? 'site' : 'sites'} from a file`,
              { critical: true },
              { kind: 'whitelist-add', payload: { items: added } }
            );
            if (!now) return;
          }

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
    }
  });

  $('clear-whitelist').addEventListener('click', async () => {
    const ok = await requirePIN('clear whitelist');
    if (!ok) return;
    const confirmed = await showConfirmModal({
      title: 'Clear the whitelist?',
      description: 'Every whitelisted site and page is removed, so they are blocked again where they match.',
      confirmText: 'Clear whitelist',
      destructive: true
    });
    if (!confirmed) return;
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
            showToast('That file is over 1 MB. Choose a smaller one.', 'error');
            return;
          }
          const imported = parseListFile(await readFileAsText(file));
          if (imported.length === 0) {
            showToast('That file has no entries in it.', 'warning');
            return;
          }
          const existing = serializePatterns(textarea.value);
          const before = countRealEntries(existing);
          // serializePatterns dedups (case-insensitively) and sorts the union.
          // Comments hold their places, so the file's sections land after the
          // list's own, and entries at the top of the file join the last section.
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
          showToast('That file couldn’t be read. Check that it’s a .csv or .txt file.', 'error');
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
        const ok = await guardWeakening('turn off the access code', { critical: true },
          { kind: 'access-code', payload: { config: { ...config, enabled: false } } });
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
        const ok = await guardWeakening('ask for the access code less often', { critical: true },
          { kind: 'access-code', payload: { config: { ...config, scope: 'critical' } } });
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
        const ok = await guardWeakening('shorten the access code', { critical: true },
          { kind: 'access-code', payload: { config: { ...config, length: nextLength } } });
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
    const pact = await readPact();
    // A PIN the witness holds can't simply be swapped for one you know: it
    // has to be cleared first, which waits like any other loosening.
    if (pinIsSet(stored) && pact && pact.pinSealed) {
      const ok = await guardWeakening('clear the PIN your witness holds', { critical: true }, { kind: 'pin-clear', payload: {} });
      if (!ok) return;
      await browserAPI.storage.local.remove(PIN_KEY);
      await clearSealedFlag();
    } else if (pinIsSet(stored)) {
      const ok = await showVerifyPINModal('change PIN');
      if (!ok) return;
    }
    const newPin = await showSetPINModal();
    if (!newPin) return;
    await setPIN(newPin);
    showToast('Your PIN is set.', 'success');
    await render();
  });

  $('clear-pin').addEventListener('click', async () => {
    const stored = await getPIN();
    if (!pinIsSet(stored)) {
      showToast('There’s no PIN to clear.', 'info');
      return;
    }

    // Under a Pact, clearing the PIN waits. It asks for the PIN first, unless
    // the witness holds it: then waiting is the way back in.
    const pact = await readPact();
    if (Pact && Pact.isActive(pact)) {
      const ok = await guardWeakening(
        pact.pinSealed ? 'clear the PIN your witness holds' : 'clear your PIN',
        { critical: true },
        { kind: 'pin-clear', payload: {} }
      );
      if (!ok) return;
      await browserAPI.storage.local.remove(PIN_KEY);
      await clearSealedFlag();
      showToast('Your PIN is cleared.', 'success');
      await render();
      return;
    }

    const confirmed = await showConfirmModal({
      title: 'Clear your PIN?',
      description: 'Anything that loosens protection will stop asking for it.',
      message: 'You’ll enter your current PIN first.',
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
    showToast('Your PIN is cleared.', 'success');
    await render();
  });

  // Auto-trigger commitment gate if redirected from popup with ?action=disable
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'disable') {
    // Clean the URL so refreshing doesn't re-trigger
    history.replaceState(null, '', window.location.pathname);

    const s = await getSettings();
    if (s.enabled) {
      if (await disableProtectionFlow()) await render();
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
