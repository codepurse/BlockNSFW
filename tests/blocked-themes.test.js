// Blocked page designs (blocked-themes.js) and how blocked.js chooses one.
//
// The registry feeds two pages: blocked.html renders the chosen design, and
// options.html builds its picker from the same list. These tests hold the
// registry's shape, the wording rules for the one screen a user sees at their
// worst moment, and the choice itself: the saved design, the settings page's
// preview, and a custom page still winning over any design.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const THEMES_SRC = fs.readFileSync(path.join(ROOT, 'blocked-themes.js'), 'utf8');
const BLOCKED_SRC = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');

// --- a small fake DOM --------------------------------------------------------

class FakeClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(' '); }
  add(...names) { const s = this._set(); names.forEach((n) => s.add(n)); this._write(s); }
  remove(...names) { const s = this._set(); names.forEach((n) => s.delete(n)); this._write(s); }
  toggle(name, force) {
    const s = this._set();
    const on = force === undefined ? !s.has(name) : !!force;
    if (on) s.add(name); else s.delete(name);
    this._write(s);
    return on;
  }
  contains(name) { return this._set().has(name); }
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.open = true;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList(this);
    const props = {};
    this.style = { props, setProperty(k, v) { props[k] = v; } };
    this.parentNode = { insertBefore() {}, appendChild() {}, removeChild() {} };
    this.nextSibling = null;
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChild(next, prev) {
    const i = this.children.indexOf(prev);
    if (i >= 0) this.children[i] = next;
    return prev;
  }
  insertBefore(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  // SVG elements take their class as an attribute.
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
  // Every descendant, depth first.
  all() { return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : [])); }
  find(className) { return this.all().find((c) => c.classList.contains(className)) || null; }
  text() {
    return this.children.length
      ? this.children.map((c) => (c instanceof FakeEl ? c.text() : c.textContent)).join('')
      : this.textContent;
  }
}

function fakeDocument() {
  const byId = new Map();
  const documentElement = new FakeEl('html');
  documentElement.className = 'theme-pending';
  return {
    documentElement,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeEl());
      return byId.get(id);
    },
    querySelector: () => new FakeEl(),
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (ns, tag) => new FakeEl(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    open() {}, write() {}, close() {}
  };
}

// Timers are recorded, never run: the breathing loop and the held-on timer
// repeat forever and would keep the test process alive.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    setInterval: (fn, ms) => { pending.push({ fn, ms, repeat: true }); return pending.length; },
    clearTimeout() {}, clearInterval() {}
  };
}

const flush = () => new Promise((done) => setImmediate(done));

function loadThemes() {
  const timers = fakeTimers();
  const sandbox = { console, Math, Date, Promise, String, ...timers };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(THEMES_SRC, sandbox);
  return { themes: sandbox.BlockedThemes, timers };
}

