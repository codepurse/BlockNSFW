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
const LOOK_KEY = 'pblocker_look';

function fakeRoot() {
  const attrs = {};
  const props = {};
  return {
    attrs,
    props,
    style: {
      setProperty: (name, value) => { props[name] = value; },
      removeProperty: (name) => { delete props[name]; }
    },
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
    setItem: (k, v) => { if (broken) throw new Error('blocked'); data[k] = String(v); },
    removeItem: (k) => { if (broken) throw new Error('blocked'); delete data[k]; }
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
        // One key or several, as the real storage takes them.
        get: (keys) => new Promise((resolve) => pending.push(() => resolve(Object.fromEntries(
          [].concat(keys).map((k) => [k, data[k]])
        )))),
        set: (items) => {
          Object.assign(data, items);
          return Promise.resolve();
        },
        remove: (key) => {
          delete data[key];
          return Promise.resolve();
        }
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
}

function loadScheme({ cached, stored, brokenLocalStorage = false, cachedLook, storedLook, systemDark = false } = {}) {
  const root = fakeRoot();
  const kept = cached === undefined ? {} : { [KEY]: cached };
  if (cachedLook !== undefined) kept[LOOK_KEY] = JSON.stringify(cachedLook);
  const local = fakeLocalStorage(kept, { broken: brokenLocalStorage });
  const record = stored === undefined ? {} : { [KEY]: stored };
  if (storedLook !== undefined) record[LOOK_KEY] = storedLook;
  const store = fakeStorage(record);
  const media = { matches: systemDark, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const sandbox = {
    document: { documentElement: root },
    localStorage: local,
    chrome: { storage: store.storage },
    matchMedia: () => media,
    Promise,
    setTimeout,
    JSON
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SCHEME_SOURCE, sandbox);
  return { root, local, store, media, UiScheme: sandbox.UiScheme };
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

// ── A Supporter look ───────────────────────────────────────────────────────
//
// The looks themselves are a Supporter extra (extras/looks.js); scheme.js
// only lays what is kept over the tokens, light or dark as the page is.

const LOOK = {
  choice: { accent: 'ink', black: true },
  light: { '--color-pine': '#224466' },
  dark: { '--color-pine': '#88aacc', '--color-paper': '#000000' }
};

test('look: the kept copy is painted before storage answers, the light set in light', () => {
  const { root } = loadScheme({ cached: 'light', cachedLook: LOOK });
  assert.deepEqual({ ...root.props }, { '--color-pine': '#224466' });
});

test('look: dark gets the dark set, and following the system follows it', () => {
  const { root } = loadScheme({ cached: 'dark', cachedLook: LOOK });
  assert.deepEqual({ ...root.props }, { '--color-pine': '#88aacc', '--color-paper': '#000000' });
  const sys = loadScheme({ cachedLook: LOOK, systemDark: false });
  assert.equal(sys.root.props['--color-pine'], '#224466');
  sys.media.matches = true;
  sys.media.listeners.forEach((fn) => fn());
  assert.equal(sys.root.props['--color-paper'], '#000000', 'the system turning dark repaints it');
});

test('look: switching the scheme repaints, leaving nothing of the other set behind', async () => {
  const { root, store, UiScheme } = loadScheme({ cached: 'dark', cachedLook: LOOK, stored: 'dark', storedLook: LOOK });
  await store.answer();
  await UiScheme.set('light');
  assert.deepEqual({ ...root.props }, { '--color-pine': '#224466' });
});

test('look: kept in storage and the copy, and the plain look clears both', async () => {
  const { root, local, store, UiScheme } = loadScheme({ cached: 'light' });
  await store.answer();
  await UiScheme.setLook(LOOK);
  assert.equal(store.data[LOOK_KEY].choice.accent, 'ink');
  assert.ok(local.data[LOOK_KEY].includes('#224466'));
  assert.equal(root.props['--color-pine'], '#224466');
  await UiScheme.setLook(null);
  assert.ok(!(LOOK_KEY in store.data));
  assert.ok(!(LOOK_KEY in local.data));
  assert.deepEqual({ ...root.props }, {});
  assert.equal(UiScheme.getLook(), null);
});

test('look: only colour tokens with plain colour values are ever set', () => {
  const look = {
    choice: { accent: 'Ink<script>', black: 'yes' },
    light: {
      '--color-pine': 'red',
      '--color-ink': 'url(javascript:alert(1))',
      '--space-4': '#ffffff',
      color: '#ffffff',
      '--color-band': '#123456',
      '--color-rule': 'rgba(26, 26, 22, 0.15)',
      '--color-paper': '#12345; background: url(x)'
    }
  };
  const { root, UiScheme } = loadScheme({ cached: 'light', cachedLook: look });
  assert.deepEqual({ ...root.props }, { '--color-band': '#123456', '--color-rule': 'rgba(26, 26, 22, 0.15)' });
  assert.deepEqual({ ...UiScheme.getLook().choice }, {}, 'nor a choice that is not one');
  assert.equal(UiScheme.normalizeLook({ light: { '--color-pine': 'blue' } }), null, 'nothing valid: the plain look');
});

test('look: a change made on another page reaches this one', async () => {
  const { root, store } = loadScheme({ cached: 'light' });
  await store.answer();
  for (const fn of store.listeners) fn({ [LOOK_KEY]: { newValue: LOOK } }, 'local');
  assert.equal(root.props['--color-pine'], '#224466');
  for (const fn of store.listeners) fn({ [LOOK_KEY]: { oldValue: LOOK } }, 'local');
  assert.deepEqual({ ...root.props }, {}, 'removed: the plain look');
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
