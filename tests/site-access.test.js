// When BlockNSFW's site access is switched off (shared/site-access.js,
// background.js "Site access").
//
// Found 2026-11-09 in Edge 157: setting the extension's site access to "When
// you click the extension" from the toolbar menu let a page on a listed site
// open and a listed image load, because the content script stops running and
// the static rules need site access. The background still sees tab addresses,
// so it holds every page while protection is locked, and blocks listed sites
// otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadBackgroundContext } = require('./setup');
const SA = require('../shared/site-access.js');
const L = require('../shared/extensions-lock.js');

const ROOT = path.join(__dirname, '..');
const LOCK_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'extensions-lock.js'), 'utf8');
const SA_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'site-access.js'), 'utf8');
const PIN = { v: 1, salt: 'aa', hash: 'bb' };

test('nothing to do while access is there or protection is off', () => {
  assert.equal(SA.mode({ granted: true, enabled: true, locked: true }), 'off');
  assert.equal(SA.mode({ enabled: true, locked: true }), 'off', 'unknown counts as there');
  assert.equal(SA.mode({ granted: false, enabled: false, locked: true }), 'off');
});

test('without access: hold every page when locked, block listed sites otherwise', () => {
  assert.equal(SA.mode({ granted: false, enabled: true, locked: true }), 'hold');
  assert.equal(SA.mode({ granted: false, enabled: true, locked: false }), 'net');
});

test('locked means a PIN, a pact, the access code, or a boost, not the extensions-page switch', () => {
  assert.equal(SA.locked(L.lockState({ [L.PIN_KEY]: PIN })), true);
  assert.equal(SA.locked(L.lockState({ [L.PACT_KEY]: { active: true } })), true);
  assert.equal(SA.locked(L.lockState({ [L.BOOST_STATE_KEY]: { active: 'storm', until: 1 } })), true);
  assert.equal(SA.locked(L.lockState({ [L.PIN_KEY]: PIN, [L.SETTINGS_KEY]: { lockExtensionsPage: false } })), true);
  assert.equal(SA.locked(L.lockState({})), false);
});

// Safari 17 stores "Always allow on every website" as *://*/* and answers
// false for <all_urls> (measured 2026-11). Chrome and Firefox answer for the
// pattern the page needs; a withheld grant answers false for both.
function permissionsStub(granted) {
  return {
    contains: async (p) => {
      assert.equal(p.origins.length, 1);
      assert.ok(['<all_urls>', '*://*/*'].includes(p.origins[0]), p.origins[0]);
      return granted.includes(p.origins[0]);
    },
  };
}

test('Safari: all sites granted as *://*/* counts as access', async () => {
  assert.equal(await SA.contains(permissionsStub(['*://*/*'])), true);
  assert.equal(await SA.contains(permissionsStub(['*://*/*', 'https://*/*'])), true);
});

test('Chrome and Firefox: <all_urls> still counts as access', async () => {
  assert.equal(await SA.contains(permissionsStub(['<all_urls>'])), true);
});

test('withheld access, with neither pattern granted, is no access', async () => {
  assert.equal(await SA.contains(permissionsStub([])), false);
  assert.equal(await SA.contains(permissionsStub(['https://*/*'])), false, 'a single-scheme grant is not all of the web');
});

test('asks the browser for all sites, and trusts a browser that cannot say', async () => {
  assert.equal(await SA.contains(undefined), true);
  assert.equal(await SA.contains({ contains: async (p) => { assert.ok(p.origins.length === 1); return false; } }), false);
  assert.equal(await SA.contains({ contains: async () => { throw new Error('x'); } }), true);
  assert.equal(await SA.request({ request: async () => true }), true);
  assert.equal(await SA.request({ request: () => { throw new Error('no gesture'); } }), false);
});

test('a held page keeps its address out of the URL when it can', () => {
  const key = SA.newHoldKey();
  assert.equal(SA.isHoldKey(key), true);
  assert.equal(SA.holdPath(key, 'https://example.com/a'), 'access.html?k=' + encodeURIComponent(key));
  assert.equal(SA.holdPath(null, 'https://example.com/a'), 'access.html?to=' + encodeURIComponent('https://example.com/a'));
  assert.equal(SA.isHoldKey('pblocker_access_hold_'), false);
  assert.equal(SA.isHoldKey('pblocker_pin'), false);
  assert.equal(SA.isHoldKey('pblocker_access_hold_x"><script>'), false);
  assert.equal(SA.isWebUrl('https://a.example/'), true);
  assert.equal(SA.isWebUrl('chrome-extension://x/options.html'), false);
  assert.equal(SA.isWebUrl('javascript:alert(1)'), false);
});

test('says what is lost, and differently when locked', () => {
  assert.match(SA.describe(false, false), /Listed sites are still blocked/);
  assert.match(SA.describe(true, false), /Pages wait/);
  assert.match(SA.describe(true, true), /toolbar’s extensions menu/);
});

