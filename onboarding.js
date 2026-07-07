// onboarding.js — first-run setup wizard for BlockNSFW.
// Opened once on fresh install (see background.js onInstalled). Writes the same
// storage keys the rest of the extension reads:
//   pblocker_settings  — aiImageBlocker / aiTextBlocker / aiStrictness / aiTextStrictness
//   pblocker_pin       — plaintext PIN (matches options.js semantics)
//   pblocker_onboarding_completed — guard so the wizard never re-opens
// CSP forbids inline scripts, so every handler is attached here via addEventListener.

(function () {
  'use strict';

  const browserAPI = (typeof browser !== 'undefined' && browser)
    ? browser
    : (typeof chrome !== 'undefined' ? chrome : null);
  const hasStorage = !!(browserAPI && browserAPI.storage && browserAPI.storage.local);

  const SETTINGS_KEY = 'pblocker_settings';
  const PIN_KEY = 'pblocker_pin';
  const ONBOARDING_KEY = 'pblocker_onboarding_completed';

  // Strictness copy mirrors getAiStrictnessMeta() in options.js.
  const STRICTNESS = {
    relaxed: 'Blocks only clearly explicit content. Fewest false positives.',
    balanced: 'Blocks clear adult content while letting most safe content through.',
    strict: 'Also catches borderline / suggestive content. May hide some safe content.'
  };
  function normalizeStrictness(v) {
    v = String(v || '').toLowerCase();
    return (v === 'relaxed' || v === 'strict') ? v : 'balanced';
  }

  const $ = (id) => document.getElementById(id);

  // ---- storage helpers -----------------------------------------------------
  async function getStored(keys) {
    if (!hasStorage) return {};
    try { return (await browserAPI.storage.local.get(keys)) || {}; }
    catch (_) { return {}; }
  }
  async function setStored(obj) {
    if (!hasStorage) return false;
    try { await browserAPI.storage.local.set(obj); return true; }
    catch (_) { return false; }
  }
  // Read-modify-write so we never clobber unrelated settings written elsewhere.
  async function patchSettings(patch) {
    const cur = await getStored(SETTINGS_KEY);
    const settings = Object.assign({}, cur[SETTINGS_KEY] || {}, patch);
    await setStored({ [SETTINGS_KEY]: settings });
  }

  // ---- wizard state --------------------------------------------------------
  const STEPS = [1, 2, 3, 4];
  let idx = 0; // 0-based index into STEPS

  const els = {
    dots: () => Array.from(document.querySelectorAll('#dots .dot')),
    steps: () => Array.from(document.querySelectorAll('.step')),
    foot: $('foot'),
    back: $('back'),
    skip: $('skip'),
    next: $('next'),
    done: $('done'),
    aiImage: $('ai-image'),
    aiText: $('ai-text'),
    strictness: $('strictness'),
    strictnessDetail: $('strictness-detail'),
    pin: $('pin'),
    pin2: $('pin2'),
    pinErr: $('pin-err')
  };

  // Per-step footer configuration.
  const FOOT = {
    1: { back: false, skip: false, next: 'Get started' },
    2: { back: true, skip: false, next: 'Continue' },
    3: { back: true, skip: true, next: 'Set PIN & Continue' },
    4: { back: true, skip: false, next: 'Finish setup' }
  };

  function render() {
    const step = STEPS[idx];
    els.steps().forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === step));
    els.dots().forEach((d, i) => {
      d.classList.toggle('active', i === idx);
      d.classList.toggle('done', i < idx);
    });
    const cfg = FOOT[step];
    els.back.hidden = !cfg.back;
    els.skip.hidden = !cfg.skip;
    els.next.textContent = cfg.next;
    els.pinErr.textContent = '';
  }

  // ---- step side effects ---------------------------------------------------
  async function saveAiStep() {
    const strictness = normalizeStrictness(els.strictness.value);
    await patchSettings({
      aiImageBlocker: !!els.aiImage.checked,
      aiTextBlocker: !!els.aiText.checked,
      aiStrictness: strictness,
      aiTextStrictness: strictness
    });
  }

  // Returns true if the PIN step is satisfied (valid PIN saved, or nothing entered).
  async function trySavePin() {
    const a = els.pin.value || '';
    const b = els.pin2.value || '';
    if (!a && !b) { els.pinErr.textContent = ''; return true; } // treated as "no PIN"
    if (a.length < 4) { els.pinErr.textContent = 'PIN must be at least 4 characters.'; return false; }
    if (a !== b) { els.pinErr.textContent = 'The two PINs don’t match.'; return false; }
    await setStored({ [PIN_KEY]: a });
    return true;
  }

  async function finish() {
    await setStored({ [ONBOARDING_KEY]: true });

    // Build a short summary of what was turned on.
    const parts = [];
    const img = els.aiImage.checked, txt = els.aiText.checked;
    if (img && txt) parts.push('AI image + text protection on');
    else if (img) parts.push('AI image protection on');
    else if (txt) parts.push('AI text protection on');
    else parts.push('Core blocking on');
    if (img || txt) parts.push('(' + normalizeStrictness(els.strictness.value) + ')');
    const hasPin = await getStored(PIN_KEY);
    if (hasPin[PIN_KEY]) parts.push('· PIN set');

    const summary = $('done-summary');
    if (summary) summary.textContent = parts.join(' ') + '. You can change any of this in Settings.';

    els.foot.hidden = true;
    els.steps().forEach((s) => s.classList.remove('active'));
    els.dots().forEach((d) => d.classList.add('done'));
    els.done.classList.add('active');
  }

  // ---- navigation ----------------------------------------------------------
  async function goNext() {
    const step = STEPS[idx];
    els.next.disabled = true;
    try {
      if (step === 2) {
        await saveAiStep();
      } else if (step === 3) {
        const ok = await trySavePin();
        if (!ok) return; // validation failed — stay on step
      } else if (step === 4) {
        await finish();
        return;
      }
      if (idx < STEPS.length - 1) { idx++; render(); }
    } finally {
      els.next.disabled = false;
    }
  }

  async function goSkip() {
    // Only the PIN step shows Skip: advance without setting a PIN.
    els.pin.value = '';
    els.pin2.value = '';
    els.pinErr.textContent = '';
    if (idx < STEPS.length - 1) { idx++; render(); }
  }

  function goBack() {
    if (idx > 0) { idx--; render(); }
  }

  // ---- init ----------------------------------------------------------------
  async function init() {
    // Pre-select the recommended defaults, seeded from any existing settings.
    const cur = (await getStored(SETTINGS_KEY))[SETTINGS_KEY] || {};
    els.aiImage.checked = cur.aiImageBlocker !== undefined ? !!cur.aiImageBlocker : true;
    els.aiText.checked = cur.aiTextBlocker !== undefined ? !!cur.aiTextBlocker : true;
    els.strictness.value = normalizeStrictness(cur.aiStrictness || cur.aiTextStrictness || 'balanced');
    els.strictnessDetail.textContent = STRICTNESS[normalizeStrictness(els.strictness.value)];

    els.strictness.addEventListener('change', () => {
      els.strictnessDetail.textContent = STRICTNESS[normalizeStrictness(els.strictness.value)];
    });
    els.next.addEventListener('click', goNext);
    els.back.addEventListener('click', goBack);
    els.skip.addEventListener('click', goSkip);
    // Enter within a PIN field advances.
    [els.pin, els.pin2].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); goNext(); }
    }));

    const settingsBtn = $('done-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => { window.location.href = 'options.html'; });
    const closeBtn = $('done-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      window.close();
      // If the tab wasn't script-closable, fall back to Settings.
      setTimeout(() => { window.location.href = 'options.html'; }, 150);
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
