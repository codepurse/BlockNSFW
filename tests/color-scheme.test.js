// The theme chosen in Settings: system, light or dark.
//
// ui/scheme.js runs first on every extension page and puts the choice on
// <html> as data-scheme, from a localStorage copy, because storage answers
// only after the first paint. Storage stays the record: when it answers, the
// page follows it, and every open page follows a change made on another.
// content.js reads the same key for the UI it puts on web pages, and restyles
// what it has already drawn when the choice moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCHEME_SOURCE = fs.readFileSync(path.join(ROOT, 'ui', 'scheme.js'), 'utf8');
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const KEY = 'pblocker_color_scheme';

function fakeRoot() {
  const attrs = {};
  return {
    attrs,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value); },
    removeAttribute: (name) => { delete attrs[name]; }
  };
}

function fakeLocalStorage(initial, { broken = false } = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => { if (broken) throw new Error('blocked'); return k in data ? data[k] : null; },
    setItem: (k, v) => { if (broken) throw new Error('blocked'); data[k] = String(v); }
  };
}

// Storage that answers when the test says so, as the real one answers late.
function fakeStorage(initial) {
  const data = { ...initial };
  const listeners = [];
  const pending = [];
  return {
    data,
    listeners,
    answer: async () => {
      while (pending.length) pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    },
    storage: {
      local: {
        get: (key) => new Promise((resolve) => pending.push(() => resolve({ [key]: data[key] }))),
        set: (items) => {
          Object.assign(data, items);
          return Promise.resolve();
        }
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
}

function loadScheme({ cached, stored, brokenLocalStorage = false } = {}) {
  const root = fakeRoot();
  const local = fakeLocalStorage(cached === undefined ? {} : { [KEY]: cached }, { broken: brokenLocalStorage });
  const store = fakeStorage(stored === undefined ? {} : { [KEY]: stored });
  const sandbox = {
    document: { documentElement: root },
    localStorage: local,
    chrome: { storage: store.storage },
    Promise,
    setTimeout
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SCHEME_SOURCE, sandbox);
  return { root, local, store, UiScheme: sandbox.UiScheme };
}

test('scheme: the kept copy is on <html> before storage answers', () => {
  const { root, UiScheme } = loadScheme({ cached: 'light', stored: 'light' });
  assert.equal(root.attrs['data-scheme'], 'light');
  assert.equal(UiScheme.get(), 'light');
});

test('scheme: with nothing kept, the page follows the system and carries no attribute', async () => {
  const { root, store, UiScheme } = loadScheme();
  await store.answer();
  assert.equal('data-scheme' in root.attrs, false);
  assert.equal(UiScheme.get(), 'system');
});

test('scheme: storage is the record, so the page follows it when it answers', async () => {
  const { root, local, store } = loadScheme({ cached: 'light', stored: 'dark' });
  assert.equal(root.attrs['data-scheme'], 'light');
  await store.answer();
  assert.equal(root.attrs['data-scheme'], 'dark');
  assert.equal(local.data[KEY], 'dark', 'the copy is brought up to date for the next page');
});

test('scheme: an unknown value means the system', async () => {
  const { root, store } = loadScheme({ cached: 'sepia', stored: 'sepia' });
  assert.equal('data-scheme' in root.attrs, false);
  await store.answer();
  assert.equal('data-scheme' in root.attrs, false);
});

test('scheme: choosing one keeps it in storage and in the copy, and shows it at once', async () => {
  const { root, local, store, UiScheme } = loadScheme();
  await store.answer();
  const kept = await UiScheme.set('dark');
  assert.equal(kept, 'dark');
  assert.equal(root.attrs['data-scheme'], 'dark');
  assert.equal(store.data[KEY], 'dark');
  assert.equal(local.data[KEY], 'dark');
  await UiScheme.set('system');
  assert.equal('data-scheme' in root.attrs, false);
  assert.equal(store.data[KEY], 'system');
});

test('scheme: a change made on another page reaches this one, and its listeners', async () => {
  const { root, store, UiScheme } = loadScheme();
  await store.answer();
  const seen = [];
  UiScheme.onChange((scheme) => seen.push(scheme));
  for (const fn of store.listeners) fn({ [KEY]: { newValue: 'light' } }, 'local');
  assert.equal(root.attrs['data-scheme'], 'light');
  for (const fn of store.listeners) fn({ [KEY]: { newValue: 'light' } }, 'sync');
  for (const fn of store.listeners) fn({ other: { newValue: 1 } }, 'local');
  for (const fn of store.listeners) fn({ [KEY]: { oldValue: 'light' } }, 'local');
  assert.deepEqual(seen, ['light', 'system'], 'a removed choice falls back to the system');
});

test('scheme: without localStorage the page still follows storage', async () => {
  const { root, store } = loadScheme({ stored: 'dark', brokenLocalStorage: true });
  assert.equal('data-scheme' in root.attrs, false);
  await store.answer();
  assert.equal(root.attrs['data-scheme'], 'dark');
});

// ── content.js ─────────────────────────────────────────────────────────────

function sourceFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse ${marker}`);
}

function loadHeldUi() {
  const parts = [
    sourceFrom(CONTENT_SOURCE, 'const HELD_UI_PALETTES = ') + ';',
    // The real rules are long; one rule that reads a token is enough here.
    "const HELD_UI_RULES = { bn: 'color: var(--bn-ink);' };",
    "let heldUiCssText = '';",
    'let heldUiSheet;',
    "let heldUiScheme = 'system';",
    'const heldUiStyleRefs = [];',
    'let heldUiStyleSweepAt = 64;',
    sourceFrom(CONTENT_SOURCE, 'function heldUiCss('),
    sourceFrom(CONTENT_SOURCE, 'function rememberHeldUiStyle('),
    sourceFrom(CONTENT_SOURCE, 'function sweepHeldUiStyles('),
    sourceFrom(CONTENT_SOURCE, 'function setHeldUiScheme('),
    'this.api = { heldUiCss, rememberHeldUiStyle, setHeldUiScheme,' +
      ' setSheet: (s) => { heldUiSheet = s; }, refs: () => heldUiStyleRefs.length };'
  ];
  const sandbox = { WeakRef };
  vm.runInNewContext(parts.join('\n'), sandbox);
  return sandbox.api;
}

test('content: the placeholders follow the system until a theme is chosen', () => {
  const ui = loadHeldUi();
  const css = ui.heldUiCss();
  assert.match(css, /\.bn \{ [^}]*--bn-paper: #f4f1e9;[^}]*color-scheme: light; \}/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{ \.bn \{ [^}]*--bn-paper: #151612;/);
});

test('content: kept light, the placeholders never turn dark; kept dark, always', () => {
  const ui = loadHeldUi();
  ui.setHeldUiScheme('light');
  const light = ui.heldUiCss();
  assert.doesNotMatch(light, /prefers-color-scheme/);
  assert.doesNotMatch(light, /#151612/);
  ui.setHeldUiScheme('dark');
  const dark = ui.heldUiCss();
  assert.doesNotMatch(dark, /prefers-color-scheme/);
  assert.match(dark, /\.bn \{ [^}]*--bn-paper: #151612;[^}]*color-scheme: dark; \}/);
  ui.setHeldUiScheme('nonsense');
  assert.match(ui.heldUiCss(), /@media \(prefers-color-scheme: dark\)/);
});

test('content: placeholders already on the page change with the theme', () => {
  const ui = loadHeldUi();
  const sheet = { text: ui.heldUiCss(), replaceSync(t) { this.text = t; } };
  ui.setSheet(sheet);
  const style = { textContent: ui.heldUiCss() };
  ui.rememberHeldUiStyle(style);
  ui.setHeldUiScheme('dark');
  assert.match(sheet.text, /\.bn \{ [^}]*#151612/, 'the shared sheet is rewritten in place');
  assert.equal(style.textContent, sheet.text, 'so is each <style> fallback');
  const before = sheet.text;
  ui.setHeldUiScheme('dark');
  assert.equal(sheet.text, before, 'the same choice again does nothing');
});

test('content: the theme is read with the settings and followed when it changes', () => {
  const load = sourceFrom(CONTENT_SOURCE, 'async function loadSettings(');
  assert.match(load, /'pblocker_color_scheme'/);
  assert.match(load, /setHeldUiScheme\(result\.pblocker_color_scheme\)/);
  const listen = sourceFrom(CONTENT_SOURCE, 'function setupEventListeners(');
  assert.match(listen, /changes\.pblocker_color_scheme[\s\S]*setHeldUiScheme\(changes\.pblocker_color_scheme\.newValue\)/);
});

test('scheme.js and content.js use the same storage key', () => {
  assert.match(SCHEME_SOURCE, new RegExp(`const KEY = '${KEY}';`));
});
