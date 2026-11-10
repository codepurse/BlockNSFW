// The browser's extensions page, locked behind the PIN
// (shared/extensions-lock.js, background.js "The extensions page lock").
//
// Reported 2026-11-09: with a PIN and Risk hours on, someone switched
// BlockNSFW off in private windows from the extensions page and browsed
// freely there. No extension can lock that switch, so the page itself is
// locked: a tab arriving on it is sent to Settings, which asks for the PIN or
// a pact's wait. The access code joins in only on its "every change" scope
// (chosen 2026-11-10: PIN only there).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadBackgroundContext } = require('./setup');
const L = require('../shared/extensions-lock.js');
const Pact = require('../shared/pact.js');
const Boost = require('../shared/boost.js');
const AccessCode = require('../shared/access-code.js');

const ROOT = path.join(__dirname, '..');
const LOCK_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'extensions-lock.js'), 'utf8');
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 21, 0, 0);
const PIN = { v: 1, salt: 'aa', hash: 'bb' };

test('recognises the extensions page in every browser, and nothing else', () => {
  for (const url of [
    'chrome://extensions', 'chrome://extensions/', 'chrome://extensions/?id=abcdef',
    'chrome://extensions/shortcuts', 'edge://extensions/', 'brave://extensions/',
    'opera://extensions', 'vivaldi://extensions/', 'about:addons', 'about:addons#detail',
    'CHROME://EXTENSIONS/'
  ]) {
    assert.equal(L.isExtensionsPage(url), true, url);
  }
  for (const url of [
    'https://extensions.gnome.org/', 'https://chromewebstore.google.com/category/extensions',
    'chrome://extensions-internals/', 'chrome://settings/', 'about:config', 'about:addonsx',
    'chrome-extension://abc/options.html', '', null, undefined
  ]) {
    assert.equal(L.isExtensionsPage(url), false, String(url));
  }
});

// The switch is off until the person turns it on (2026-11-10: it can shut
// them out of their own extensions page, so it is a choice, never a default).
const ON = { [L.SETTINGS_KEY]: { lockExtensionsPage: true } };

test('off by default, and off means off, hard hours included', () => {
  assert.equal(L.lockState({}).switchOn, false);
  assert.equal(L.lockState({ [L.SETTINGS_KEY]: {} }).switchOn, false, 'a settings object without the key');
  assert.equal(L.lockState({ [L.PIN_KEY]: PIN }).locked, false, 'a PIN alone locks nothing');
  assert.equal(L.lockState({ [L.PIN_KEY]: PIN, [L.BOOST_STATE_KEY]: { active: 'risk', until: T0 } }).locked, false,
    'nor do risk hours, unless it was chosen');
  assert.equal(L.lockState({ [L.SETTINGS_KEY]: { lockExtensionsPage: 'yes' } }).switchOn, false, 'only true turns it on');
});

test('switched on, locked once a PIN or a pact guards loosening', () => {
  assert.equal(L.lockState({ ...ON }).locked, false, 'nothing set: nothing to ask for');
  assert.equal(L.lockState({ ...ON, [L.PIN_KEY]: PIN }).locked, true);
  assert.equal(L.lockState({ ...ON, [L.PIN_KEY]: '1234' }).locked, true, 'a PIN an older version saved');
  assert.equal(L.lockState({ ...ON, [L.PIN_KEY]: '' }).locked, false);
  assert.equal(L.lockState({ ...ON, [L.PACT_KEY]: { active: true } }).locked, true);
});

test('it needs a PIN or a pact: an access code alone never locks the page', () => {
  const code = (config, extra = {}) => L.lockState({ ...ON, [L.ACCESS_CODE_KEY]: config, ...extra });
  assert.equal(code({ enabled: true }).locked, false, 'its default scope');
  assert.equal(code({ enabled: true, scope: 'all' }).locked, false, 'even guarding every change');
  assert.equal(code({ enabled: true }).guarded, true, 'pages still wait while site access is off');
  assert.equal(code({ enabled: true, scope: 'all' }, { [L.PIN_KEY]: PIN }).locked, true, 'with a PIN it locks');
});

test('after the PIN, the access code asks only when it guards every change', () => {
  const code = (config) => L.lockState({ ...ON, [L.PIN_KEY]: PIN, [L.ACCESS_CODE_KEY]: config });
  assert.equal(code({ enabled: true }).codeHere, false, 'its default scope: the master switches alone');
  assert.equal(code({ enabled: true, scope: 'critical' }).codeHere, false);
  assert.equal(code({ enabled: true, scope: 'all' }).codeHere, true, 'every change');
  assert.equal(code({ enabled: false, scope: 'all' }).codeHere, false);
});

