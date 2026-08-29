// Tests for the popup's protection-strength gates.
//
// These exist because of issue #29. The access code — the second layer over
// the PIN — was implemented only in options.js, and the popup carried its own
// PIN-only copy of requirePIN. So "unblock this site", which writes a
// whole-site whitelist entry that overrides blocking entirely, was reachable
// with nothing but a four-digit PIN no matter how the user had configured the
// code. The options page promised "every change that reduces your protection";
// the popup was outside that promise.
//
// What's pinned down here: the popup reaches the shared access-code layer at
// all, it passes the right criticality, and it fails closed when it can't ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const ACCESS_CODE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'access-code.js'), 'utf8');

// `store` is the backing storage: keys as the extension writes them.
function loadPopupContext(store = {}) {
  const context = {
    chrome: {
      runtime: { getURL: (p) => `chrome-extension://test/${p}` },
      storage: {
        local: {
          get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
          set: (payload) => { Object.assign(store, payload); return Promise.resolve(); },
          remove: (key) => { delete store[key]; return Promise.resolve(); },
        },
      },
      tabs: { query: () => Promise.resolve([]), create: () => {} },
    },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    console,
    crypto: require('node:crypto').webcrypto,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    alert() {},
    addEventListener() {},
    removeEventListener() {},
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  // popup.html loads the shared module before popup.js; mirror that.
  vm.runInContext(ACCESS_CODE_SOURCE, context);
  vm.runInContext(POPUP_SOURCE, context);
  return context;
}

// popup.js is sloppy-mode, so its top-level function declarations land on the
// context object — which means the modals can be swapped for spies here.
function stubModals(ctx, { pin = '1234', code = true } = {}) {
  const calls = { pinPrompts: 0, codePrompts: [] };
  ctx.showPinModal = async () => { calls.pinPrompts++; return pin; };
  ctx.showSetPinModal = async () => pin;
  ctx.showAccessCodeModal = async (label) => { calls.codePrompts.push(label); return code; };
  return calls;
}

const CODE_KEY = 'pblocker_access_code';
const PIN_KEY = 'pblocker_pin';

test('requirePIN: the access code runs after a correct PIN', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'all' },
  });
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePIN('whitelist this whole site'), true);
  assert.equal(calls.pinPrompts, 1);
  assert.deepEqual(calls.codePrompts, ['whitelist this whole site']);
});

test('requirePIN: a refused access code blocks the action even with the right PIN', async () => {
  // The regression the issue reported: PIN accepted, action allowed, code
  // never asked for.
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'all' },
  });
  stubModals(ctx, { code: false });
  assert.equal(await ctx.requirePIN('whitelist this whole site'), false);
});

test('requirePIN: critical scope guards a whole-site whitelist', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'critical' },
  });
  const calls = stubModals(ctx);
  await ctx.requirePIN('whitelist this whole site', { critical: true });
  assert.deepEqual(calls.codePrompts, ['whitelist this whole site']);
});

test('requirePIN: critical scope leaves the small changes alone', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'critical' },
  });
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePIN('switch SafeSearch mode'), true);
  assert.deepEqual(calls.codePrompts, []);
});

test('requirePIN: a wrong PIN never reaches the code', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'all' },
  });
  const calls = stubModals(ctx, { pin: '9999' });
  assert.equal(await ctx.requirePIN('whitelist this whole site'), false);
  assert.deepEqual(calls.codePrompts, []);
});

test('requirePIN: a cancelled PIN prompt refuses the action', async () => {
  const ctx = loadPopupContext({ [PIN_KEY]: '1234' });
  const calls = stubModals(ctx, { pin: null });
  assert.equal(await ctx.requirePIN('whitelist this whole site'), false);
  assert.deepEqual(calls.codePrompts, []);
});

test('requirePIN: with the code off, the PIN alone still passes', async () => {
  const ctx = loadPopupContext({ [PIN_KEY]: '1234' });
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePIN('whitelist this whole site'), true);
  assert.deepEqual(calls.codePrompts, []);
});

