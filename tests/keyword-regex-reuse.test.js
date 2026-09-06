const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// The per-keyword word-boundary regexes are now compiled once at module scope
// instead of `new RegExp(...)` per keyword per call — the page scan called them
// once per line for up to 48 lines, i.e. ~336 compilations from constant strings
// per scan. Shared /g regexes are stateful, so the reuse is only correct if
// lastIndex is reset before every use; these tests pin both halves.

test('the word-boundary regexes are compiled once, not per call', () => {
  const perCall = /const pattern = new RegExp\(`\\\\b\$\{keyword\}\\\\b`, 'gi'\)/;
  assert.equal(perCall.test(CONTENT), false,
    'a RegExp built inside the match loop is the thing this replaced');
  assert.match(CONTENT, /const ADULT_CONTEXT_PATTERNS = ADULT_CONTEXT_KEYWORDS\.map/);
});

test('every reuse of a shared /g regex resets lastIndex', () => {
  // Two call sites use ADULT_CONTEXT_PATTERNS: analyzeTextForAdultContent and
  // containsAdultKeywords. Both must reset, or the second scan of a page starts
  // mid-string and silently misses matches.
  const resets = CONTENT.match(/regex\.lastIndex = 0;/g) || [];
  const uses = CONTENT.match(/regex\.exec\(/g) || [];
  assert.equal(uses.length, 2, 'expected exactly the two known call sites');
  assert.equal(resets.length, uses.length,
    'each exec loop needs its own lastIndex reset');
});

test('a shared /g regex without a reset would miss the second scan', () => {
  // Demonstrates the failure this guards against, so the reason the resets
  // exist survives a future refactor.
  const shared = /\bporn\b/gi;
  const text = 'porn appears here';

  assert.notEqual(shared.exec(text), null, 'first scan finds it');
  assert.equal(shared.exec(text), null, 'lastIndex has advanced past the match');

  shared.lastIndex = 0;
  assert.notEqual(shared.exec(text), null, 'resetting makes the next scan correct');
});

test('the compiled patterns still cover every configured keyword', () => {
  const listed = CONTENT.match(/const ADULT_CONTEXT_KEYWORDS = \[([\s\S]*?)\];/);
  assert.ok(listed, 'ADULT_CONTEXT_KEYWORDS not found');
  const keywords = (listed[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  assert.ok(keywords.length >= 7, 'expected the known keyword list');

  // The map is over the same array, so coverage is structural — assert that the
  // patterns are derived from it rather than duplicated by hand.
  assert.match(CONTENT, /ADULT_CONTEXT_PATTERNS = ADULT_CONTEXT_KEYWORDS\.map\(keyword =>/);
});

test('the observer is not rebuilt on a timer after init', () => {
  assert.equal(/setTimeout\(setupMutationObserver, 500\)/.test(CONTENT), false,
    'rebuilding the observer at +500ms disconnected the live one and dropped ' +
    'every mutation in the gap');
});
