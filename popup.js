const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const DAILY_STATS_KEY = 'pblocker_daily_stats';
const WHITELIST_KEY = 'pblocker_whitelist';
const PIN_KEY = 'pblocker_pin';
const TEMP_DISABLE_UNTIL_KEY = 'pblocker_temp_disable_until';
const STREAK_START_KEY = 'pblocker_streak_start';
const UPDATE_INFO_KEY = 'pblocker_update_info';
const UPDATE_DISMISSED_KEY = 'pblocker_update_dismissed';

const AccessCode = self.AccessCode;
// shared/pact.js and shared/pin-hash.js; either may be missing in a test
// context, and the gates then work exactly as they did before the Pact.
const Pact = self.Pact || null;
const PinHash = self.PinHash || null;
const Boost = self.Boost || null;

// During Storm Mode or Risk Hours nothing that loosens protection can be done.
// Resolves true, after saying so, when that is why a change is refused.
async function refusedByBoost() {
  if (!Boost) return false;
  const state = await Boost.readState(browserAPI.storage.local);
  if (!state) return false;
  showNotice(Boost.refusal(state, Date.now()));
  return true;
}

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

async function addToWhitelist(domain, type = 'permanent', expiresMs = null, path = null) {
  const whitelist = await getWhitelist();
  // Entry identity is (domain, path): a whole-domain entry and a path-scoped
  // entry for the same host coexist, but re-adding the same pair updates it.
  const existingIndex = whitelist.findIndex(item => item.domain === domain && (item.path || null) === (path || null));

  const entry = {
    domain: domain,
    path: path || null,
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

async function removeFromWhitelist(domain, path = null) {
  const whitelist = await getWhitelist();
  const filtered = whitelist.filter(item => !(item.domain === domain && (item.path || null) === (path || null)));
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

// Stored as a salted hash (shared/pin-hash.js); a PIN from an older version
// is a plain string until it is next entered.
function pinIsSet(stored) {
  return PinHash ? PinHash.isSet(stored) : !!stored;
}

async function setPIN(pin) {
  const stored = PinHash ? await PinHash.hash(pin) : pin;
  await browserAPI.storage.local.set({ [PIN_KEY]: stored });
  if (PinHash) await browserAPI.storage.local.remove(PinHash.LOCK_KEY);
}

// Resolves { ok, waitMs }; waitMs > 0 means locked out after too many tries.
async function checkPIN(entered) {
  if (PinHash) return await PinHash.check(browserAPI.storage.local, entered, Date.now());
  const stored = await getPIN();
  return { ok: !!stored && entered === stored, waitMs: 0 };
}

async function ensurePIN() {
  const current = await getPIN();
  if (pinIsSet(current)) return true;
  const newPin = await showSetPinModal();
  if (!newPin) return false;
  await setPIN(newPin);
  return true;
}

// --- Access code ------------------------------------------------------------
//
// The second layer over the PIN. Until issue #29 it existed only on the
// options page, so anything reachable from here — including "unblock this
// site", which whitelists the whole domain and overrides blocking entirely —
// was guarded by a four-digit PIN alone however the user had configured it.
// The rules live in shared/access-code.js; only the modal is popup-specific.

async function getAccessCodeConfig() {
  return await AccessCode.readConfig(browserAPI.storage.local);
}

function getAccessCodeElements() {
  return {
    overlay: $('access-code-modal-overlay'),
    desc: $('access-code-modal-desc'),
    display: $('access-code-display'),
    input: $('access-code-input'),
    error: $('access-code-error'),
    ok: $('access-code-ok'),
    cancel: $('access-code-cancel')
  };
}

async function showAccessCodeModal(actionLabel = 'this action') {
  const { length } = await getAccessCodeConfig();
  const el = getAccessCodeElements();
  // No modal in the DOM means no way to enforce the code — refuse the action
  // rather than waving it through, and never fall back to prompt() (its box
  // accepts a paste, which is the one thing this must not allow).
  if (!el.overlay) return false;

  let expected = AccessCode.generate(length);
  el.desc.textContent = `Type the code below exactly to ${actionLabel}.`;
  el.display.textContent = expected;
  el.input.value = '';
  setFieldError(el.input, el.error, '');
  // The markup is static and reused, so harden it once rather than stacking a
  // fresh set of listeners every time the modal opens.
  if (!el.input.dataset.hardened) {
    AccessCode.hardenEntry(el.input, el.display);
    el.input.dataset.hardened = '1';
  }
  openDialog(el.overlay);
  el.input.focus();

  return new Promise(resolve => {
    const cleanup = () => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.input.onkeydown = null;
      closeDialog(el.overlay);
    };
    el.ok.onclick = () => {
      if (el.input.value === expected) {
        cleanup();
        resolve(true);
        return;
      }
      // Wrong: issue a fresh code so the attempt can't be chipped away at.
      expected = AccessCode.generate(length);
      el.display.textContent = expected;
      el.display.scrollTop = 0;
      el.input.value = '';
      setFieldError(el.input, el.error, 'That didn’t match. Type the new code above.');
      el.input.focus();
    };
    el.cancel.onclick = () => { cleanup(); resolve(false); };
    el.input.onkeydown = (e) => {
      // No Enter-to-submit: at 256 characters a stray Enter mid-code would
      // throw the whole attempt away.
      if (e.key === 'Escape') el.cancel.click();
    };
  });
}

// Runs after the PIN check, so the two layers stack rather than replace.
// `critical` marks the master switches — see SCOPES in shared/access-code.js.
async function requireAccessCodeIfEnabled(actionLabel = 'this action', critical = false) {
  const config = await getAccessCodeConfig();
  if (!AccessCode.requiredFor(config, critical)) return true;
  return await showAccessCodeModal(actionLabel);
}

// Three tries per prompt. A wrong PIN is said in the next prompt, which is
// also the next try (it used to open a separate prompt whose answer was
// thrown away). The lockout spans prompts, so reopening doesn't reset it.
//
// Resolves true for the right PIN, 'witness' when a code from the witness's
// app was typed instead (both are short numbers from the witness, so people
// mix them up; under a Pact the code means the change applies at once), or
// false.
async function verifyPIN(actionLabel) {
  const pact = await readPact();
  const witnessOn = !!(Pact && pact && pact.witness);
  const hint = witnessOn
    ? (pact.pinSealed
      ? 'Your witness holds this PIN. The changing code from their app works here too.'
      : 'Or type the code from your witness’s app: it works here too.')
    : '';
  let message = `Enter your PIN to ${actionLabel}.`;
  let isError = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entered = await showPinModal(message, isError ? { errorOnly: true, hint } : { hint });
    if (entered === null) return false; // Cancelled
    const result = await checkPIN(entered);
    if (result.ok) return true;
    if (witnessOn && Pact.looksLikeWitnessCode(entered)) {
      const reply = await Pact.ask({ type: 'pact_verify_code', code: entered });
      if (reply && reply.ok) {
        // The PIN check counted it as a wrong PIN; it wasn't one.
        if (PinHash) await browserAPI.storage.local.remove(PinHash.LOCK_KEY);
        return 'witness';
      }
      if (reply && reply.locked) {
        showNotice(`Too many wrong codes. Try again in ${PinHash ? PinHash.describeWait(reply.waitMs) : 'a while'}.`);
        return false;
      }
    }
    if (result.waitMs) {
      showNotice(`Too many wrong tries. Try your PIN again in ${PinHash.describeWait(result.waitMs)}.`);
      return false;
    }
    message = witnessOn
      ? 'That isn’t your PIN or your witness’s current code. Their code changes every 30 seconds.'
      : 'That PIN didn’t match. Try again.';
    isError = true;
  }
  return false;
}

async function requirePIN(actionLabel = 'this action', opts) {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  if (!await verifyPIN(actionLabel)) return false;
  return await requireAccessCodeIfEnabled(actionLabel, !!(opts && opts.critical));
}

// For actions that only ever tighten protection. Tightening is free (issue
// #11) — the access code guards the way out, never the way back in. Under the
// 'all' scope this would otherwise charge someone 256 characters of typing to
// re-block a site, which is the opposite of what the feature is for.
async function requirePINOnly(actionLabel = 'this action') {
  const hasPin = await ensurePIN();
  if (!hasPin) return false;
  return await verifyPIN(actionLabel);
}

// Only require PIN if one is already set (doesn't prompt to create one).
// The access code stands on its own, so it still applies when no PIN is set.
async function requirePINIfSet(actionLabel = 'this action', opts) {
  const stored = await getPIN();
  if (pinIsSet(stored) && !await verifyPIN(actionLabel)) return false;
  return await requireAccessCodeIfEnabled(actionLabel, !!(opts && opts.critical));
}

// --- The Pact ----------------------------------------------------------------
//
// The same rule as Settings (options.js guardWeakeningOutcome): with a Pact,
// a change that loosens protection waits, and `change` is what the
// background applies once the wait is over. Resolves 'now' (make the change),
// 'queued' or 'cancelled'.

async function readPact() {
  return Pact ? await Pact.readPact(browserAPI.storage.local) : null;
}

async function guardWeakeningOutcome(actionLabel, opts, change) {
  const options = opts || {};
  if (await refusedByBoost()) return 'cancelled';
  const pact = await readPact();
  if (!Pact || !Pact.isActive(pact) || !change) {
    const ok = options.ensurePin
      ? await requirePIN(actionLabel, options)
      : await requirePINIfSet(actionLabel, options);
    return ok ? 'now' : 'cancelled';
  }
  const choice = await showPactDialog(actionLabel, pact);
  if (choice === 'witness') return 'now';
  if (choice !== 'wait') return 'cancelled';
  // The PIN still keeps anyone else from queuing changes; the wait replaces
  // the access code.
  if (pinIsSet(await getPIN())) {
    const verified = await verifyPIN(actionLabel);
    if (!verified) return 'cancelled';
    // A witness code typed into the PIN box vouches for the change: no wait.
    if (verified === 'witness') return 'now';
  }
  const reply = await Pact.ask({ type: 'pact_enqueue', change: { ...change, label: actionLabel } });
  if (!reply || !reply.ok) {
    showNotice('That change couldn’t be queued. Try again.');
    return 'cancelled';
  }
  const now = Date.now();
  showNotice(`Waiting. It takes effect around ${Pact.formatWhen(now + (reply.remainingMs || 0), now)}. You can cancel it below.`);
  await renderPactWaiting();
  return 'queued';
}

async function guardWeakening(actionLabel, opts, change) {
  return (await guardWeakeningOutcome(actionLabel, opts, change)) === 'now';
}

function getPactElements() {
  return {
    overlay: $('pact-modal-overlay'),
    title: $('pact-modal-title'),
    desc: $('pact-modal-desc'),
    note: $('pact-modal-note'),
    codeField: $('pact-code-field'),
    codeInput: $('pact-code-input'),
    codeError: $('pact-code-error'),
    codeLine: $('pact-code-line'),
    codeBtn: $('pact-code-btn'),
    ok: $('pact-ok'),
    cancel: $('pact-cancel')
  };
}

// The Pact's dialog. Asking for a change: Cancel or Wait, with the
// witness's code as a link in the body. With `entryId`: a waiting change, let through by a code. Resolves
// 'wait', 'witness' or null.
async function showPactDialog(actionLabel, pact, entryId) {
  const el = getPactElements();
  // No dialog in the DOM: refuse rather than wave the change through.
  if (!el.overlay) return null;
  const now = Date.now();
  const delay = Pact.formatDelay(pact.delayMs);
  let codeMode = false;

  const showCode = () => {
    codeMode = true;
    el.title.textContent = 'Enter your witness’s code';
    el.desc.textContent = `Ask your witness for the six-digit code in their authenticator app to ${actionLabel} now.`;
    el.note.classList.add('hidden');
    el.codeField.classList.remove('hidden');
    el.codeLine.classList.add('hidden');
    el.ok.textContent = 'Continue';
    el.codeInput.value = '';
    setFieldError(el.codeInput, el.codeError, '');
    el.codeInput.focus();
  };

  el.title.textContent = 'This change waits';
  el.desc.textContent = `This will ${actionLabel} after your pact’s wait of ${delay}, around ${Pact.formatWhen(now + pact.delayMs, now)}.`;
  el.note.textContent = pact.witness
    ? 'Most urges pass if you wait them out. You can cancel it any time before then.'
    : 'Most urges pass if you wait them out. You can cancel it any time before then. To let a change through without the wait, add a witness in Settings.';
  el.note.classList.remove('hidden');
  el.codeField.classList.add('hidden');
  el.codeLine.classList.toggle('hidden', !pact.witness);
  el.ok.textContent = `Wait ${delay}`;
  openDialog(el.overlay);
  if (entryId) showCode();
  else el.ok.focus();

  return new Promise(resolve => {
    let busy = false;
    const finish = (value) => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.codeBtn.onclick = null;
      el.codeInput.onkeydown = null;
      closeDialog(el.overlay);
      resolve(value);
    };
    const submitCode = async () => {
      if (busy) return;
      const code = el.codeInput.value.trim();
      if (!code) return;
      busy = true;
      const reply = await Pact.ask(entryId
        ? { type: 'pact_apply_now', id: entryId, code }
        : { type: 'pact_verify_code', code });
      busy = false;
      if (reply && reply.ok) {
        if (reply.via === 'recovery') showNotice(`Recovery code used. ${reply.recoveryLeft} left.`);
        finish('witness');
        return;
      }
      el.codeInput.value = '';
      setFieldError(el.codeInput, el.codeError, reply && reply.locked
        ? `Too many wrong codes. Try again in ${PinHash ? PinHash.describeWait(reply.waitMs) : 'a while'}.`
        : 'That code didn’t match. Ask for the one showing now.');
      el.codeInput.focus();
    };
    el.codeBtn.onclick = showCode;
    el.ok.onclick = () => (codeMode ? submitCode() : finish('wait'));
    el.cancel.onclick = () => finish(null);
    el.codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitCode(); }
    };
  });
}