test('requirePINIfSet: the code stands on its own when no PIN is set', async () => {
  // Matches options.js: someone who set an access code but no PIN is still
  // protected by the code.
  const ctx = loadPopupContext({ [CODE_KEY]: { enabled: true, length: 32, scope: 'all' } });
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePINIfSet('import a whitelist'), true);
  assert.equal(calls.pinPrompts, 0);
  assert.deepEqual(calls.codePrompts, ['import a whitelist']);
});

test('requirePINIfSet: nothing configured lets the action through', async () => {
  const ctx = loadPopupContext({});
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePINIfSet('do something'), true);
  assert.equal(calls.pinPrompts, 0);
  assert.deepEqual(calls.codePrompts, []);
});

test('requirePINOnly: re-blocking a site never asks for the code', async () => {
  // Tightening is free (issue #11). Under the 'all' scope the code would
  // otherwise charge 256 characters of typing to undo a whitelist entry.
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'all' },
  });
  const calls = stubModals(ctx);
  assert.equal(await ctx.requirePINOnly('remove whitelist'), true);
  assert.equal(calls.pinPrompts, 1);
  assert.deepEqual(calls.codePrompts, []);
});

test('showAccessCodeModal: refuses when the modal is missing from the DOM', async () => {
  // getElementById returns null in this harness. Failing open here would
  // reinstate the bug; falling back to prompt() would be worse still, since
  // its box accepts a paste.
  const ctx = loadPopupContext({ [CODE_KEY]: { enabled: true, length: 32, scope: 'all' } });
  assert.equal(await ctx.showAccessCodeModal('do something'), false);
});

test('unblocking a site from the popup asks for the code in the default scope', async () => {
  // End-to-end over the exact path in the issue: popup → unblock toggle →
  // whole-site whitelist entry.
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'critical' },
  });
  const calls = stubModals(ctx);
  ctx.getCurrentTabDomain = async () => 'example.com';
  ctx.isCurrentSiteWhitelisted = async () => false;
  ctx.showDurationModal = async () => ({ minutes: null }); // permanent
  ctx.updateUI = async () => {};
  ctx.updateWhitelistDisplay = async () => {};

  let whitelisted = null;
  ctx.addToWhitelist = async (domain, type) => { whitelisted = { domain, type }; };

  await ctx.toggleUnblockSite();

  assert.equal(calls.codePrompts.length, 1, 'the access code must be required');
  assert.deepEqual(whitelisted, { domain: 'example.com', type: 'permanent' });
});

test('a refused code leaves the site blocked', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'critical' },
  });
  stubModals(ctx, { code: false });
  ctx.getCurrentTabDomain = async () => 'example.com';
  ctx.isCurrentSiteWhitelisted = async () => false;
  ctx.showDurationModal = async () => { throw new Error('must not reach the duration modal'); };
  ctx.updateUI = async () => {};
  ctx.updateWhitelistDisplay = async () => {};

  let whitelisted = null;
  ctx.addToWhitelist = async () => { whitelisted = true; };

  await ctx.toggleUnblockSite();
  assert.equal(whitelisted, null);
});

test('re-blocking from the unblock toggle stays PIN-only', async () => {
  const ctx = loadPopupContext({
    [PIN_KEY]: '1234',
    [CODE_KEY]: { enabled: true, length: 32, scope: 'all' },
  });
  const calls = stubModals(ctx);
  ctx.getCurrentTabDomain = async () => 'example.com';
  ctx.isCurrentSiteWhitelisted = async () => true;
  ctx.updateUI = async () => {};
  ctx.updateWhitelistDisplay = async () => {};

  let removed = null;
  ctx.removeFromWhitelist = async (domain) => { removed = domain; };

  await ctx.toggleUnblockSite();
  assert.equal(removed, 'example.com');
  assert.deepEqual(calls.codePrompts, []);
});
