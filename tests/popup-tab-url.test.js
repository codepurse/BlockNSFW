// Tests for resolveTabUrl in popup.js — working out which site the user means
// when the popup is opened.
//
// These exist because of issue #26: on the blocked page the active tab is the
// extension's own page, so "unblock this website" whitelisted
// moz-extension://<uuid>/blocked.html and the real site stayed blocked, with
// nothing to explain why.
//
// Issue #44 is the same symptom again. The blocked page stopped carrying
// ?url= (the address went to session storage, to keep it out of history), so
// there was nothing to unwrap and the extension's ID was whitelisted instead.
// The popup now asks the blocked page, and anything that is not a website
// resolves to null rather than to its hostname.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_ORIGIN = 'moz-extension://138859d7-c26e-44a1-9702-1591e64ddf3d';
const EXT_ID = 'blocknsfw@test';

function loadPopupContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const context = {
    chrome: {
      runtime: {
        id: EXT_ID,
        getURL: (p) => `${EXT_ORIGIN}/${p}`,
        sendMessage: () => Promise.reject(new Error('Receiving end does not exist.')),
      },
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      tabs: { query: () => Promise.resolve([]) },
    },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    console,
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
  vm.runInContext(source, context);
  return context;
}

const ctx = loadPopupContext();
const resolve = (raw) => {
  const url = ctx.resolveTabUrl(raw);
  return url ? url.href : null;
};

test('an ordinary page is returned unchanged', () => {
  assert.equal(resolve('https://example.com/page?a=1'), 'https://example.com/page?a=1');
});

test('the blocked page resolves to the site it blocked', () => {
  // The exact shape from issue #26.
  const blocked = `${EXT_ORIGIN}/blocked.html?url=${encodeURIComponent('https://example.com/adult')}&reason=blocklist`;
  assert.equal(resolve(blocked), 'https://example.com/adult');
});

test('the hostname comes from the blocked site, not the extension', () => {
  const blocked = `${EXT_ORIGIN}/blocked.html?url=${encodeURIComponent('https://www.example.com/')}`;
  assert.equal(new URL(resolve(blocked)).hostname, 'www.example.com');
});

test('a blocked page with no url parameter is left alone', () => {
  assert.equal(resolve(`${EXT_ORIGIN}/blocked.html`), `${EXT_ORIGIN}/blocked.html`);
});

test('another extension cannot steer this', () => {
  // A different extension's page carrying url= must NOT be unwrapped, or it
  // could make the popup act on a site of its choosing.
  const other = `moz-extension://00000000-0000-0000-0000-000000000000/blocked.html?url=${encodeURIComponent('https://evil.test/')}`;
  assert.equal(resolve(other), other);
});

test('our own other pages are not unwrapped', () => {
  const options = `${EXT_ORIGIN}/options.html?url=${encodeURIComponent('https://example.com/')}`;
  assert.equal(resolve(options), options);
});

test('non-http targets are refused', () => {
  // A blocked page must never hand back something we would act on as a site.
  for (const scheme of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    const blocked = `${EXT_ORIGIN}/blocked.html?url=${encodeURIComponent(scheme)}`;
    assert.equal(resolve(blocked), blocked, `${scheme} should not be unwrapped`);
  }
});

test('a malformed target falls back to the page itself', () => {
  const blocked = `${EXT_ORIGIN}/blocked.html?url=not%20a%20url`;
  assert.equal(resolve(blocked), blocked);
});

test('a malformed tab url yields null rather than throwing', () => {
  assert.equal(ctx.resolveTabUrl('not a url'), null);
  assert.equal(ctx.resolveTabUrl(''), null);
});

test('the plain-html blocked page also resolves', () => {
  const blocked = `${EXT_ORIGIN}/blocked.html?mode=plain_html&url=${encodeURIComponent('https://example.org/x')}&reason=r`;
  assert.equal(resolve(blocked), 'https://example.org/x');
});

// --- Issue #44: the session-storage form, blocked.html?k=<key> --------------

// Replace the popup's runtime.sendMessage, recording what it was asked.
function answerWith(reply) {
  const sent = [];
  ctx.chrome.runtime.sendMessage = (message) => {
    sent.push(message);
    return typeof reply === 'function' ? reply(message) : Promise.resolve(reply);
  };
  return sent;
}

const target = async (raw) => {
  const url = await ctx.resolveTabTarget(raw);
  return url ? url.href : null;
};

test('#44: the key form asks the blocked page which site it stands for', async () => {
  const sent = answerWith({ url: 'https://9gag.com/gag/abc' });
  const blocked = `${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_1111`;

  assert.equal(await target(blocked), 'https://9gag.com/gag/abc');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'blocked_page_target');
  assert.equal(sent[0].key, 'pblocker_block_detail_1111');
});

test('#44: with no answer the blocked page is no site, never the extension ID', async () => {
  // Exactly the report: nothing to unwrap, so the popup whitelisted
  // "138859d7-…" and the site stayed blocked.
  answerWith(() => Promise.reject(new Error('Receiving end does not exist.')));
  assert.equal(await target(`${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_gone`), null);

  answerWith(null); // a listener that declined
  assert.equal(await target(`${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_gone`), null);
});

test('#44: a non-http answer is refused', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'Unknown URL', `${EXT_ORIGIN}/options.html`]) {
    answerWith({ url });
    assert.equal(await target(`${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_x`), null, url);
  }
});

test('#44: a listener that never replies does not hang the popup', async () => {
  answerWith(() => new Promise(() => {}));
  assert.equal(await target(`${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_slow`), null);
});