// --- Storm Mode ------------------------------------------------------------------

// Resolves the hours chosen, or null.
function showStormDialog() {
  const overlay = $('storm-modal-overlay');
  if (!overlay) return Promise.resolve(null);
  const chips = [...overlay.querySelectorAll('.chip')];
  const ok = $('storm-ok');
  const cancel = $('storm-cancel');
  const error = $('storm-error');
  let hours = null;
  const pick = (chip) => {
    hours = Number(chip.dataset.hours);
    chips.forEach(c => {
      const on = c === chip;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (error) error.textContent = '';
  };
  chips.forEach(c => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  if (error) error.textContent = '';
  openDialog(overlay);
  if (chips[0]) chips[0].focus();
  return new Promise(resolve => {
    const finish = (value) => {
      chips.forEach(c => { c.onclick = null; });
      ok.onclick = null;
      cancel.onclick = null;
      closeDialog(overlay);
      resolve(value);
    };
    chips.forEach(c => { c.onclick = () => pick(c); });
    ok.onclick = () => {
      if (!hours) {
        if (error) error.textContent = 'Choose how long it lasts.';
        return;
      }
      finish(hours);
    };
    cancel.onclick = () => finish(null);
  });
}

async function startStorm() {
  showNotice('');
  const hours = await showStormDialog();
  if (!hours) return;
  const reply = await Pact.ask({ type: 'boost_storm_start', hours });
  showNotice(reply && reply.ok
    ? `Storm Mode is on until ${Boost.formatUntil(reply.until, Date.now())}.`
    : 'Storm Mode didn’t start. Try again.');
  await updateUI();
}

// The Storm row and the line under "Protected" while a boost is on.
async function renderBoost(settings) {
  if (!Boost) return;
  const state = await Boost.readState(browserAPI.storage.local);
  const now = Date.now();
  const statusNote = $('status-note');
  if (statusNote && settings.enabled) {
    statusNote.hidden = !state;
    statusNote.textContent = state
      ? (state.active === 'storm' ? 'Storm Mode until ' : 'Risk hours until ') + Boost.formatUntil(state.until, now)
      : '';
  }
  // While it lasts, the notes beside the guarded controls say so, instead of
  // describing a PIN prompt that won't come.
  if (state) {
    const until = Boost.formatUntil(state.until, now);
    const ends = state.active === 'storm' ? `Not until Storm Mode ends at ${until}.` : `Not until your risk hours end at ${until}.`;
    ['unblock-note', 'safesearch-note', 'whitelist-note', 'toggle-note'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = ends;
    });
  }
  const desc = $('storm-desc');
  const button = $('storm-btn');
  if (!desc || !button) return;
  if (state && state.active === 'storm') {
    desc.textContent = `On until ${Boost.formatUntil(state.until, now)}. It can’t be stopped early.`;
    button.textContent = 'Longer';
  } else {
    desc.textContent = 'For a hard moment: everything at its strongest, and nothing can be loosened until it ends.';
    button.textContent = 'Start';
  }
}

// The changes waiting out the Pact, with a way to cancel each.
async function renderPactWaiting() {
  const section = $('pact-waiting');
  const list = $('pact-waiting-list');
  if (!section || !list || !Pact) return;
  const { pact, queue, clock } = await Pact.readAll(browserAPI.storage.local);
  section.classList.toggle('hidden', queue.length === 0);
  list.textContent = '';
  const now = Date.now();
  queue.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'domain-row';
    const main = document.createElement('div');
    main.className = 'domain-main';
    const name = document.createElement('span');
    name.className = 'domain';
    name.textContent = Pact.sentenceCase(entry.label);
    name.title = name.textContent;
    const meta = document.createElement('span');
    meta.className = 'domain-meta';
    const left = Pact.remainingMs(entry, clock, now);
    meta.textContent = left > 0 ? `In ${Pact.formatRemaining(left)}` : 'Due now';
    main.appendChild(name);
    main.appendChild(meta);
    row.appendChild(main);

    if (pact && pact.witness) {
      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'btn-text';
      code.textContent = 'Code';
      code.setAttribute('aria-label', `Use a witness code to ${entry.label} now`);
      code.addEventListener('click', async () => {
        if ((await showPactDialog(entry.label, pact, entry.id)) === 'witness') showNotice('Done.');
        await renderPactWaiting();
      });
      row.appendChild(code);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('aria-label', `Cancel: ${entry.label}`);
    cancel.addEventListener('click', async () => {
      const reply = await Pact.ask({ type: 'pact_cancel', id: entry.id });
      showNotice(reply && reply.ok ? 'Cancelled. Nothing changed.' : 'That didn’t cancel. Try again.');
      await renderPactWaiting();
    });
    row.appendChild(cancel);
    list.appendChild(row);
  });
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
    hint: $('pin-hint'),
    ok: $('pin-ok'),
    cancel: $('pin-cancel')
  };
}

