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

// ─── Warden's Product Hunt launch row ────────────────────────────────────
// 12:01 AM Pacific on 5 December 2026 (PST, UTC-8) = 08:01 UTC. The row says
// it in the reader's own time zone, "Live now" on the launch day, and goes
// once the day (midnight to midnight Pacific) is over.

const LAUNCH_UTC = Date.UTC(2026, 11, 5, 8, 1);

function loadAt(nowMs, timeZone = 'Asia/Manila') {
  const row = { hidden: false };
  const time = { textContent: 'Dec 5 · 12:01 AM PT' };
  const linkAttrs = {};
  const link = { setAttribute: (n, v) => { linkAttrs[n] = String(v); } };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const document = {
    documentElement: { getAttribute: () => null, setAttribute() {}, removeAttribute() {}, hasAttribute: () => false },
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => ({ 'warden-launch': row, 'warden-launch-time': time, 'warden-launch-link': link })[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const context = {
    document,
    Date: FakeDate,
    // The reader's zone is the browser's; pin it, in English, for the test.
    // A plain function, since the page calls it with `new`.
    Intl: { DateTimeFormat: function (_locale, opts) { return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }); } },
    window: { scrollY: 0, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    chrome: { runtime: { getManifest: () => ({ version: '2.0.5' }) } }
  };
  vm.runInNewContext(SOURCE, context);
  return { row, time, linkAttrs };
}

test('the Product Hunt row gives the launch in the reader’s own time zone', () => {
  const before = LAUNCH_UTC - 3 * 24 * 3600 * 1000;
  assert.equal(loadAt(before, 'Asia/Manila').time.textContent, 'Dec 5, 4:01 PM GMT+8');
  assert.equal(loadAt(before, 'America/Los_Angeles').time.textContent, 'Dec 5, 12:01 AM PST');
  assert.equal(loadAt(before, 'America/New_York').time.textContent, 'Dec 5, 3:01 AM EST');
  assert.equal(loadAt(before, 'Europe/London').time.textContent, 'Dec 5, 8:01 AM GMT');
  assert.equal(loadAt(before, 'Pacific/Auckland').time.textContent, 'Dec 5, 9:01 PM GMT+13');
  // West of Pacific it is still the evening before: the date moves too.
  assert.equal(loadAt(before, 'Pacific/Honolulu').time.textContent, 'Dec 4, 10:01 PM HST');
  assert.equal(loadAt(before).row.hidden, false);
  // The link's spoken name carries the context the bare time lacks.
  assert.equal(loadAt(before).linkAttrs['aria-label'], 'Warden on Product Hunt, launching Dec 5, 4:01 PM GMT+8');
});

test('on the launch day the row says Live now, and after it the row is gone', () => {
  assert.equal(loadAt(LAUNCH_UTC - 1).time.textContent, 'Dec 5, 4:01 PM GMT+8');
  assert.equal(loadAt(LAUNCH_UTC).time.textContent, 'Live now');
  assert.equal(loadAt(LAUNCH_UTC).linkAttrs['aria-label'], 'Warden on Product Hunt, live now');
  // 11:59 PM Pacific on the 5th is still the launch day.
  const lastMinute = Date.UTC(2026, 11, 6, 7, 59);
  assert.equal(loadAt(lastMinute).time.textContent, 'Live now');
  assert.equal(loadAt(lastMinute).row.hidden, false);
  // Midnight Pacific: the day is over.
  assert.equal(loadAt(Date.UTC(2026, 11, 6, 8, 0)).row.hidden, true);
});

test('the page itself carries the launch in Pacific time, for when no script runs', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  assert.match(html, /<div class="warden-spec" id="warden-launch"><dt class="meta">product hunt<\/dt>/);
  assert.match(html, /<time id="warden-launch-time" datetime="2026-12-05T08:01:00Z" title="12:01 AM Pacific Time, December 5, 2026">Dec 5 · 12:01 AM PT<\/time>/);
  // The value links to the launch page, in a new tab, with no opener or referrer.
  const link = (html.match(/<a class="warden-launch-link"[^>]*>/) || [''])[0];
  assert.match(link, /href="https:\/\/www\.producthunt\.com\/products\/warden-9\?launch=warden-12"/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="warden-launch"'), html.indexOf('</dl>', html.indexOf('id="warden-launch"'))),
    /upvote/i, 'Product Hunt forbids asking for upvotes');
  assert.equal(new Date('2026-12-05T08:01:00Z').getTime(), LAUNCH_UTC);
  assert.match(html, /\.warden-spec\[hidden\] \{\s*display: none;\s*\}/, 'a hidden row must not keep display: flex');
});
