// Regression tests for buildHostPatterns — the background worker's compilation
// of the user's blocked-site list.
//
// These exist because a `/regex/` entry silently compiled to a pattern matching
// nothing: the helper module was not loaded in the worker, so the entry fell
// through to the wildcard path, which escaped the slashes. No error, no block,
// the user just kept browsing the site they had blocked. Compilation is now
// asserted by behaviour rather than assumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();

const matches = (patterns, url) => ctx.buildHostPatterns(patterns).some(re => re.test(url));

test('the keyword-pattern helper is available to the background worker', () => {
  // If this fails, regex entries fall back to the wildcard path and quietly
  // stop blocking — check the importScripts call and manifest.firefox.json.
  assert.notEqual(typeof ctx.KeywordPattern, 'undefined');
});

test('a URL regex entry blocks the sites it names', () => {
  const patterns = ['/example\\.(net|org)/'];
  assert.equal(matches(patterns, 'https://example.net/'), true);
  assert.equal(matches(patterns, 'https://example.org/page'), true);
});

test('a URL regex entry does not overmatch a sibling domain', () => {
  assert.equal(matches(['/example\\.(net|org)/'], 'https://example.com/'), false);
});

test('plain domains still block, with subdomains', () => {
  assert.equal(matches(['example.com'], 'https://example.com/'), true);
  assert.equal(matches(['example.com'], 'https://www.example.com/x'), true);
  assert.equal(matches(['example.com'], 'https://notexample.com/'), false);
});

test('wildcard subdomains still work', () => {
  assert.equal(matches(['*.example.com'], 'https://a.example.com/'), true);
  assert.equal(matches(['*.example.com'], 'https://other.com/'), false);
});

test('title patterns compile to nothing here', () => {
  // The page title does not exist at navigation time; the content script owns
  // these. Compiling one into a URL matcher would block the wrong pages.
  assert.equal(ctx.buildHostPatterns(['title/Example Domain/']).length, 0);
});

test('an invalid regex entry is skipped rather than throwing', () => {
  assert.doesNotThrow(() => ctx.buildHostPatterns(['/([unclosed/']));
});

test('a catastrophic pattern never reaches the compiled list', () => {
  const started = Date.now();
  const compiled = ctx.buildHostPatterns(['/(a+)+$/']);
  assert.equal(compiled.length, 0, 'must be rejected by the timing guard');
  assert.ok(Date.now() - started < 5000, 'compilation must not hang');
});

test('a mixed list compiles every usable entry', () => {
  const patterns = ['example.com', '/example\\.(net|org)/', 'title/Ignore Me/', '*.wild.com'];
  const compiled = ctx.buildHostPatterns(patterns);
  assert.equal(compiled.length, 3, 'three URL matchers, title excluded');
  assert.equal(compiled.some(re => re.test('https://example.net/')), true);
  assert.equal(compiled.some(re => re.test('https://sub.wild.com/')), true);
});
