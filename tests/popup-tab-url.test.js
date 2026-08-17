// Tests for resolveTabUrl in popup.js — working out which site the user means
// when the popup is opened.
//
// These exist because of issue #26: on the blocked page the active tab is the
// extension's own page, so "unblock this website" whitelisted
// moz-extension://<uuid>/blocked.html and the real site stayed blocked, with
// nothing to explain why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_ORIGIN = 'moz-extension://138859d7-c26e-44a1-9702-1591e64ddf3d';

function loadPopupContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const context = {
    chrome: {
      runtime: { getURL: (p) => `${EXT_ORIGIN}/${p}` },
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