// The line under the PIN box; empty hides it.
function setPinHint(el, text) {
  if (!el.hint) return;
  el.hint.textContent = text || '';
  el.hint.hidden = !text;
}

// --- Dialog presentation ------------------------------------------------------
//
// The three dialogs share one way of opening and closing: focus goes into the
// dialog and comes back to whatever opened it, Tab stays inside, and Escape
// cancels. None of this decides anything; the gates above do.

let dialogReturnFocus = null;

function openDialog(overlay) {
  if (!overlay) return;
  const active = document.activeElement;
  if (active && active !== document.body && !overlay.contains(active)) dialogReturnFocus = active;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeDialog(overlay) {
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  const target = dialogReturnFocus;
  dialogReturnFocus = null;
  if (target && document.contains(target) && typeof target.focus === 'function') {
    try { target.focus({ preventScroll: true }); } catch (_) {}
  }
}

// Keyboard rules for one dialog, wired once at load.
function holdFocusIn(overlay, cancelButton) {
  if (!overlay) return;
  overlay.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (cancelButton) cancelButton.click();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.disabled && node.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// A problem with a field is said under it, and the field is marked invalid.
function setFieldError(input, errorEl, message) {
  if (errorEl) errorEl.textContent = message || '';
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function showOverlay() {
  const { overlay } = getPinElements();
  openDialog(overlay);
}

function hideOverlay() {
  const { overlay } = getPinElements();
  closeDialog(overlay);
}

function setupPinToggle() {
  const { toggle, input } = getPinElements();
  if (!toggle || !input) return;
  // Every dialog opens with the PIN hidden.
  input.type = 'password';
  toggle.textContent = 'Show';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.onclick = () => {
    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    toggle.textContent = showing ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', showing ? 'true' : 'false');
  };
}

async function showPinModal(description, options = {}) {
  const el = getPinElements();
  if (!el.overlay) return prompt(description || 'Enter PIN');
  el.title.textContent = 'Enter your PIN';
  el.desc.textContent = options.errorOnly
    ? 'Enter your PIN to continue.'
    : (description || 'Enter your PIN to continue.');
  setFieldError(el.input, el.error, options.errorOnly ? description : '');
  setPinHint(el, options.hint);
  el.ok.textContent = 'Continue';
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
        setFieldError(el.input, el.error, 'A PIN has at least 4 characters. Check it and try again.');
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
  el.title.textContent = 'Set a PIN';
  el.desc.textContent = 'A PIN guards anything that loosens protection. Choose one you will remember.';
  setFieldError(el.input, el.error, '');
  setPinHint(el, '');
  el.ok.textContent = 'Set PIN';
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
      el.confirmInput.removeAttribute('aria-invalid');
    };
    el.ok.onclick = () => {
      const a = el.input.value.trim();
      const b = el.confirmInput.value.trim();
      el.confirmInput.removeAttribute('aria-invalid');
      if (a.length < 4) { setFieldError(el.input, el.error, 'A PIN has at least 4 characters. Choose a longer one.'); return; }
      if (a !== b) {
        setFieldError(null, el.error, 'The two PINs don’t match. Type them again.');
        el.input.removeAttribute('aria-invalid');
        el.confirmInput.setAttribute('aria-invalid', 'true');
        return;
      }
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
  const title = options.title || 'Choose how long';
  const description = options.description || 'Choose how long, or keep it for good.';
  el.title.textContent = title;
  el.desc.textContent = description;
  setFieldError(el.input, el.error, '');
  el.input.value = '';
  // Clear chip selection
  [...el.chips.querySelectorAll('.chip')].forEach(c => {
    c.classList.remove('selected');
    c.setAttribute('aria-pressed', 'false');
  });
  openDialog(el.overlay);
  const firstChip = el.chips.querySelector('.chip');
  if (firstChip) firstChip.focus(); else el.input.focus();

  return new Promise(resolve => {
    let selectedMinutes = undefined; // undefined = none, null = permanent, number = minutes
    const cleanup = () => {
      el.ok.onclick = null;
      el.cancel.onclick = null;
      el.input.onkeydown = null;
      el.chips.onclick = null;
      closeDialog(el.overlay);
    };
    el.chips.onclick = (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      // Toggle selected state
      [...el.chips.querySelectorAll('.chip')].forEach(c => {
        c.classList.remove('selected');
        c.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('selected');
      btn.setAttribute('aria-pressed', 'true');
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
        setFieldError(el.input, el.error, 'That isn’t a number of minutes. Enter a whole number, or choose a length above.');
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

// When the active tab is our own blocked page, the site the user means is the
// one recorded in ?url=, not the extension page they are looking at.
//
// Without this, using the popup from a blocked page whitelists the extension's
// own address — moz-extension://<uuid>/blocked.html on Firefox,
// chrome-extension://<id>/blocked.html on Chrome — so the entry does nothing and
// the site stays blocked with no hint why. Reported as issue #26.
//
// Only our own extension page is unwrapped, checked against runtime.getURL
// rather than by protocol alone: another extension's page must not be able to
// steer this by putting a url= parameter in its address.
function isOwnBlockedPage(url) {
  // Compared by protocol + host, NOT by origin. For non-special schemes like
  // moz-extension: and chrome-extension:, URL.origin is the string "null" for
  // every such address, so an origin check would treat any other extension's
  // page as ours. Caught by tests/popup-tab-url.test.js.
  let own;
  try {
    own = new URL(browserAPI.runtime.getURL('blocked.html'));
  } catch (_) {
    return false;
  }
  return url.protocol === own.protocol && url.host === own.host &&
    url.pathname.endsWith('/blocked.html');
}

function resolveTabUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (!isOwnBlockedPage(url)) return url;

  const target = url.searchParams.get('url');
  if (!target) return url; // opened directly, nothing to unwrap
  try {
    const resolved = new URL(target);
    // Only http(s): a blocked page should never hand back a javascript: or
    // data: URL for us to act on.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return url;
    return resolved;
  } catch (_) {
    return url;
  }
}

function isWebUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

// The blocked page answers from memory, so a slow reply means no page is
// holding the key. The limit only stops the popup waiting on a listener that
// never replies.
const BLOCKED_PAGE_ASK_TIMEOUT_MS = 1500;

// Our blocked page normally carries only ?k=<key>. The site's address was kept
// in session storage and deleted once the page read it, so the page itself is
// the only thing left to ask. See the listener at the end of blocked.js.
async function askBlockedPageForTarget(key) {
  let reply;
  let timer;
  try {
    reply = await Promise.race([
      browserAPI.runtime.sendMessage({ type: 'blocked_page_target', key }),
      new Promise(done => { timer = setTimeout(() => done(null), BLOCKED_PAGE_ASK_TIMEOUT_MS); })
    ]);
  } catch (_) {
    return null; // nobody answered: the page was reloaded, or closed
  } finally {
    clearTimeout(timer);
  }
  if (!reply || typeof reply.url !== 'string') return null;
  try {
    const target = new URL(reply.url);
    return isWebUrl(target) ? target : null;
  } catch (_) {
    return null;
  }
}

// The website a tab stands for, or null when it isn't one. Null is the answer
// for the extension's own pages, other extensions' pages and the browser's own
// pages (chrome://extensions reports its hostname as "extensions"). Handing
// back their hostname anyway is how "unblock this website" came to whitelist
// the extension's ID in issue #44.
async function resolveTabTarget(rawUrl) {
  const url = resolveTabUrl(rawUrl);
  if (!url) return null;
  if (isWebUrl(url)) return url;
  if (isOwnBlockedPage(url)) {
    const key = url.searchParams.get('k');
    if (key) return askBlockedPageForTarget(key);
  }
  return null;
}

// One refresh of the popup asks about the current tab several times (the
// unblock toggle, the block button and both of their states), so the answer
// is kept until the tab's address changes.
let tabTargetCache = null; // { rawUrl, promise }

function resolveTabTargetCached(rawUrl) {
  if (!tabTargetCache || tabTargetCache.rawUrl !== rawUrl) {
    tabTargetCache = { rawUrl, promise: resolveTabTarget(rawUrl) };
  }
  return tabTargetCache.promise;
}

async function getCurrentTabDomain() {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = await resolveTabTargetCached(tab.url);
      if (url) return url.hostname.replace(/^www\./, '');
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
  // The "unblock this site" toggle is whole-site: it reflects (and toggles) a
  // whole-domain entry only, so a path-scoped entry doesn't light it up.
  return whitelist.some(item => item.domain === domain && !item.path);
}

// Is `host` already covered by an existing custom pattern? Mirrors the host
// half of content.js's customPatternsMatchHost so the popup won't add a
// duplicate (or a domain already caught by a `*.` parent entry). Path-scoped
// patterns (e.g. "example.com/x") are ignored here: they're narrower than the
// whole-domain block this button adds, so they shouldn't suppress it.
function hostCoveredByPatterns(host, patterns) {
  if (!host || !Array.isArray(patterns)) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  return patterns.some(raw => {
    const p = (raw || '').trim().toLowerCase();
    if (!p || p.indexOf('/') >= 0) return false; // skip path-scoped patterns
    const base = p.startsWith('*.') ? p.slice(2) : p;
    return h === base || h.endsWith('.' + base);
  });
}

// Whether the current tab's domain is already on the custom blocklist.
async function isCurrentSiteBlocked() {
  const domain = await getCurrentTabDomain();
  if (!domain) return false;
  const settings = await getSettings();
  return hostCoveredByPatterns(domain, settings.customPatterns || []);
}

// Add the current tab's domain to the custom blocklist. Append-only, so it can
// only ever tighten protection — no PIN required (issue #11). Whitelist entries
// win over the blocklist at match time, so we refuse when the site is
// whitelisted rather than adding an entry that would silently do nothing.
async function blockCurrentSite() {
  try {
    showNotice('');
    const domain = await getCurrentTabDomain();
    if (!domain) {
      showNotice(NOT_A_WEBSITE);
      return;
    }
    if (await isCurrentSiteWhitelisted()) {
      showNotice('This site is on your whitelist, which overrides blocking. Remove it from the whitelist first.');
      return;
    }
    const settings = await getSettings();
    const patterns = Array.isArray(settings.customPatterns) ? settings.customPatterns : [];
    if (hostCoveredByPatterns(domain, patterns)) {
      await updateUI(); // already blocked — just refresh the row state
      return;
    }
    patterns.push(domain);
    settings.customPatterns = patterns;
    await setSettings(settings);
    await updateUI();
  } catch (error) {
    console.error('BlockNSFW popup: Error blocking current site', error);
  }
}

async function resetStats() {
  await browserAPI.storage.local.set({
    [BLOCKED_STATS_KEY]: { blockedCount: 0, lastBlocked: null },
    [DAILY_STATS_KEY]: { date: new Date().toDateString(), blockedToday: 0, websiteBlocked: 0, imageBlocked: 0, searchResultBlocked: 0 }
  });
  
  await updateUI();
}

// --- Presentation helpers -----------------------------------------------------

const NOT_A_WEBSITE = 'This tab isn’t a website, so there’s nothing here to block or unblock.';

// One line under the controls for anything that goes wrong. It is a
// role="alert" region, so the words are read out when they change.
function showNotice(message) {
  const el = $('popup-notice');
  if (el) el.textContent = message || '';
}

function formatCount(value) {
  const n = Number(value) || 0;
  try { return n.toLocaleString(); } catch (_) { return String(n); }
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  } catch (_) {
    return '';
  }
}

// A switch shows its state as aria-checked; .active is kept for anything that
// still reads the class.
function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

// The sentence beside a guarded control: what pressing it will ask for. It
// reads the same storage the gates read and decides nothing itself.
function gateSentence(hasPin, accessCodeAsked) {
  if (!hasPin) return accessCodeAsked
    ? 'Asks you to set a PIN first, then for an access code.'
    : 'Asks you to set a PIN first.';
  return accessCodeAsked ? 'Asks for your PIN and an access code.' : 'Asks for your PIN.';
}

async function updateLockNotes() {
  try {
    const hasPin = pinIsSet(await getPIN());
    const config = await getAccessCodeConfig();
    const asks = (critical) => !!AccessCode.requiredFor(config, critical);
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const pact = await readPact();
    if (Pact && Pact.isActive(pact)) {
      const delay = Pact.formatDelay(pact.delayMs);
      const waits = `Waits ${delay}, under your pact.`;
      set('unblock-note', waits);
      set('safesearch-note', waits);
      set('whitelist-note', waits);
      set('toggle-note', `Turning it off waits ${delay}, under your pact.`);
      return;
    }
    set('toggle-note', 'Turning it off asks you to confirm in Settings.');
    set('unblock-note', gateSentence(hasPin, asks(true)));
    set('safesearch-note', gateSentence(hasPin, asks(false)));
    set('whitelist-note', gateSentence(hasPin, asks(true)));
  } catch (_) {}
}

async function updateWhitelistDisplay() {
  const whitelist = await cleanExpiredWhitelist();
  const listContainer = $('whitelist-list');

  listContainer.textContent = '';

  if (whitelist.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'domain-empty whitelist-empty';
    empty.textContent = 'No sites are whitelisted.';
    listContainer.appendChild(empty);
    return;
  }

  whitelist.forEach(item => {
    const row = document.createElement('div');
    row.className = 'domain-row whitelist-item';

    const main = document.createElement('div');
    main.className = 'domain-main whitelist-info';

    const name = document.createElement('span');
    name.className = 'domain';
    // Show the path scope (if any) so "reddit.com" and "reddit.com/r/NoFap"
    // are distinguishable in the list.
    const label = item.path ? item.domain + item.path : item.domain;
    name.textContent = label;
    name.title = label;

    const meta = document.createElement('span');
    meta.className = 'domain-meta whitelist-type';
    const scope = item.path ? 'Page only · ' : '';
    meta.textContent = item.type === 'temporary' && item.expiresAt
      ? `${scope}Until ${formatTime(item.expiresAt)}`
      : `${scope}Added ${formatDate(item.addedAt)}`;

    main.appendChild(name);
    main.appendChild(meta);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn-text whitelist-remove';
    removeButton.textContent = 'Remove';
    removeButton.setAttribute('aria-label', `Remove ${label} from the whitelist`);
    removeButton.addEventListener('click', async () => {
      await removeFromWhitelist(item.domain, item.path || null);
      await updateWhitelistDisplay();
    });

    row.appendChild(main);
    row.appendChild(removeButton);
    listContainer.appendChild(row);
  });
}

async function updateUI() {
  try {
    const settings = await getSettings();
    const stats = await getStats();
    const dailyStats = await getDailyStats();
    const { [TEMP_DISABLE_UNTIL_KEY]: tempUntil } = await browserAPI.storage.local.get(TEMP_DISABLE_UNTIL_KEY);
    
    // The band says the state in words. On, it is the pine ground; off, it
    // drops to plain sheet, so the change of ground carries the signal.
    const status = $('status');
    const statusNote = $('status-note');
    const band = $('popup-band');
    if (band) {
      band.classList.toggle('band-pine', !!settings.enabled);
      band.classList.toggle('band-sheet', !settings.enabled);
    }
    if (settings.enabled) {
      status.textContent = 'Protected';
      status.dataset.state = 'on';
      if (statusNote) statusNote.hidden = true;
    } else {
      status.textContent = 'Protection is off';
      status.dataset.state = 'off';
      if (statusNote) {
        if (tempUntil && tempUntil > Date.now()) {
          const minsLeft = Math.max(1, Math.ceil((tempUntil - Date.now()) / 60000));
          statusNote.textContent = `back on in ${minsLeft} min`;
          statusNote.hidden = false;
        } else {
          statusNote.hidden = true;
        }
      }
    }
    const toggleNote = $('toggle-note');
    if (toggleNote) toggleNote.hidden = !settings.enabled;
    
    // Update unblock toggle visibility and state
    const domain = await getCurrentTabDomain();
    const unblockRow = $('unblock-row');
    const unblockToggle = $('unblock-toggle');
    
    const blockRow = $('block-row');
    const blockBtn = $('block-site-btn');
    const blockDesc = $('block-desc');

    // Null for anything that is not a website (see resolveTabTarget). The old
    // hostname-prefix test here let the blocked page through as the extension
    // ID, and hid these rows on real sites such as chromium.org.
    if (domain) {
      unblockRow.style.display = 'flex';
      const isWhitelisted = await isCurrentSiteWhitelisted();
      setSwitch(unblockToggle, isWhitelisted);

      // Block row: show for any real site. Reflect current state on the button.
      if (blockRow) {
        blockRow.style.display = 'flex';
        const alreadyBlocked = await isCurrentSiteBlocked();
        if (blockBtn) {
          blockBtn.disabled = alreadyBlocked || isWhitelisted;
          blockBtn.textContent = alreadyBlocked ? 'Blocked' : 'Block';
        }
        if (blockDesc) {
          blockDesc.textContent = isWhitelisted
            ? 'It’s on your whitelist. Remove it there to block it.'
            : (alreadyBlocked ? 'This site is on your blocklist.' : 'Adds this site to your blocklist.');
        }
      }
    } else {
      unblockRow.style.display = 'none';
      if (blockRow) blockRow.style.display = 'none';
    }

    // Update main toggle
    setSwitch($('toggle'), settings.enabled);

    // Update SafeSearch toggle
    setSwitch($('safesearch-toggle'), settings.safeSearchEnabled !== false);

    // Counts, in mono with separators
    $('blocked-today').textContent = formatCount(dailyStats.blockedToday);
    $('blocked-total').textContent = formatCount(stats.blockedCount);
    $('images-filtered').textContent = formatCount(dailyStats.imageBlocked);

    // Update whitelist display
    await updateWhitelistDisplay();
    await updateLockNotes();
    await renderPactWaiting();
    await renderBoost(settings);
    
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
    if (turningOff && await refusedByBoost()) return;
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
    showNotice('');
    const domain = await getCurrentTabDomain();
    if (!domain) {
      showNotice(NOT_A_WEBSITE);
      return;
    }
    
    const isWhitelisted = await isCurrentSiteWhitelisted();
    if (!isWhitelisted && await refusedByBoost()) return;

    if (isWhitelisted) {
      // Re-blocking the site: tightening, so the PIN alone (as before).
      const ok = await requirePINOnly('remove whitelist');
      if (!ok) return;
      await removeFromWhitelist(domain);
    } else if (Pact && Pact.isActive(await readPact())) {
      // Under a Pact the length is asked first, so the waiting change knows it.
      // A temporary allowance starts counting once the wait is over.
      const result = await showDurationModal({
        title: 'Whitelist this site',
        description: 'Choose how long it stays allowed once your pact’s wait is over, or keep it for good.'
      });
      if (result === null) return;
      const minutes = result && typeof result.minutes === 'number' ? result.minutes : null;
      const payload = minutes
        ? { domain, path: null, type: 'temporary', durationMs: minutes * 60 * 1000 }
        : { domain, path: null, type: 'permanent' };
      const outcome = await guardWeakeningOutcome(`whitelist ${domain}`, { critical: true, ensurePin: true },
        { kind: 'whitelist-add', payload });
      if (outcome !== 'now') return;
      if (minutes) await addToWhitelist(domain, 'temporary', payload.durationMs);
      else await addToWhitelist(domain, 'permanent');
    } else {
      // Whole-site whitelist: it overrides blocking for every page on the
      // domain, which is as total as switching blocking off, so it faces the
      // access code even in the default 'critical' scope (issue #29).
      const ok = await requirePIN('whitelist this whole site', { critical: true });
      if (!ok) return;
      // Ask for temporary duration via modal
      const result = await showDurationModal({
        title: 'Whitelist this site',
        description: 'Choose how long it stays allowed, or keep it for good.'
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

// Domain validation lives in shared/validate-domain.js (loaded before this
// script in popup.html) so the popup and options page stay in sync.
function validateDomain(domain) {
  return self.DomainValidate.validateDomain(domain);
}

async function handleAddWhitelist(type) {
  const input = $('whitelist-input');
  const errorEl = $('whitelist-error');
  // Accepts a bare domain or a domain + path (e.g. reddit.com/r/NoFap) so a
  // user can allow one section of an otherwise-blocked site.
  const parsed = self.DomainValidate.parseWhitelistInput(input.value.trim());

  if (!parsed) {
    setFieldError(input, errorEl, 'That doesn’t look like a web address. Check it and try again.');
    input.focus();
    return;
  }
  setFieldError(input, errorEl, '');

  try {
    // A bare domain unlocks the whole site; a path-scoped entry opens one
    // section, so only the former counts as critical.
    const durationMs = type === 'temporary-15' ? 15 * 60 * 1000 : (type === 'temporary-60' ? 60 * 60 * 1000 : null);
    const outcome = await guardWeakeningOutcome(
      `whitelist ${parsed.path ? parsed.domain + parsed.path : parsed.domain}`,
      { critical: !parsed.path, ensurePin: true },
      {
        kind: 'whitelist-add',
        payload: durationMs
          ? { domain: parsed.domain, path: parsed.path || null, type: 'temporary', durationMs }
          : { domain: parsed.domain, path: parsed.path || null, type: 'permanent' }
      }
    );
    if (outcome === 'queued') input.value = '';
    if (outcome !== 'now') return;
    // Support temporary durations if requested via button
    if (type === 'temporary-15') {
      await addToWhitelist(parsed.domain, 'temporary', 15 * 60 * 1000, parsed.path);
    } else if (type === 'temporary-60') {
      await addToWhitelist(parsed.domain, 'temporary', 60 * 60 * 1000, parsed.path);
    } else {
      await addToWhitelist(parsed.domain, 'permanent', null, parsed.path);
    }
    input.value = '';
    await updateWhitelistDisplay();
  } catch (error) {
    console.error('Error adding to whitelist:', error);
    setFieldError(input, errorEl, 'That didn’t save. Try again.');
  }
}

// Show the running version in the footer (was hardcoded markup).
function setVersionBadge() {
  try {
    const v = browserAPI.runtime.getManifest().version;
    const badge = $('version-badge');
    if (badge && v) badge.textContent = 'v' + v;
  } catch (_) {}
}

// Show/hide the "update available" banner from the verdict the background wrote
// to storage. Hidden unless an update exists and the user hasn't dismissed that
// specific version.
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
      sub.title = sub.textContent;
    }
    const link = $('update-banner-link');
    if (link) link.href = info.url || 'https://github.com/codepurse/BlockNSFW/releases';
    banner.classList.remove('hidden');
  } catch (_) {
    banner.classList.add('hidden');
  }
}

// Remember which version the user dismissed so the banner stays gone until the
// next release.
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

// Ask the background to refresh its update verdict (TTL-guarded). The result
// lands in storage and re-renders the banner via the onChanged listener.
function requestUpdateCheck() {
  try {
    browserAPI.runtime.sendMessage({ type: 'get_update_info' }, () => {
      void browserAPI.runtime.lastError; // swallow "no receiver" in edge cases
    });
  } catch (_) {}
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.add('loading');
  
  // Set up event listeners
  $('toggle').addEventListener('click', toggleBlocking);
  $('unblock-toggle').addEventListener('click', toggleUnblockSite);
  const blockSiteBtn = $('block-site-btn');
  if (blockSiteBtn) blockSiteBtn.addEventListener('click', blockCurrentSite);
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
  // A corrected address clears the problem line as soon as it changes.
  $('whitelist-input').addEventListener('input', () => {
    setFieldError($('whitelist-input'), $('whitelist-error'), '');
  });
  
  // SafeSearch toggle event listener
  const safeSearchToggle = $('safesearch-toggle');
  if (safeSearchToggle) {
    safeSearchToggle.addEventListener('click', async () => {
      try {
        const current = await getSettings();
        const turningOff = current.safeSearchEnabled !== false;
        const ok = turningOff
          ? await guardWeakening('turn off Safe Search enforcement', { ensurePin: true },
            { kind: 'settings', payload: { set: { safeSearchEnabled: false } } })
          : await requirePIN('switch SafeSearch mode');
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
  
  // Dialog keyboard rules: Escape cancels, Tab stays inside.
  holdFocusIn($('pin-modal-overlay'), $('pin-cancel'));
  holdFocusIn($('access-code-modal-overlay'), $('access-code-cancel'));
  holdFocusIn($('duration-modal-overlay'), $('duration-cancel'));
  holdFocusIn($('pact-modal-overlay'), $('pact-cancel'));
  holdFocusIn($('storm-modal-overlay'), $('storm-cancel'));

  const stormBtn = $('storm-btn');
  if (stormBtn) stormBtn.addEventListener('click', startStorm);
  const slipLink = $('slip-link');
  if (slipLink) {
    slipLink.addEventListener('click', (e) => {
      e.preventDefault();
      browserAPI.tabs.create({ url: browserAPI.runtime.getURL('morning.html') });
      window.close();
    });
  }

  // Anything whose wait is over is applied as the popup opens.
  if (Pact) Pact.ask({ type: 'pact_process' });

  // Update-available banner
  setVersionBadge();
  const dismissBtn = $('update-banner-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', dismissUpdateBanner);
  await renderUpdateBanner();
  requestUpdateCheck();

  // Initialize streak tracking if not already started
  await initializeStreak();

  // Initial UI update
  await updateUI();

  // First focus lands on the main control, so Space flips it straight away.
  const mainSwitch = $('toggle');
  if (mainSwitch && (!document.activeElement || document.activeElement === document.body)) {
    try { mainSwitch.focus({ preventScroll: true }); } catch (_) {}
  }

  // Listen for storage changes to update UI in real-time
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[BLOCKED_STATS_KEY] || changes[DAILY_STATS_KEY] || changes[WHITELIST_KEY])) {
      updateUI();
    }
    if (area === 'local' && (changes[UPDATE_INFO_KEY] || changes[UPDATE_DISMISSED_KEY])) {
      renderUpdateBanner();
    }
    if (area === 'local' && Pact && (changes[Pact.PACT_KEY] || changes[Pact.QUEUE_KEY])) {
      renderPactWaiting();
      updateLockNotes();
    }
    if (area === 'local' && Boost && changes[Boost.STATE_KEY]) updateUI();
  });
});

// Update stats when popup opens (in case background script updated them)
window.addEventListener('focus', updateUI);
