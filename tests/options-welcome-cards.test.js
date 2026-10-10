// The two cards at the top of Settings (the developer's banner, What's New)
// fold to one line when put away. What's New stays folded until the next
// version and must then open in full again; the banner opens on every visit.
//
// options-layout.js decides this from <head>, before the page is parsed, so it
// runs here against a stand-in for the few DOM pieces it touches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'options-layout.js'), 'utf8');

function element() {
  const handlers = {};
  return {
    textContent: '',
    focused: false,
    addEventListener(type, fn) { handlers[type] = fn; },
    click() { if (handlers.click) handlers.click(); },
    focus() { this.focused = true; }
  };
}

function card() {
  const parts = {
    '[data-welcome="open"]': element(),
    '[data-welcome="ack"]': element(),
    '[data-welcome="heading"]': element()
  };
  return { parts, querySelector: (sel) => parts[sel] || null };
}

// Runs options-layout.js once, as a page load would, and returns what it left.
function load({ version = '1.8.0', stored = {} } = {}) {
  const attrs = {};
  const root = {
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    removeAttribute: (n) => { delete attrs[n]; },
    hasAttribute: (n) => n in attrs
  };
  const store = Object.assign({}, stored);
  const cards = { 'release-card': card(), 'dev-message-card': card(), 'whats-new-card': card() };
  const meta = element();
  // Attributes as they stood once the <head> script had run, before any
  // listener: what the first paint sees.
  let atFirstPaint = null;
  const document = {
    documentElement: root,
    readyState: 'loading',
    addEventListener: (type, fn) => {
      atFirstPaint = Object.assign({}, attrs);
      fn();
    },
    getElementById: (id) => cards[id] || (id === 'whats-new-strip-meta' ? meta : null),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '#whats-new-card .wn-list > li' ? new Array(10).fill({}) : [])
  };
  const context = {
    document,
    window: { scrollY: 0, addEventListener() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    chrome: { runtime: { getManifest: () => ({ version }) } }
  };
  vm.runInNewContext(SOURCE, context);
  return { attrs, atFirstPaint, store, cards, meta };
}

test('a fresh install shows both cards in full', () => {
  const { atFirstPaint } = load();
  assert.ok(!('data-dev-message-read' in atFirstPaint));
  assert.ok(!('data-whats-new-read' in atFirstPaint));
});

test('What’s New put away for this version loads folded, before the first paint', () => {
  const { atFirstPaint } = load({ stored: { pblocker_whats_new_read: '1.8.0' } });
  assert.ok('data-whats-new-read' in atFirstPaint);
});

test('a new version opens What’s New again', () => {
  const { attrs } = load({ version: '1.8.1', stored: { pblocker_whats_new_read: '1.8.0' } });
  assert.ok(!('data-whats-new-read' in attrs));
});

test('"Got it" folds What’s New and remembers the version', () => {
  const { attrs, store, cards } = load();
  cards['whats-new-card'].parts['[data-welcome="ack"]'].click();
  assert.ok('data-whats-new-read' in attrs);
  assert.equal(store.pblocker_whats_new_read, '1.8.0');
  // Focus follows to the strip that replaced the button.
  assert.ok(cards['whats-new-card'].parts['[data-welcome="open"]'].focused);
});

test('the banner’s × folds it for this visit only', () => {
  const { attrs, store, cards } = load();
  cards['dev-message-card'].parts['[data-welcome="ack"]'].click();
  assert.ok('data-dev-message-read' in attrs);
  assert.deepEqual(Object.keys(store), []);
  assert.ok(cards['dev-message-card'].parts['[data-welcome="open"]'].focused);
});

test('the banner opens on every visit, whatever an earlier build stored', () => {
  const { atFirstPaint } = load({ stored: { pblocker_dev_message_read: 'warden-beta' } });
  assert.ok(!('data-dev-message-read' in atFirstPaint));
});

test('opening a folded card from its strip is for this visit only', () => {
  const { attrs, store, cards } = load({ stored: { pblocker_whats_new_read: '1.8.0' } });
  cards['whats-new-card'].parts['[data-welcome="open"]'].click();
  assert.ok(!('data-whats-new-read' in attrs));
  assert.equal(store.pblocker_whats_new_read, '1.8.0');
  assert.ok(cards['whats-new-card'].parts['[data-welcome="heading"]'].focused);
});

test('with no manifest to read, "Got it" folds the card but remembers nothing', () => {
  const { attrs, store, cards } = load({ version: '' });
  cards['whats-new-card'].parts['[data-welcome="ack"]'].click();
  assert.ok('data-whats-new-read' in attrs);
  assert.ok(!('pblocker_whats_new_read' in store));
});

test('the What’s New strip names the version and counts the changes', () => {
  assert.equal(load().meta.textContent, '1.8.0 · 10 changes');
});

test('every change in What’s New is a headline row', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const start = html.indexOf('id="whats-new-card"');
  const card = html.slice(start, html.indexOf('</section>', start)).replace(/<!--[\s\S]*?-->/g, '');
  const items = card.match(/<li>[\s\S]*?<\/li>/g) || [];
  assert.ok(items.length > 0, 'expected What’s New to list some changes');
  for (const li of items) {
    assert.match(li, /^<li><details class="wn-item"><summary>[^<]+(<span class="badge-new">New<\/span>)?<\/summary><p>[\s\S]+<\/p><\/details><\/li>$/,
      `not written as a headline row: ${li.slice(0, 80)}…`);
  }
  // The "Show N more" label is written by hand; it has to match what it hides.
  const more = card.match(/Show (\d+) more/);
  const hidden = card.slice(card.indexOf('class="wn-details"')).match(/<li>/g) || [];
  assert.ok(more, 'expected a "Show N more" toggle');
  assert.equal(Number(more[1]), hidden.length);
});

test('on 2.0.x the 2.0 band shows in full, and its × folds it for good', () => {
  const first = load({ version: '2.0.0' });
  assert.ok(!('data-release-read' in first.atFirstPaint));
  assert.ok(!('data-release-gone' in first.atFirstPaint));
  first.cards['release-card'].parts['[data-welcome="ack"]'].click();
  assert.ok('data-release-read' in first.attrs);
  assert.equal(first.store.pblocker_release_card_read, '2.0');
  assert.ok(first.cards['release-card'].parts['[data-welcome="open"]'].focused);
  const later = load({ version: '2.0.3', stored: first.store });
  assert.ok('data-release-read' in later.atFirstPaint, 'still folded on a 2.0.x patch');
});

test('the 2.0 band is gone on 1.x and from 2.1 on', () => {
  assert.ok('data-release-gone' in load({ version: '1.9.0' }).atFirstPaint);
  assert.ok('data-release-gone' in load({ version: '2.1.0' }).atFirstPaint);
  assert.ok('data-release-gone' in load({ version: '2.10.0' }).atFirstPaint);
  assert.ok(!('data-release-gone' in load({ version: '2.0.1' }).atFirstPaint));
});
