// onboarding.js — first-run setup wizard for BlockNSFW.
// Opened once on fresh install (see background.js onInstalled). Writes the same
// storage keys the rest of the extension reads:
//   pblocker_settings  — aiImageBlocker / aiTextBlocker / aiStrictness / aiTextStrictness / dnsFilterEnabled
//   pblocker_pin       — the PIN, hashed by shared/pin-hash.js (never overwrites one)
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
    strict: 'Also catches borderline and suggestive content. May hide some safe content.'
  };
  const STRICTNESS_LABEL = { relaxed: 'Relaxed', balanced: 'Balanced', strict: 'Strict' };
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
  const STEPS = [1, 2, 3, 4, 5];
  let idx = 0; // 0-based index into STEPS

  const els = {
    steps: () => Array.from(document.querySelectorAll('.step')),
    foot: $('foot'),
    back: $('back'),
    skip: $('skip'),
    next: $('next'),
    done: $('done'),
    announce: $('announce'),
    aiImage: $('ai-image'),
    aiText: $('ai-text'),
    strictness: $('strictness'),
    strictnessDetail: $('strictness-detail'),
    dnsFilter: $('dns-filter'),
    pin: $('pin'),
    pin2: $('pin2'),
    pinErr: $('pin-err')
  };

  // Per-step footer configuration.
  const FOOT = {
    1: { back: false, skip: false, next: 'Start setup' },
    2: { back: true, skip: false, next: 'Save and continue' },
    3: { back: true, skip: true, next: 'Set PIN and continue' },
    4: { back: true, skip: false, next: 'Continue' },
    5: { back: true, skip: true, next: 'Finish setup' }
  };

  // Moves focus to a screen's headline, so keyboard and screen-reader users
  // start the new screen at its top. The headline carries "Step N of 5".
  function focusHeading(section) {
    const heading = section && section.querySelector('h1');
    if (!heading) return;
    try { window.scrollTo(0, 0); } catch (_) {}
    try { heading.focus({ preventScroll: true }); } catch (_) { heading.focus(); }
  }

  // One polite message at a time, for changes nothing else announces.
  let announceTimer = 0;
  function announce(message) {
    if (!els.announce) return;
    clearTimeout(announceTimer);
    els.announce.textContent = '';
    announceTimer = setTimeout(() => { els.announce.textContent = message; }, 50);
  }

  function clearPinError() {
    els.pinErr.textContent = '';
    els.pin.removeAttribute('aria-invalid');
    els.pin2.removeAttribute('aria-invalid');
  }

  function showPinError(field, message) {
    clearPinError();
    els.pinErr.textContent = message;
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }

  function render(moveFocus) {
    const step = STEPS[idx];
    let current = null;
    els.steps().forEach((s) => {
      const on = Number(s.dataset.step) === step;
      s.hidden = !on;
      if (on) current = s;
    });
    const cfg = FOOT[step];
    els.back.hidden = !cfg.back;
    els.skip.hidden = !cfg.skip;
    els.next.textContent = cfg.next;
    clearPinError();
    if (moveFocus) focusHeading(current);
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

  async function saveDnsStep() {
    await patchSettings({ dnsFilterEnabled: !!els.dnsFilter.checked });
  }

  // Returns true if the PIN step is satisfied (valid PIN saved, or nothing entered).
  async function trySavePin() {
    const a = els.pin.value || '';
    const b = els.pin2.value || '';
    if (!a && !b) { clearPinError(); return true; } // treated as "no PIN"
    if (a.length < 4) {
      showPinError(els.pin, 'Your PIN is too short. Use at least four characters.');
      return false;
    }
    if (a !== b) {
      showPinError(els.pin2, 'The two PINs don’t match. Type the same PIN in both boxes.');
      return false;
    }
    // Never replace a PIN that already exists: this page asks for no PIN of
    // its own, so overwriting one here would be a way around it.
    const existing = (await getStored(PIN_KEY))[PIN_KEY];
    if (existing) return true;
    const stored = self.PinHash ? await self.PinHash.hash(a) : a;
    await setStored({ [PIN_KEY]: stored });
    return true;
  }

  async function finish() {
    await setStored({ [ONBOARDING_KEY]: true });

    // A short summary of what was turned on.
    const parts = [];
    const img = els.aiImage.checked, txt = els.aiText.checked;
    if (img && txt) parts.push('AI image and text protection on');
    else if (img) parts.push('AI image protection on');
    else if (txt) parts.push('AI text protection on');
    else parts.push('Blocklist and keyword filter on');
    if (img || txt) parts.push(STRICTNESS_LABEL[normalizeStrictness(els.strictness.value)] + ' strength');
    const hasPin = await getStored(PIN_KEY);
    if (hasPin[PIN_KEY]) parts.push('PIN set');
    if (els.dnsFilter.checked) parts.push('DNS check on');

    const summary = $('done-summary');
    if (summary) summary.textContent = parts.join(' · ');

    els.foot.hidden = true;
    els.steps().forEach((s) => { s.hidden = true; });
    els.done.hidden = false;
    focusHeading(els.done);
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
      } else if (step === 5) {
        await saveDnsStep();
        await finish();
        return;
      }
      if (idx < STEPS.length - 1) { idx++; render(true); }
    } finally {
      els.next.disabled = false;
    }
  }

  async function goSkip() {
    // Skip appears on the PIN step and the DNS step. On the last step there is
    // nothing to advance to, so skipping means "finish without enabling this".
    if (STEPS[idx] === 5) {
      els.dnsFilter.checked = false;
      await saveDnsStep();
      await finish();
      return;
    }
    els.pin.value = '';
    els.pin2.value = '';
    clearPinError();
    if (idx < STEPS.length - 1) { idx++; render(true); }
  }

  function goBack() {
    if (idx > 0) { idx--; render(true); }
  }

  // ---- init ----------------------------------------------------------------
  async function init() {
    // The wizard runs once. Reopened later (it is just a page inside the
    // extension) it could switch protection layers off or set a PIN without
    // asking for anything, so once setup is done, or a Pact is made, it sends
    // you to Settings instead.
    const state = await getStored([ONBOARDING_KEY, 'pblocker_pact']);
    const pactActive = !!(state.pblocker_pact && state.pblocker_pact.active === true);
    if (hasStorage && (state[ONBOARDING_KEY] || pactActive)) {
      location.replace(browserAPI.runtime.getURL('options.html'));
      return;
    }

    // Pre-select the recommended defaults, seeded from any existing settings.
    const cur = (await getStored(SETTINGS_KEY))[SETTINGS_KEY] || {};
    els.aiImage.checked = cur.aiImageBlocker !== undefined ? !!cur.aiImageBlocker : true;
    els.aiText.checked = cur.aiTextBlocker !== undefined ? !!cur.aiTextBlocker : true;
    els.strictness.value = normalizeStrictness(cur.aiStrictness || cur.aiTextStrictness || 'balanced');
    els.strictnessDetail.textContent = STRICTNESS[normalizeStrictness(els.strictness.value)];

    els.strictness.addEventListener('change', () => {
      els.strictnessDetail.textContent = STRICTNESS[normalizeStrictness(els.strictness.value)];
    });
    els.dnsFilter.checked = cur.dnsFilterEnabled === true; // off unless already on

    // Copy buttons for the device-level resolver addresses. The label reads
    // "Copied" for a moment; the live region says which addresses.
    document.querySelectorAll('.copy-btn').forEach((btn) => {
      const original = btn.textContent;
      let resetTimer = 0;
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy') || '';
        const name = btn.getAttribute('data-name') || '';
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          // Clipboard blocked: the addresses are on screen to type.
          announce('Copying was blocked. Select the addresses and copy them yourself.');
          return;
        }
        btn.textContent = 'Copied';
        announce(name ? 'Copied the ' + name + ' addresses.' : 'Copied the addresses.');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { btn.textContent = original; }, 1600);
      });
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

    render(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
