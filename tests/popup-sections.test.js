// The popup keeps each section in a box of its own, so a supporter's chosen
// shape (extras/sections.js, not open source) can move and hide them. These
// hold the frame that extra relies on, and the free popup's order and look:
// every section once, in the usual order; the band, the notice, the Pact's
// waiting list and Settings outside the boxes; and no box left showing an
// empty rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const ACCESS_CODE_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'access-code.js'), 'utf8');

const USUAL = ['counts', 'site', 'safesearch', 'storm', 'whitelist', 'path', 'checkin', 'stats', 'week', 'slip', 'report', 'coffee'];

const at = (needle) => {
  const i = HTML.indexOf(needle);
  assert.ok(i !== -1, `popup.html has ${needle}`);
  return i;
};
const container = () => {
  const start = at('<div class="popup-sections" id="popup-sections">');
  const end = at('<nav class="links" aria-label="More">');
  return { start, end, html: HTML.slice(start, end) };
};

test('every section has one box, in the usual order', () => {
  const ids = [...container().html.matchAll(/class="pop-sec" data-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, USUAL);
});

test('each box holds what it names', () => {
  const box = container().html;
  const holds = {
    counts: 'id="blocked-today"', site: 'id="unblock-row"', safesearch: 'id="safesearch-toggle"', storm: 'id="storm-row"',
    whitelist: 'id="whitelist-input"', path: 'id="path-link"', checkin: 'id="checkin-link"', stats: 'id="stats-btn"',
    week: 'id="week-link"', slip: 'id="slip-link"', report: 'id="contact-btn"', coffee: 'id="coffee-btn"'
  };
  USUAL.forEach((id, i) => {
    const from = box.indexOf(`data-section="${id}"`);
    const to = i + 1 < USUAL.length ? box.indexOf(`data-section="${USUAL[i + 1]}"`) : box.length;
    assert.ok(box.slice(from, to).includes(holds[id]), `the ${id} box holds ${holds[id]}`);
  });
  assert.ok(box.indexOf('id="month-link"') > box.indexOf('data-section="week"'), 'your month goes with your week');
  assert.ok(box.indexOf('id="block-row"') < box.indexOf('data-section="safesearch"'), 'block this site goes with this site');
});

test('the band, the notice, the Pact and Settings are never inside a box', () => {
  const { start, end } = container();
  for (const id of ['popup-band', 'storm-warn', 'popup-notice', 'pact-waiting']) {
    assert.ok(at(`id="${id}"`) < start, `${id} comes before the sections`);
  }
  assert.ok(at('id="settings"') > end, 'Settings closes the popup');
  assert.ok(at('id="version-badge"') > end, 'and the foot after it');
});

test('popup.html loads the sections extra before popup.js', () => {
  assert.ok(at('<script src="extras/sections.js"></script>') < at('<script src="popup.js"></script>'));
});

// Just enough of the boxes for tidySections.
function box(children) {
  const classes = new Set(['pop-sec']);
  return {
    children,
    hidden: false,
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c)
    }
  };
}
const row = (shown) => ({ hidden: false, style: { display: shown ? 'flex' : 'none' } });

test('a box with nothing to show here folds away, and comes back when it has', () => {
  const site = box([row(false), row(false)]);
  const checkin = box([{ hidden: true, style: {} }]);
  const storm = box([row(true)]);
  const context = {
    chrome: { storage: { local: { get: async () => ({}) } }, runtime: {}, tabs: {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: (s) => (s === '.pop-sec' ? [site, checkin, storm] : []) },
    console, URL, URLSearchParams, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    crypto: require('node:crypto').webcrypto
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(ACCESS_CODE_SOURCE, context);
  vm.runInContext(POPUP_SOURCE, context);

  context.tidySections();
  assert.equal(site.classList.contains('is-empty'), true, 'this site, on a browser page');
  assert.equal(checkin.classList.contains('is-empty'), true, 'the check-in, without the extra');
  assert.equal(storm.classList.contains('is-empty'), false);

  site.children[1].style.display = 'flex';
  context.tidySections();
  assert.equal(site.classList.contains('is-empty'), false, 'a website: Block this website shows');
  assert.equal(site.hidden, false, 'folding never uses hidden, which is the shape\'s');
});
