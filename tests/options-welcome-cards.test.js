// The cards at the top of Settings (the 2.0 band, Pass It On, the developer's
// banner, What's New) fold to one line when put away. What's New stays folded
// until the next version and must then open in full again; the banner opens on
// every visit.
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
  const cards = { 'release-card': card(), 'pass-card': card(), 'dev-message-card': card(), 'whats-new-card': card() };
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

test('the Warden banner is the first row of Welcome, above the 2.0 card, Pass It On and What’s New', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const section = html.slice(html.indexOf('id="section-welcome"'), html.indexOf('id="section-protection"'));
  const order = [...section.matchAll(/<div class="welcome-card[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['dev-message-card', 'release-card', 'pass-card', 'whats-new-card']);
});

test('the Warden banner says open beta and links to the download', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const start = html.indexOf('id="dev-message-card"');
  const card = html.slice(start, html.indexOf('<div class="welcome-card', start)).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(card, /<span class="warden-strip-beta">open beta<\/span>/, 'the folded strip says it too');
  assert.match(card, /<span class="warden-tag">[\s\S]*?open beta<\/span>/);
  assert.match(card, /<dt class="meta">status<\/dt><dd>Open beta<\/dd>/);
  assert.match(card, /<a class="btn btn-primary btn-sm" href="https:\/\/monolab\.dev\/warden\/download"[^>]*>[\s\S]*?Download Warden<\/a>/);
  // The invite-only beta and its Pro cool-down dial are gone.
  assert.ok(!/Join the beta|warden#beta|data-cooldown|cool-down/i.test(card));
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

test('Pass It On shows in full from the first visit', () => {
  const { atFirstPaint } = load();
  assert.ok(!('data-pass-read' in atFirstPaint));
});

test('Pass It On’s × folds it for good', () => {
  const first = load();
  assert.ok(!('data-pass-read' in first.atFirstPaint));
  first.cards['pass-card'].parts['[data-welcome="ack"]'].click();
  assert.ok('data-pass-read' in first.attrs);
  assert.equal(first.store.pblocker_pass_it_on_read, '1');
  assert.ok(first.cards['pass-card'].parts['[data-welcome="open"]'].focused);
  const later = load({ version: '2.1.0', stored: first.store });
  assert.ok('data-pass-read' in later.atFirstPaint, 'still folded on a later version');
});

test('the 2.0 band is gone on 1.x and from 2.1 on', () => {
  assert.ok('data-release-gone' in load({ version: '1.9.0' }).atFirstPaint);
  assert.ok('data-release-gone' in load({ version: '2.1.0' }).atFirstPaint);
  assert.ok('data-release-gone' in load({ version: '2.10.0' }).atFirstPaint);
  assert.ok(!('data-release-gone' in load({ version: '2.0.1' }).atFirstPaint));
});

// ─── Warden's Product Hunt launch bar ────────────────────────────────────
// 12:01 AM Pacific on 5 December 2026 (PST, UTC-8) = 08:01 UTC. The bar keeps
// the Pacific time and adds the reader's own; on the launch day it says Warden
// is live; once the day (midnight to midnight Pacific) is over it is hidden.

const LAUNCH_UTC = Date.UTC(2026, 11, 5, 8, 1);
const TITLE = 'Support us on Product Hunt. Warden launches December 5, 2026.';

function loadAt(nowMs, timeZone = 'Asia/Manila') {
  const el = (text = '') => ({ textContent: text, hidden: false });
  const parts = {
    'warden-launch': el(),
    'warden-launch-title': el(TITLE),
    'warden-launch-pacific': el('12:01 AM Pacific'),
    'warden-launch-local': el('')
  };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const document = {
    documentElement: { getAttribute: () => null, setAttribute() {}, removeAttribute() {}, hasAttribute: () => false },
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => parts[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const context = {
    document,
    Date: FakeDate,
    Object,
    // The reader's zone is the browser's: pin it, in English. A zone the page
    // asks for itself (Pacific, to compare) is kept.
    Intl: {
      DateTimeFormat: function (_locale, opts) {
        return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: (opts && opts.timeZone) || timeZone });
      }
    },
    window: { scrollY: 0, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    chrome: { runtime: { getManifest: () => ({ version: '2.0.5' }) } }
  };
  vm.runInNewContext(SOURCE, context);
  return {
    hidden: parts['warden-launch'].hidden,
    title: parts['warden-launch-title'].textContent,
    when: parts['warden-launch-pacific'].textContent + parts['warden-launch-local'].textContent
  };
}

test('before the launch the bar gives the Pacific time and the reader’s own', () => {
  const before = LAUNCH_UTC - 3 * 24 * 3600 * 1000;
  assert.equal(loadAt(before, 'Asia/Manila').when, '12:01 AM Pacific · Dec 5, 4:01 PM your time');
  assert.equal(loadAt(before, 'Europe/London').when, '12:01 AM Pacific · Dec 5, 8:01 AM your time');
  assert.equal(loadAt(before, 'America/New_York').when, '12:01 AM Pacific · Dec 5, 3:01 AM your time');
  // West of Pacific it is still the evening before: the date moves too.
  assert.equal(loadAt(before, 'Pacific/Honolulu').when, '12:01 AM Pacific · Dec 4, 10:01 PM your time');
  // A reader on Pacific time isn't told the same time twice.
  assert.equal(loadAt(before, 'America/Los_Angeles').when, '12:01 AM Pacific');
  const shown = loadAt(before);
  assert.equal(shown.hidden, false);
  assert.equal(shown.title, TITLE);
});

test('on the launch day the bar says Warden is live, and after it the bar is gone', () => {
  assert.equal(loadAt(LAUNCH_UTC - 1).title, TITLE);
  const live = loadAt(LAUNCH_UTC);
  assert.equal(live.title, 'Warden is live on Product Hunt today. Support us there.');
  assert.equal(live.when, 'Live until 11:59 PM Pacific');
  assert.equal(live.hidden, false);
  // 11:59 PM Pacific on the 5th is still the launch day.
  assert.equal(loadAt(Date.UTC(2026, 11, 6, 7, 59)).hidden, false);
  // Midnight Pacific: the day is over.
  assert.equal(loadAt(Date.UTC(2026, 11, 6, 8, 0)).hidden, true);
});

test('the launch bar is in the Warden banner, links to the launch, and never asks for upvotes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const card = html.slice(html.indexOf('id="dev-message-card"'), html.indexOf('<div class="welcome-card', html.indexOf('id="dev-message-card"') + 10));
  const bar = card.slice(card.indexOf('<div class="warden-launch" id="warden-launch">'));
  assert.ok(card.includes('<div class="warden-launch" id="warden-launch">'), 'the bar sits inside the Warden card');
  assert.match(bar, /<svg class="ph-logo"[^>]*aria-hidden="true"/, 'Product Hunt’s logo is decoration');
  assert.match(bar, new RegExp('<p class="warden-launch-title" id="warden-launch-title">' + TITLE.replace(/\./g, '\.') + '</p>'));
  assert.match(bar, /<span id="warden-launch-pacific">12:01 AM Pacific<\/span>/, 'the page itself carries the Pacific time');
  const link = (bar.match(/<a class="[^"]*warden-launch-link[^"]*"[^>]*>/) || [''])[0];
  assert.match(link, /href="https:\/\/www\.producthunt\.com\/products\/warden-9\?launch=warden-12"/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.doesNotMatch(bar.replace(/<!--[\s\S]*?-->/g, ''), /upvote/i, 'Product Hunt forbids asking for upvotes');
  assert.match(html, /\.warden-launch\[hidden\] \{\s*display: none;\s*\}/, 'a hidden bar must not keep display: flex');
  assert.equal(new Date('2026-12-05T08:01:00Z').getTime(), LAUNCH_UTC);
});
