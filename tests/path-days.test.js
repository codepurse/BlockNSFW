// The path's words in this repository: the first week whole, and the titles
// of days 8 to 30, whose words are a Supporter extra (extras/README.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PathDays = require('../shared/path-days.js');
const Path = require('../shared/path.js');

const { DAYS, WEEKS, SIGNATURE } = PathDays;
const ROOT = path.join(__dirname, '..');

test('thirty days, numbered in order, in four weeks that cover them all', () => {
  assert.equal(DAYS.length, Path.DAYS);
  DAYS.forEach((d, i) => assert.equal(d.n, i + 1));
  assert.equal(WEEKS[0].from, 1);
  assert.equal(WEEKS[WEEKS.length - 1].to, Path.DAYS);
  for (let i = 1; i < WEEKS.length; i++) assert.equal(WEEKS[i].from, WEEKS[i - 1].to + 1);
  assert.equal(WEEKS[0].to, Path.FREE_DAYS, 'the free days are exactly the first week');
});

test('the free week is whole: a title, a body, a story prompt and one thing to do', () => {
  for (const d of DAYS.slice(0, Path.FREE_DAYS)) {
    assert.ok(PathDays.has(d.n), `day ${d.n}`);
    assert.ok(d.title && d.title.length < 60, `day ${d.n} title`);
    assert.ok(Array.isArray(d.body) && d.body.length >= 3, `day ${d.n} body`);
    assert.ok(typeof d.story === 'string' && d.story.length > 10, `day ${d.n} story`);
    assert.ok(['do', 'line', 'link'].includes(d.one.kind), `day ${d.n} kind`);
  }
  assert.equal(typeof SIGNATURE, 'string');
});

test('days 8 to 30 are titles only here: their words are a Supporter extra', () => {
  for (const d of DAYS.slice(Path.FREE_DAYS)) {
    assert.ok(d.title && d.title.length < 60, `day ${d.n} keeps its title`);
    assert.deepEqual(Object.keys(d).sort(), ['n', 'title'], `day ${d.n} carries nothing else`);
    assert.equal(PathDays.has(d.n), false, `day ${d.n}`);
  }
  // Nothing of them in the file either, not even in a comment.
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'path-days.js'), 'utf8');
  assert.equal((src.match(/\bbody:/g) || []).length, Path.FREE_DAYS);
});

test('add() fills in a day that has only its title, and nothing else', () => {
  delete require.cache[require.resolve('../shared/path-days.js')];
  const fresh = require('../shared/path-days.js');
  const firstBody = fresh.DAYS[0].body;
  fresh.add([
    { n: 1, title: 'Not this', body: ['replaced?'] },
    { n: 8, title: 'Not this either', body: ['a', 'b', 'c'], story: 's', one: { kind: 'do', text: 't' } },
    { n: 9 },
    { n: 99, body: ['x'] }
  ]);
  assert.equal(fresh.DAYS[0].body, firstBody, 'a whole day is left as it is');
  assert.deepEqual(fresh.DAYS[7].body, ['a', 'b', 'c']);
  assert.equal(fresh.DAYS[7].title, DAYS[7].title, 'the title stays this file\'s');
  assert.ok(fresh.has(8));
  assert.ok(!fresh.has(9), 'a day without words stays without');
  assert.equal(fresh.DAYS.length, Path.DAYS);
});

test('the free week\'s links go to places that exist', () => {
  for (const d of DAYS.slice(0, Path.FREE_DAYS).filter((x) => x.one.kind === 'link')) {
    const [file, anchor] = d.one.href.split('#');
    assert.ok(fs.existsSync(path.join(ROOT, file)), `day ${d.n}: ${file} exists`);
    if (anchor) assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(`id="${anchor}"`), `day ${d.n}: #${anchor}`);
  }
});

test('no straight quotes or escapes in the words', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'path-days.js'), 'utf8');
  for (const d of DAYS) {
    const all = [d.title, d.story || '', d.one ? d.one.text : '', (d.one && d.one.prompt) || '', ...(d.body || [])].join(' ');
    assert.doesNotMatch(all, /"|\\u/, `day ${d.n}`);
    assert.doesNotMatch(all, /[A-Za-z]'[a-z]/, `day ${d.n} uses a straight apostrophe`);
  }
  assert.doesNotMatch(src, /\\u[0-9a-f]{4}/i);
});