test('Settings says the lock needs a PIN', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const desc = html.slice(html.indexOf('id="lock-extensions-page-desc"'), html.indexOf('id="lock-extensions-page-state"'));
  assert.ok(desc.includes('It needs a PIN to work'), 'beside the switch');
  const source = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  assert.ok(source.includes('Not locked: it needs a PIN.'), 'the state line, switched on with no PIN');
  assert.ok(source.includes('Off. It can’t be turned on until you set a PIN.'), 'the state line, greyed out');
  assert.ok(source.includes('toggle.disabled = !ExtensionsLock.canTurnOn(state);'), 'the switch follows canTurnOn');
  assert.ok(!source.includes('} else if (!state.guarded) {'), 'the state line follows locked, not guarded');
});

test('the switch is greyed out while off with no PIN and no pact, never once on', () => {
  const can = (extra) => L.canTurnOn(L.lockState({ [L.SETTINGS_KEY]: {}, ...extra }));
  assert.equal(can({}), false, 'off, nothing set');
  assert.equal(can({ [L.ACCESS_CODE_KEY]: { enabled: true, scope: 'all' } }), false, 'an access code alone');
  assert.equal(can({ [L.BOOST_STATE_KEY]: { active: 'risk', until: T0 } }), false, 'risk hours alone');
  assert.equal(can({ [L.PIN_KEY]: PIN }), true, 'a PIN');
  assert.equal(can({ [L.PIN_KEY]: '1234' }), true, 'a PIN an older version saved');
  assert.equal(can({ [L.PACT_KEY]: { active: true } }), true, 'a pact');
  assert.equal(L.canTurnOn(L.lockState({ ...ON })), true, 'on with the PIN since cleared: it can still be turned off');
  assert.equal(L.canTurnOn(null), false);
});

test('codeHere matches what the access code asks for at the tier Settings opens the page with', () => {
  const configs = [null, {}, { enabled: true }, { enabled: true, scope: 'critical' }, { enabled: true, scope: 'all' },
    { enabled: false, scope: 'all' }, { enabled: true, scope: 'nonsense' }];
  for (const config of configs) {
    assert.equal(L.lockState({ ...ON, [L.ACCESS_CODE_KEY]: config }).codeHere,
      AccessCode.requiredFor(config, 'normal'), JSON.stringify(config));
  }
});

test('opening the page and switching the lock off ask at the normal tier, not the critical one', () => {
  const source = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  assert.ok(source.includes("guardWeakeningOutcome('open the extensions page', { tier: 'normal' }"), 'opening');
  assert.ok(source.includes("guardWeakening('stop locking the extensions page', { tier: 'normal' }"), 'switching off');
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const row = html.slice(html.indexOf('id="lock-extensions-page-desc"'), html.indexOf('id="lock-warning"'));
  assert.match(row, /data-lock="normal" data-lock-when="Turning it off"/, 'the note says what turning it off asks');
  assert.doesNotMatch(html.slice(html.indexOf('id="lock-warning-list"'), html.indexOf('id="lock-warning-list"') + 400),
    /access code/, 'the warning no longer promises the code on every visit');
});

test('switched on, Storm Mode and Risk hours shut it even with no PIN', () => {
  assert.equal(L.lockState({ ...ON, [L.BOOST_STATE_KEY]: { active: 'risk', until: T0 } }).locked, true);
  assert.equal(L.lockState({ ...ON, [L.BOOST_STATE_KEY]: { active: 'storm', until: T0 } }).locked, true);
});