test('#44: another extension\'s blocked page is not asked', async () => {
  const sent = answerWith({ url: 'https://evil.test/' });
  const other = 'moz-extension://00000000-0000-0000-0000-000000000000/blocked.html?k=pblocker_block_detail_1111';
  assert.equal(await target(other), null);
  assert.equal(sent.length, 0);
});

test('#44: the url= form still resolves without asking', async () => {
  const sent = answerWith({ url: 'https://wrong.test/' });
  const blocked = `${EXT_ORIGIN}/blocked.html?url=${encodeURIComponent('https://example.com/adult')}`;
  assert.equal(await target(blocked), 'https://example.com/adult');
  assert.equal(sent.length, 0);
});

test('#44: pages that are not websites resolve to null', async () => {
  answerWith({ url: 'https://example.com/' });
  for (const raw of [
    'chrome://extensions/', // hostname "extensions" used to show the unblock row
    'about:blank',
    'file:///C:/page.html',
    `${EXT_ORIGIN}/options.html?url=${encodeURIComponent('https://example.com/')}`,
    `${EXT_ORIGIN}/blocked.html`,
    'moz-extension://00000000-0000-0000-0000-000000000000/page.html',
    'not a url',
  ]) {
    assert.equal(await target(raw), null, raw);
  }
  assert.equal(await target('https://www.chromium.org/'), 'https://www.chromium.org/');
});

test('#44: the popup names the blocked site, asking once per tab address', async () => {
  const blocked = `${EXT_ORIGIN}/blocked.html?k=pblocker_block_detail_tab`;
  ctx.chrome.tabs.query = () => Promise.resolve([{ id: 7, url: blocked }]);
  const sent = answerWith({ url: 'https://www.9gag.com/' });

  assert.equal(await ctx.getCurrentTabDomain(), '9gag.com');
  // The unblock toggle, its state and the block button all ask on each refresh.
  assert.equal(await ctx.isCurrentSiteWhitelisted(), false);
  assert.equal(await ctx.getCurrentTabDomain(), '9gag.com');
  assert.equal(sent.length, 1);
  ctx.chrome.tabs.query = () => Promise.resolve([]);
});

// --- The blocked page's side of the question ---------------------------------

const POPUP_SENDER = { id: EXT_ID, url: `${EXT_ORIGIN}/popup.html` };

function loadBlockedPage(query, records = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'blocked.js'), 'utf8');
  const session = { ...records };
  const listeners = [];
  const context = {
    chrome: {
      runtime: {
        id: EXT_ID,
        getURL: (p) => `${EXT_ORIGIN}/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
      storage: {
        local: { get: () => Promise.resolve({}) },
        session: {
          get: (key) => Promise.resolve(key in session ? { [key]: session[key] } : {}),
          remove: (key) => { delete session[key]; return Promise.resolve(); },
        },
      },
    },
    location: { href: `${EXT_ORIGIN}/blocked.html${query}` },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(listeners.length, 1, 'blocked.js should listen for the popup');
  return { listener: listeners[0], session };
}

// Resolves with the page's reply, or 'declined' when it does not take the message.
function ask(listener, message, sender) {
  return new Promise((resolve) => {
    if (listener(message, sender, resolve) !== true) resolve('declined');
  });
}

const KEY = 'pblocker_block_detail_abcd';
const RECORD = { [KEY]: { url: 'https://9gag.com/gag/abc', reason: 'default_blocklist', matched: [], score: null } };

test('#44: the blocked page answers the popup with its site, after deleting the record', async () => {
  const { listener, session } = loadBlockedPage(`?k=${KEY}`, RECORD);
  const reply = await ask(listener, { type: 'blocked_page_target', key: KEY }, POPUP_SENDER);
  assert.deepEqual({ ...reply }, { url: 'https://9gag.com/gag/abc' });
  // It answers from memory: the record still goes after one read (M3).
  assert.ok(!(KEY in session), 'the stashed record should not outlive the page load');
});

test('#44: the blocked page ignores a question about another key', async () => {
  const { listener } = loadBlockedPage(`?k=${KEY}`, RECORD);
  assert.equal(await ask(listener, { type: 'blocked_page_target', key: 'pblocker_block_detail_other' }, POPUP_SENDER), 'declined');
  assert.equal(await ask(listener, { type: 'something_else', key: KEY }, POPUP_SENDER), 'declined');
});

test('#44: only the popup is told, not content scripts or other extensions', async () => {
  const { listener } = loadBlockedPage(`?k=${KEY}`, RECORD);
  const message = { type: 'blocked_page_target', key: KEY };
  // Content scripts share the runtime bus and arrive with a tab.
  assert.equal(await ask(listener, message, { id: EXT_ID, url: 'https://some.site/', tab: { id: 3 } }), 'declined');
  assert.equal(await ask(listener, message, { id: EXT_ID, url: `${EXT_ORIGIN}/options.html`, tab: { id: 4 } }), 'declined');
  assert.equal(await ask(listener, message, { id: 'other@ext', url: 'moz-extension://0000/popup.html' }), 'declined');
  assert.equal(await ask(listener, message, undefined), 'declined');
});

test('#44: with nothing stashed the blocked page answers null, not its placeholder', async () => {
  // A reloaded blocked page: the record was consumed by the first load.
  const { listener } = loadBlockedPage(`?k=${KEY}`);
  assert.equal(await ask(listener, { type: 'blocked_page_target', key: KEY }, POPUP_SENDER), null);
});