// Run blocked-themes.js, then blocked.js, against a fake page.
function openBlockedPage({ query = '', settings = null, streakStart = null, reducedMotion = true } = {}) {
  const doc = fakeDocument();
  const timers = fakeTimers();
  const store = { pblocker_settings: settings, pblocker_streak_start: streakStart };
  const sandbox = {
    console, URL, URLSearchParams, Promise, Math, Date, String, ...timers,
    location: { href: `chrome-extension://abc/blocked.html${query}`, replace() {} },
    history: { length: 1, back() {} },
    window: { open() {} },
    matchMedia: () => ({ matches: reducedMotion }),
    document: doc,
    browser: undefined,
    chrome: {
      runtime: { id: 'abc', getURL: (p) => p, onMessage: { addListener() {} } },
      storage: { local: { get: (key) => Promise.resolve({ [key]: store[key] }) } }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(THEMES_SRC, sandbox);
  vm.runInContext(BLOCKED_SRC, sandbox);
  return { doc, timers };
}

// --- the registry ------------------------------------------------------------

test('registry: Classic first and the default, then the three designs', () => {
  const { themes } = loadThemes();
  assert.equal(themes.DEFAULT_ID, 'classic');
  // Array.from: the list comes from the vm realm, and deepStrictEqual compares
  // prototypes, which differ between realms.
  assert.deepEqual(Array.from(themes.list, (t) => t.id), ['classic', 'calm', 'verse', 'motivation']);
});

test('registry: every design has a name, a blurb, and a renderer', () => {
  const { themes } = loadThemes();
  const ids = new Set();
  for (const theme of themes.list) {
    assert.ok(!ids.has(theme.id), `duplicate id ${theme.id}`);
    ids.add(theme.id);
    assert.ok(theme.name && theme.blurb, `${theme.id} needs a name and a blurb for the picker`);
    if (theme.id !== 'classic') {
      assert.equal(typeof theme.render, 'function', `${theme.id} has no renderer`);
    }
  }
});

test('registry: unknown or missing ids fall back to Classic', () => {
  const { themes } = loadThemes();
  for (const bad of [undefined, null, '', 'CALM', 'nope', '<img src=x>']) {
    assert.equal(themes.normalize(bad), 'classic');
  }
  assert.equal(themes.normalize('verse'), 'verse');
});

test('verses: each has a reference and text, with no repeats', () => {
  const { themes } = loadThemes();
  assert.ok(themes.VERSES.length >= 12);
  const refs = new Set();
  for (const verse of themes.VERSES) {
    assert.match(verse.ref, /^[1-3]?\s?[A-Z][a-z]+ \d+:\d+(–\d+)?$/, `odd reference: ${verse.ref}`);
    assert.ok(verse.text.length > 20);
    assert.ok(!refs.has(verse.ref), `repeated verse ${verse.ref}`);
    refs.add(verse.ref);
  }
});

test('calm: five breaths, in for 4 seconds and out for 6', () => {
  const { themes } = loadThemes();
  assert.equal(themes.ENSO_BREATHS, 5);
  assert.equal(themes.ENSO_IN_SECONDS, 4);
  assert.equal(themes.ENSO_OUT_SECONDS, 6);
});

test('wording: nothing shames, and the streak is never called clean or sober', () => {
  const { themes } = loadThemes();
  const words = [
    ...themes.MOTIVATION_ACTIONS,
    ...Array.from(themes.list, (t) => t.blurb)
  ].join(' ').toLowerCase();
  for (const word of ['clean', 'sober', 'relapse', 'failure', 'disgust', 'shame', 'porn']) {
    assert.ok(!words.includes(word), `"${word}" does not belong on this page`);
  }
});

// --- rendering ---------------------------------------------------------------

function renderInto(id, extra = {}) {
  const { themes, timers } = loadThemes();
  const doc = fakeDocument();
  const hero = new FakeEl('section');
  themes.get(id).render({ doc, hero, reducedMotion: true, ...extra });
  return { themes, hero, timers };
}

test('every design opens by saying what happened', () => {
  for (const id of ['calm', 'verse', 'motivation']) {
    const { hero } = renderInto(id);
    const first = hero.all().find((c) => c.textContent);
    assert.ok(first.classList.contains('theme-context'), `${id}: the first words on the page`);
    assert.match(first.textContent, /^BlockNSFW blocked this page\./, id);
  }
});

// Handlers are run with a stand-in event: a left-button press by default.
const fire = (node, type, event = {}) =>
  (node.listeners[type] || []).forEach((fn) => fn({ button: 0, pointerId: 1, key: '', preventDefault() {}, ...event }));
const strokesOf = (stage) => stage.all().filter((c) => c.classList.contains('enso-stroke'));
const runLast = (timers, ms) => timers.pending.filter((t) => t.ms === ms).pop().fn();

test('calm: an ensō on washi, a guide where the brush will go, and the circle as the button', () => {
  const { hero } = renderInto('calm');
  const stage = hero.find('enso-stage');
  assert.equal(stage.dataset.phase, 'idle');
  const ring = stage.find('enso');
  assert.equal(ring.attributes.viewBox, '0 0 520 520');
  assert.ok(ring.find('enso-path'), 'a faint guide');
  assert.equal(strokesOf(stage).length, 5, 'a body, two edges and two bristles');
  assert.ok(ring.find('enso-dry').children.length > 0, 'the dry brush is laid over the tail');
  assert.equal(stage.find('enso-hold').tagName, 'BUTTON');
  assert.ok(hero.find('enso-paper'), 'washi behind the page');
  assert.equal(hero.find('enso-phase').textContent, 'Press and hold to breathe in');
  assert.equal(hero.find('enso-count').textContent, '0 of 5 breaths');
  assert.equal(hero.all().filter((c) => c.classList.contains('enso-slot')).length, 5);
});

test('calm: holding draws the in-breath; letting go closes the circle and counts it', () => {
  const { hero, timers } = renderInto('calm');
  const stage = hero.find('enso-stage');
  const hold = stage.find('enso-hold');
  const body = strokesOf(stage)[1];
  const hidden = parseFloat(body.style.props['stroke-dashoffset']);

  fire(hold, 'pointerdown');
  assert.equal(stage.dataset.phase, 'in');
  assert.equal(hero.find('enso-phase').textContent, 'Breathe in');
  const half = parseFloat(body.style.props['stroke-dashoffset']);
  assert.ok(half > 1 && half < hidden, 'part of the way round on the in-breath');
  runLast(timers, 4000);
  assert.equal(hero.find('enso-phase').textContent, 'Hold, then let go');

  fire(hold, 'pointerup');
  assert.equal(stage.dataset.phase, 'out');
  assert.equal(hero.find('enso-phase').textContent, 'Breathe out');
  assert.equal(parseFloat(body.style.props['stroke-dashoffset']), 1, 'closed on the out-breath');

  runLast(timers, 6000);
  assert.equal(hero.find('enso-count').textContent, '1 of 5 breaths');
  assert.ok(hero.find('enso-slot').classList.contains('is-drawn'), 'the breath joins the tally');
  assert.equal(stage.dataset.phase, 'rest');
  runLast(timers, 900);
  assert.equal(stage.dataset.phase, 'idle');
  assert.equal(hero.find('enso-phase').textContent, 'Again, when you are ready');
});

test('calm: the space bar works the brush as a held press does', () => {
  const { hero } = renderInto('calm');
  const stage = hero.find('enso-stage');
  const hold = stage.find('enso-hold');
  fire(hold, 'keydown', { key: ' ' });
  assert.equal(stage.dataset.phase, 'in');
  fire(hold, 'keydown', { key: ' ', repeat: true });
  assert.equal(stage.dataset.phase, 'in', 'a held key does not start over');
  fire(hold, 'keyup', { key: ' ' });
  assert.equal(stage.dataset.phase, 'out');
});

test('calm: no two circles are drawn alike', () => {
  const { hero, timers } = renderInto('calm');
  const stage = hero.find('enso-stage');
  const hold = stage.find('enso-hold');
  for (let i = 0; i < 2; i++) {
    fire(hold, 'pointerdown');
    fire(hold, 'pointerup');
    runLast(timers, 6000);
    runLast(timers, 900);
  }
  const [first, second] = hero.all().filter((c) => c.classList.contains('enso-slot'));
  const turn = (slot) => slot.children[1].attributes.transform;
  assert.ok(turn(first) && turn(second));
  assert.notEqual(turn(first), turn(second));
});

test('calm: five breaths end with the seal, and Begin again clears the paper', () => {
  const { hero, timers } = renderInto('calm', { reducedMotion: false });
  const stage = hero.find('enso-stage');
  const hold = stage.find('enso-hold');
  assert.equal(stage.classList.contains('is-still'), false);
  for (let i = 0; i < 5; i++) {
    fire(hold, 'pointerdown');
    fire(hold, 'pointerup');
    runLast(timers, 6000);
    if (i < 4) runLast(timers, 900);
  }
  assert.equal(stage.dataset.phase, 'done');
  assert.equal(hero.find('enso-phase').textContent, 'Five breaths.');
  assert.equal(hero.find('enso-done').hidden, false);
  assert.ok(stage.find('enso-seal'));
  assert.equal(hero.find('enso-count').textContent, '5 of 5 breaths');
  fire(hold, 'pointerdown');
  assert.equal(stage.dataset.phase, 'done', 'the brush rests after the fifth');

  hero.find('enso-again').click();
  assert.equal(stage.dataset.phase, 'idle');
  assert.equal(hero.find('enso-done').hidden, true);
  assert.equal(hero.all().filter((c) => c.classList.contains('is-drawn')).length, 0);
  assert.equal(hero.find('enso-count').textContent, '0 of 5 breaths');
});

test('calm: with reduced motion the seal is set down without the stamp', () => {
  const { hero } = renderInto('calm', { reducedMotion: true });
  assert.equal(hero.find('enso-stage').classList.contains('is-still'), true);
});

test('verse: the verse whole and its reference, before a concrete wall with a cross of light', () => {
  const { themes, hero } = renderInto('verse');
  const ref = hero.find('light-ref-name');
  const verse = Array.from(themes.VERSES).find((v) => v.ref === ref.textContent);
  assert.ok(verse, 'the reference names one of the verses');
  assert.equal(hero.find('light-verse').textContent, verse.text, 'the verse is shown whole, unquoted');
  assert.equal(hero.find('light-ref-translation').textContent, 'King James Version');

  const wall = hero.find('light-wall');
  assert.equal(wall.attributes['aria-hidden'], 'true', 'the wall is scenery');
  assert.ok(wall.find('light-formwork'));
  assert.ok(wall.find('light-upright') && wall.find('light-arm'), 'an upright and an arm');
});

test('verse: "Read another verse" changes it', () => {
  const { hero } = renderInto('verse');
  const ref = hero.find('light-ref-name');
  const before = ref.textContent;
  hero.find('light-another').click();
  assert.notEqual(ref.textContent, before);
});

test('verse: with no layout to measure, the cross is never placed', () => {
  const { hero } = renderInto('verse');
  assert.equal(hero.find('light-upright').style.left, undefined);
  assert.equal(hero.find('light-arm').style.top, undefined);
});

test('verse: the formwork panels keep in scale with the page', () => {
  const { themes } = loadThemes();
  assert.equal(themes.panelWidth(1280), 240);
  assert.equal(themes.panelWidth(390), 112);
  assert.equal(themes.panelWidth(3840), 300);
  for (let w = 320; w <= 3840; w += 37) {
    assert.equal(themes.panelWidth(w) % 2, 0, `${w}: even, so a row lands on whole pixels`);
  }
});

// The cross must land on the formwork's joints wherever it goes.
function assertOnJoints(at, label) {
  assert.equal((at.x - at.x0) % at.panel, 0, `${label}: the upright runs along a joint`);
  assert.equal((at.y - at.y0) % (at.panel / 2), 0, `${label}: the arm runs along a joint`);
}

test('verse: on a wide page the cross stands right of the column, its arm between the first line and the verse', () => {
  const { themes } = loadThemes();
  for (const pageWidth of [720, 768, 1024, 1280, 1366, 1440, 1920, 2560, 3440, 3840]) {
    // The column as blocked-themes.css sets it at this width.
    const size = Math.min(41.6, Math.max(20.8, 13.6 + pageWidth * 0.0135));
    const pad = Math.min(160, Math.max(24, pageWidth * 0.08));
    const gap = Math.min(180, Math.max(48, pageWidth * 0.09));
    const left = Math.max(pad, pageWidth * 0.6 - gap - size * 21);
    const right = left + Math.min(size * 21, pageWidth - 2 * pad);
    const at = themes.lightLayout({
      pageWidth, wide: true, lineBottom: 160, verseTop: 250, columnRight: right, wordsEnd: left + 200
    });
    assert.ok(at.x - at.slit / 2 >= right + 48, `${pageWidth}: clear of the column`);
    assert.ok(at.x + at.slit / 2 <= pageWidth - at.slit, `${pageWidth}: wall on both sides`);
    assert.ok(at.y - at.slit / 2 > 160 && at.y + at.slit / 2 < 250, `${pageWidth}: arm between the lines`);
    assert.equal(at.uprightBottom, null, `${pageWidth}: the upright runs the height of the page`);
    assertOnJoints(at, pageWidth);
  }
});

test('verse: on a narrow page the cross is cut above the verse, clear of the first line', () => {
  const { themes } = loadThemes();
  for (const pageWidth of [320, 360, 375, 390, 414, 600, 719]) {
    const wordsEnd = 24 + 190;
    const lineBottom = 72;
    const verseTop = 300;
    const at = themes.lightLayout({
      pageWidth, wide: false, lineBottom, verseTop, columnRight: pageWidth - 24, wordsEnd
    });
    assert.ok(at.x - at.slit / 2 >= wordsEnd + 24, `${pageWidth}: clear of the first line's words`);
    assert.ok(at.x + at.slit / 2 <= pageWidth - 24, `${pageWidth}: inside the page`);
    assert.ok(at.y - at.slit / 2 > lineBottom, `${pageWidth}: the arm under the first line`);
    assert.ok(at.uprightBottom <= verseTop - 28, `${pageWidth}: the upright stops short of the verse`);
    assert.ok(at.y + at.slit / 2 < at.uprightBottom, `${pageWidth}: the arm crosses the upright`);
    assertOnJoints(at, pageWidth);
  }
});

async function chainView(days) {
  const { hero } = renderInto('motivation', { loadStreakDays: () => days });
  await flush();
  const cells = hero.all().filter((c) => c.classList.contains('chain-day'));
  return {
    hero,
    cells,
    count: hero.find('chain-count').textContent,
    unit: hero.find('chain-unit').textContent,
    next: hero.find('chain-next').textContent,
    kept: cells.filter((c) => c.classList.contains('is-kept')).length,
    todayIndex: cells.findIndex((c) => c.classList.contains('is-today'))
  };
}

test('motivation: five weeks of calendar, the days of protection crossed and today left open', async () => {
  const view = await chainView(12);
  assert.equal(view.cells.length, 35);
  assert.ok(view.todayIndex >= 28, 'today is in the last row');
  assert.equal(view.kept, 12);
  for (let i = view.todayIndex - 12; i < view.todayIndex; i++) {
    assert.ok(view.cells[i].classList.contains('is-kept'), 'the crossed days run up to today');
    assert.ok(view.cells[i].find('chain-cross'));
  }
  assert.ok(view.cells[view.todayIndex].find('chain-mark'), 'today holds the button to mark it');
  assert.ok(view.cells.slice(view.todayIndex + 1).every((c) => c.classList.contains('is-ahead')));
});

test('motivation: the streak is days of protection in a row', async () => {
  const twelve = await chainView(12);
  assert.equal(twelve.count, '12');
  assert.equal(twelve.unit, 'days of protection in a row');
  assert.equal((await chainView(1)).unit, 'day of protection in a row');
});

test('motivation: the next milestone, counted down', async () => {
  assert.equal((await chainView(3)).next, '4 more to 7 days.');
  assert.equal((await chainView(12)).next, '18 more to 30 days.');
  assert.equal((await chainView(45)).next, '45 more to 90 days.');
  assert.match((await chainView(95)).next, /^95 days and counting/);
});

test('motivation: a streak longer than the calendar crosses every day before today', async () => {
  const view = await chainView(200);
  assert.equal(view.kept, view.todayIndex);
});

test('motivation: marking today draws its X and counts it, and can be undone', async () => {
  const view = await chainView(12);
  const mark = view.hero.find('chain-mark');
  assert.equal(mark.attributes['aria-pressed'], 'false');
  mark.click();
  assert.ok(mark.classList.contains('is-marked'));
  assert.equal(mark.attributes['aria-pressed'], 'true');
  assert.equal(view.hero.find('chain-count').textContent, '13');
  assert.match(view.hero.find('chain-status').textContent, /^Marked\./);
  mark.click();
  assert.equal(mark.classList.contains('is-marked'), false);
  assert.equal(view.hero.find('chain-count').textContent, '12');
  assert.match(view.hero.find('chain-status').textContent, /^Right now: [a-z]/);
});

test('motivation: no streak yet reads as Day 1, not zero', async () => {
  for (const none of [null, 0, undefined, NaN]) {
    const view = await chainView(none);
    assert.equal(view.count, 'Day 1');
    assert.match(view.unit, /start the chain/);
    assert.equal(view.kept, 0);
  }
});

test('motivation: a failing streak read still renders the page', async () => {
  const { hero } = renderInto('motivation', { loadStreakDays: () => { throw new Error('no storage'); } });
  await flush();
  assert.equal(hero.find('chain-count').textContent, 'Day 1');
});

test('motivation: weeks start on the reader\'s first weekday and end with the one holding today', () => {
  const { themes } = loadThemes();
  const thursday = new Date(2026, 9, 1);
  for (const start of [0, 1]) {
    const days = Array.from(themes.chainDays(thursday, 12, start));
    assert.equal(days.length, 35);
    assert.equal(days[0].date.getDay(), start, `rows start on day ${start}`);
    const today = days.findIndex((d) => d.today);
    assert.equal(Math.floor(today / 7), 4, 'today is in the last week');
    assert.equal(days.filter((d) => d.kept).length, 12);
    assert.ok(days[today - 1].kept && days[today - 12].kept && !days[today - 13].kept);
  }
});

// --- blocked.js choosing a design ----------------------------------------------

test('blocked.js: the saved design is applied and the page revealed', async () => {
  const { doc } = openBlockedPage({ settings: { blockedPageType: 'default', blockedPageTheme: 'calm' } });
  await flush();
  assert.equal(doc.documentElement.dataset.theme, 'calm');
  assert.equal(doc.getElementById('theme-hero').hidden, false);
  assert.equal(doc.getElementById('why').open, false, 'details fold away under a design');
  assert.ok(!doc.documentElement.classList.contains('theme-pending'), 'page left hidden');
  assert.equal(doc.getElementById('back-button').textContent, 'Go back');
  assert.equal(doc.getElementById('settings').textContent, 'Settings');
});

test('blocked.js: Classic, unknown and missing designs leave the page as written', async () => {
  for (const settings of [{ blockedPageTheme: 'classic' }, { blockedPageTheme: 'nope' }, {}, null]) {
    const { doc } = openBlockedPage({ settings });
    await flush();
    assert.equal(doc.documentElement.dataset.theme, undefined);
    assert.equal(doc.getElementById('why').open, true);
    assert.ok(!doc.documentElement.classList.contains('theme-pending'), 'page left hidden');
  }
});

test('blocked.js: a custom HTML page still wins over any saved design', async () => {
  const { doc } = openBlockedPage({
    settings: { blockedPageType: 'plain_html', plainBlockedPageHtml: '<h1>Mine</h1>', blockedPageTheme: 'verse' }
  });
  await flush();
  assert.equal(doc.documentElement.dataset.theme, undefined);
});

test('blocked.js: ?preview= shows that design with a placeholder address', async () => {
  const { doc } = openBlockedPage({
    query: '?preview=verse&url=' + encodeURIComponent('https://real-site.test/'),
    settings: { blockedPageType: 'plain_html', plainBlockedPageHtml: '<h1>Mine</h1>' }
  });
  await flush();
  assert.equal(doc.documentElement.dataset.theme, 'verse');
  assert.equal(doc.getElementById('target-url').textContent, 'https://example.com/',
    'a preview must never show an address from the URL');
});

test('blocked.js: ?preview= with an unknown design is ignored', async () => {
  const { doc } = openBlockedPage({
    query: '?preview=' + encodeURIComponent('<img src=x>'),
    settings: { blockedPageTheme: 'motivation' }
  });
  await flush();
  assert.equal(doc.documentElement.dataset.theme, 'motivation', 'falls back to the saved design');
});

test('blocked.js: the Motivation streak comes from the saved streak start', async () => {
  const twelveDaysAgo = Date.now() - 12.5 * 24 * 60 * 60 * 1000;
  const { doc } = openBlockedPage({
    settings: { blockedPageTheme: 'motivation' },
    streakStart: twelveDaysAgo
  });
  await flush();
  await flush();
  const hero = doc.getElementById('theme-hero');
  assert.equal(hero.find('chain-count').textContent, '12');
});