test('both builds default the switch to off', () => {
  for (const file of ['background.js', 'options.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /lockExtensionsPage: false,/, file);
  }
});

test('an opening lasts ten minutes, then shuts', () => {
  const open = L.grant('unlock', T0);
  assert.equal(open.until, T0 + 10 * MIN);
  assert.deepEqual(L.visit(open, T0 + 9 * MIN, false), { allow: true });
  assert.deepEqual(L.visit(open, T0 + 10 * MIN, false), { allow: false, allowance: null });
  assert.deepEqual(L.visit(null, T0, false), { allow: false });
});

test('a boost shuts an opening, except the short one for turning private windows on', () => {
  assert.equal(L.visit(L.grant('unlock', T0), T0 + MIN, true).allow, false);
  const turnOn = L.grant('private', T0);
  assert.equal(turnOn.until, T0 + 3 * MIN);
  assert.equal(L.visit(turnOn, T0 + MIN, true).allow, true, 'turning private windows on only strengthens');
});

test('after a pact wait the opening keeps a day for its first use', () => {
  const ready = L.grantAfterWait(T0);
  const later = T0 + 5 * 60 * MIN;
  const first = L.visit(ready, later, false);
  assert.equal(first.allow, true);
  assert.deepEqual(first.allowance, { until: later + 10 * MIN, reason: 'pact' });
  assert.equal(L.visit(ready, later, true).allow, false, 'not during a boost');
  assert.deepEqual(L.visit(ready, T0 + 25 * 60 * MIN, false), { allow: false, allowance: null });
});

test('the next edge is when an opening ends', () => {
  assert.equal(L.nextEdge(L.grant('unlock', T0), T0), T0 + 10 * MIN);
  assert.equal(L.nextEdge(L.grantAfterWait(T0), T0), T0 + 24 * 60 * MIN);
  assert.equal(L.nextEdge(L.grant('unlock', T0), T0 + 11 * MIN), null);
  assert.equal(L.nextEdge(null, T0), null);
});

test('Settings only carries the tab on to the extensions page', () => {
  const path = L.lockPagePath('chrome://extensions/?id=abc');
  assert.match(path, /^options\.html\?extensions-page=chrome%3A%2F%2Fextensions%2F%3Fid%3Dabc#private-windows-group$/);
  assert.equal(L.targetFrom(path.slice('options.html'.length, path.indexOf('#'))), 'chrome://extensions/?id=abc');
  assert.equal(L.targetFrom('?extensions-page=' + encodeURIComponent('https://evil.example/')), null);
  assert.equal(L.targetFrom('?extensions-page=' + encodeURIComponent('javascript:alert(1)')), null);
  assert.equal(L.targetFrom(''), null);
});

test('the keys it reads are the ones their own modules write', () => {
  assert.equal(L.PACT_KEY, Pact.PACT_KEY);
  assert.equal(L.BOOST_STATE_KEY, Boost.STATE_KEY);
  assert.equal(L.ACCESS_CODE_KEY, AccessCode.KEY);
  const options = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  assert.match(options, new RegExp(`const PIN_KEY = '${L.PIN_KEY}'`));
  assert.match(options, new RegExp(`const SETTINGS_KEY = '${L.SETTINGS_KEY}'`));
  assert.equal(L.ALLOW_KEY.startsWith('pblocker_'), true);
});

test('both builds ask for the tabs permission, and a pact can carry an opening', () => {
  for (const file of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.ok(manifest.permissions.includes('tabs'), `${file} needs "tabs" to see the extensions page`);
  }
  assert.ok(Pact.KINDS.includes('extensions-page'));
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  assert.match(html, /<script src="shared\/extensions-lock\.js"><\/script>/);
  assert.match(html, /id="private-windows-group"/);
  assert.match(html, /id="lock-extensions-page"/);
});

test('the lock warns before anyone relies on it, and asks once when turned on', () => {
  // Asked for 2026-11-09: the switch can shut someone out of their own
  // extensions page, so a plain description was not enough.
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const panel = html.slice(html.indexOf('id="lock-warning"'), html.indexOf('</ul>', html.indexOf('id="lock-warning-list"')));
  assert.ok(panel.length > 0, 'the warning panel is in the lock row');
  assert.equal((panel.match(/<li>/g) || []).length, 4);
  assert.match(panel, /no “forgot PIN” button/);
  const options = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  assert.match(options, /async function confirmExtensionsLock\(\)/);
  assert.match(options, /!wasOn && e\.target\.checked && !\(await confirmExtensionsLock\(\)\)/,
    'turning the lock on goes through the are-you-sure dialog');
  // Turning it off asks nothing more while a paid-for opening is running,
  // never on the free private-windows one, never during a boost.
  assert.match(options, /const paidOpen = !state\.boost && allowance && allowance\.reason !== 'private' && allowance\.until > Date\.now\(\);/);
  assert.match(options, /if \(wasOn && !e\.target\.checked && !paidOpen\)/);
});

// --- The background, driven ----------------------------------------------------

function memoryStorage(initial) {
  const store = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  };
  return {
    store,
    get: async (keys) => pick(keys),
    set: async (items) => { Object.assign(store, JSON.parse(JSON.stringify(items))); },
    remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; },
  };
}

function loadLock(initial = {}, opts = {}) {
  const clock = { now: T0 };
  const storage = memoryStorage(initial);
  const updates = [];
  const state = { tabs: opts.tabs || [], privateAllowed: !!opts.privateAllowed };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  const ctx = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.Date = FakeDate;
    vm.runInContext(LOCK_SOURCE, sandbox, { filename: 'shared/extensions-lock.js' });
    sandbox.chrome.storage.local = storage;
    // Without it background.js stops before the lock section in this harness.
    sandbox.chrome.storage.onChanged = { addListener() {} };
    sandbox.chrome.runtime.getURL = (p) => 'chrome-extension://blocknsfw/' + p;
    sandbox.chrome.tabs.update = async (id, props) => {
      updates.push({ id, url: props.url });
      const tab = state.tabs.find((t) => t.id === id);
      if (tab) tab.url = props.url; // the tab really goes there
    };
    sandbox.chrome.tabs.query = async () => state.tabs;
    sandbox.chrome.tabs.get = async (id) => state.tabs.find((t) => t.id === id) || { id };
    sandbox.chrome.extension = { isAllowedIncognitoAccess: async () => state.privateAllowed };
    sandbox.chrome.alarms = {
      create() {}, get: async () => null, clear: async () => true, onAlarm: { addListener() {} },
    };
  });
  return { ctx, storage, clock, updates, state };
}

