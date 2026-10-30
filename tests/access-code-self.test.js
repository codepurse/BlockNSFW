// Weakening the access code itself faces a longer code (issue #48).
//
// Turning the code off, asking for it less often and shortening it each asked
// for one code at the chosen length, the same as any other critical change.
// On the "every change" scope that made switching it off the cheapest way to
// make several changes: one code to turn it off, then nothing. Those three now
// face a code AccessCode.SELF_FACTOR times as long; nothing else does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OPTIONS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
const ACCESS_CODE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'access-code.js'), 'utf8');

// options.js with no Pact or Boost loaded, so guardWeakening takes the PIN and
// access-code path. The code dialog is stood in for: it records what it was
// asked to show and is cancelled.
function loadOptions(store) {
  const elements = {};
  const element = (id) => {
    if (!elements[id]) elements[id] = { id, textContent: '', value: '', addEventListener() {} };
    return elements[id];
  };
  const context = {
    chrome: {
      storage: {
        local: {
          get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
          set: (payload) => { Object.assign(store, payload); return Promise.resolve(); },
        },
        session: {},
      },
      runtime: {},
    },
    window: {},
    document: { addEventListener() {}, getElementById: element },
    crypto: require('node:crypto').webcrypto,
    setTimeout,
    console,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(ACCESS_CODE_SOURCE, context);
  vm.runInContext(OPTIONS_SOURCE, context);
  const modals = [];
  context.createModal = (config) => { modals.push(config); return Promise.resolve(false); };
  return { context, modals, shownCode: () => element('modal-access-code').textContent };
}

const CODE_ON = { pblocker_access_code: { enabled: true, length: 64, scope: 'all' } };

test('a change to the code itself shows a code twice as long', async () => {
  const { context, modals, shownCode } = loadOptions({ ...CODE_ON });
  const ok = await context.guardWeakening('turn off the access code',
    { critical: true, aboutCode: true }, { kind: 'access-code', payload: {} });
  assert.equal(ok, false, 'the cancelled dialog refuses the change');
  assert.equal(modals.length, 1);
  assert.equal(shownCode().length, 64 * context.AccessCode.SELF_FACTOR);
  assert.match(modals[0].description, /twice as long/);
});

test('any other change shows the chosen length', async () => {
  for (const opts of [{ critical: true }, {}]) {
    const { context, modals, shownCode } = loadOptions({ ...CODE_ON });
    await context.guardWeakening('disable blocking', opts, { kind: 'settings', payload: {} });
    assert.equal(modals.length, 1);
    assert.equal(shownCode().length, 64);
    assert.doesNotMatch(modals[0].description, /twice as long/);
  }
});

test('with the code off, a change to it asks for no code at all', async () => {
  const { context, modals } = loadOptions({ pblocker_access_code: { enabled: false, length: 64 } });
  const ok = await context.guardWeakening('turn off the access code',
    { critical: true, aboutCode: true }, { kind: 'access-code', payload: {} });
  assert.equal(ok, true);
  assert.equal(modals.length, 0);
});

// The three switches live in options.js's DOMContentLoaded handler, so their
// gates are checked in the source.
for (const label of ['turn off the access code', 'ask for the access code less often', 'shorten the access code']) {
  test(`"${label}" is gated as a change to the code itself`, () => {
    const call = OPTIONS_SOURCE.match(new RegExp(`guardWeakening\\('${label}', \\{([^}]*)\\}`));
    assert.ok(call, `no guardWeakening call for "${label}"`);
    assert.match(call[1], /critical: true/);
    assert.match(call[1], /aboutCode: true/);
  });
}

test('nothing else is gated as a change to the code', () => {
  const calls = OPTIONS_SOURCE.match(/aboutCode: true/g) || [];
  assert.equal(calls.length, 3);
});