test('the pages that show it load it, and both builds ship the hold page', () => {
  for (const page of ['options.html', 'popup.html', 'access.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /<script src="shared\/site-access\.js"><\/script>/, page);
  }
  for (const page of ['options.html', 'popup.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, page), 'utf8'), /id="access-banner"/, page);
  }
  for (const build of ['build-chrome.ps1', 'build-firefox.ps1']) {
    const source = fs.readFileSync(path.join(ROOT, build), 'utf8');
    assert.match(source, /"access\.html"/, build);
    assert.match(source, /"access\.js"/, build);
  }
  const firefox = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.firefox.json'), 'utf8'));
  assert.ok(firefox.background.scripts.includes('shared/site-access.js'));
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

function loadSite(initial = {}, opts = {}) {
  const local = memoryStorage(initial);
  const session = memoryStorage({});
  const updates = [];
  const state = { granted: opts.granted === true, tabs: opts.tabs || [] };
  let uuid = 0;
  const ctx = loadBackgroundContext(undefined, (sandbox) => {
    vm.runInContext(LOCK_SOURCE, sandbox, { filename: 'shared/extensions-lock.js' });
    vm.runInContext(SA_SOURCE, sandbox, { filename: 'shared/site-access.js' });
    sandbox.crypto = { randomUUID: () => `uuid-${++uuid}` };
    sandbox.chrome.storage.local = local;
    sandbox.chrome.storage.session = session;
    // Without it background.js stops before these sections in this harness.
    sandbox.chrome.storage.onChanged = { addListener() {} };
    sandbox.chrome.runtime.getURL = (p) => 'chrome-extension://blocknsfw/' + p;
    sandbox.chrome.permissions = {
      contains: async () => state.granted,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    };
    sandbox.chrome.tabs.update = async (id, props) => { updates.push({ id, url: props.url }); };
    sandbox.chrome.tabs.get = async (id) => ({ id });
    sandbox.chrome.tabs.query = async () => state.tabs;
    sandbox.chrome.alarms = {
      create() {}, get: async () => null, clear: async () => true, onAlarm: { addListener() {} },
    };
  });
  return { ctx, local, session, updates, state };
}

test('background: locked and without access, a page waits on access.html', async () => {
  const { ctx, updates, session } = loadSite({ [L.PIN_KEY]: PIN });
  await ctx.siteAccessVisit(5, 'https://example.com/news');
  assert.equal(updates.length, 1);
  assert.match(updates[0].url, /^chrome-extension:\/\/blocknsfw\/access\.html\?k=pblocker_access_hold_uuid-\d+$/);
  const key = decodeURIComponent(updates[0].url.split('?k=')[1]);
  assert.equal(session.store[key].url, 'https://example.com/news', 'the address waits in session storage');
  assert.ok(!updates[0].url.includes('example.com'), 'and never in the address bar');
});

test('background: not locked, a listed site still goes to the blocked page', async () => {
  const { ctx, updates, session } = loadSite({});
  ctx.shouldBlock = async (url) => url.includes('listed.example');
  await ctx.siteAccessVisit(5, 'https://ordinary.example/');
  assert.equal(updates.length, 0, 'an ordinary page opens');
  await ctx.siteAccessVisit(6, 'https://listed.example/');
  assert.equal(updates.length, 1);
  assert.match(updates[0].url, /^chrome-extension:\/\/blocknsfw\/blocked\.html\?k=pblocker_block_detail_/);
  const key = decodeURIComponent(updates[0].url.split('?k=')[1]);
  assert.equal(session.store[key].url, 'https://listed.example/');
  assert.equal(typeof session.store[key].reason, 'string');
});

test('background: with access, or with protection off, nothing changes', async () => {
  const granted = loadSite({ [L.PIN_KEY]: PIN }, { granted: true });
  await granted.ctx.siteAccessVisit(5, 'https://example.com/');
  assert.equal(granted.updates.length, 0);
  const off = loadSite({ [L.PIN_KEY]: PIN, [L.SETTINGS_KEY]: { enabled: false } });
  await off.ctx.siteAccessVisit(5, 'https://example.com/');
  assert.equal(off.updates.length, 0);
});

test('background: one navigation is sent once, however many updates it fires', async () => {
  const { ctx, updates } = loadSite({ [L.PIN_KEY]: PIN });
  await Promise.all([
    ctx.siteAccessVisit(5, 'https://example.com/'),
    ctx.siteAccessVisit(5, 'https://example.com/'),
  ]);
  await ctx.siteAccessVisit(5, 'https://example.com/');
  assert.equal(updates.length, 1);
});

test('background: when access goes, every open page is judged', async () => {
  const { ctx, updates } = loadSite({ [L.PIN_KEY]: PIN }, {
    tabs: [
      { id: 1, url: 'https://a.example/' },
      { id: 2, url: 'chrome-extension://blocknsfw/options.html' },
      { id: 3, url: 'https://b.example/' },
    ],
  });
  await ctx.siteAccessSweep();
  assert.deepEqual(updates.map(u => u.id), [1, 3]);
});