const SETTINGS_URL = 'chrome-extension://blocknsfw/options.html?extensions-page=';

test('background: switched on, a tab arriving on the page goes to Settings while a PIN is set', async () => {
  const { ctx, updates } = loadLock({ ...ON, [L.PIN_KEY]: PIN });
  const listeners = ctx.chrome.tabs.onUpdated.listeners;
  for (const listener of listeners) listener(7, { url: 'chrome://extensions/?id=abc' }, { id: 7 });
  for (const listener of listeners) listener(8, { url: 'https://example.com/' }, { id: 8 });
  await ctx.extLockSweep(); // jobs run in order: this waits for the visits
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 7);
  assert.ok(updates[0].url.startsWith(SETTINGS_URL + encodeURIComponent('chrome://extensions/?id=abc')));
});

test('background: with the switch left off, a PIN locks nothing', async () => {
  const { ctx, updates } = loadLock({ [L.PIN_KEY]: PIN });
  await ctx.extLockVisit(7, 'chrome://extensions/');
  await ctx.extLockVisit(8, 'about:addons');
  assert.equal(updates.length, 0);
});

test('background: with nothing guarding loosening, the page opens as before', async () => {
  const { ctx, updates } = loadLock({});
  await ctx.extLockVisit(7, 'chrome://extensions/');
  assert.equal(updates.length, 0);
});

test('background: an opening lets the tab stay until it runs out', async () => {
  const { ctx, updates, clock } = loadLock({ ...ON, [L.PIN_KEY]: PIN, [L.ALLOW_KEY]: L.grant('unlock', T0) });
  await ctx.extLockVisit(7, 'chrome://extensions/');
  assert.equal(updates.length, 0);
  clock.now = T0 + 11 * MIN;
  await ctx.extLockVisit(8, 'chrome://extensions/');
  assert.equal(updates.length, 1);
});

test('background: during risk hours even an opening is refused', async () => {
  const { ctx, updates } = loadLock({
    ...ON,
    [L.ALLOW_KEY]: L.grant('unlock', T0),
    [L.BOOST_STATE_KEY]: { active: 'risk', until: T0 + 60 * MIN, snapshot: {} },
  });
  await ctx.extLockVisit(7, 'about:addons');
  assert.equal(updates.length, 1);
});

test('background: a sweep sends back a tab left open after its opening ran out', async () => {
  const { ctx, updates, clock, storage } = loadLock(
    { ...ON, [L.PIN_KEY]: PIN, [L.ALLOW_KEY]: L.grant('unlock', T0) },
    { tabs: [{ id: 3, url: 'edge://extensions/' }, { id: 4, url: 'https://example.com/' }] });
  await ctx.extLockSweep();
  assert.equal(updates.length, 0, 'still open');
  clock.now = T0 + 10 * MIN + 1;
  await ctx.extLockSweep();
  assert.deepEqual(updates.map(u => u.id), [3]);
  assert.equal(L.ALLOW_KEY in storage.store, false, 'the spent opening is cleared');
});

test('background: once private windows are on, the free opening ends and Settings says so', async () => {
  const { ctx, updates, storage } = loadLock(
    { [L.PIN_KEY]: PIN, [L.ALLOW_KEY]: L.grant('private', T0) },
    { tabs: [{ id: 5, url: 'chrome://extensions/?id=abc' }], privateAllowed: true });
  await ctx.extLockSweep();
  assert.equal(updates.length, 1);
  assert.match(updates[0].url, /&done=private#private-windows-group$/);
  assert.equal(L.ALLOW_KEY in storage.store, false);
});

test('background: a free opening stays while private windows are still off', async () => {
  const { ctx, updates, storage } = loadLock(
    { [L.PIN_KEY]: PIN, [L.ALLOW_KEY]: L.grant('private', T0) },
    { tabs: [{ id: 5, url: 'chrome://extensions/?id=abc' }], privateAllowed: false });
  await ctx.extLockSweep();
  assert.equal(updates.length, 0);
  assert.equal(storage.store[L.ALLOW_KEY].reason, 'private');
});

test('background: a pact wait that ends readies an opening', async () => {
  const { ctx, storage } = loadLock({ [L.PIN_KEY]: PIN });
  await ctx.pactApply({ kind: 'extensions-page', payload: {} });
  assert.deepEqual(storage.store[L.ALLOW_KEY], { readyUntil: T0 + 24 * 60 * MIN, reason: 'pact' });
});
