// Tests for shared/keyword-pattern.js — the `/regex/` form of a custom blocked
// word. These patterns run against every page the user visits, so the risky
// cases (stateful flags, catastrophic backtracking) matter more than the happy
// path.
const test = require('node:test');
const assert = require('node:assert/strict');
const KP = require('../shared/keyword-pattern.js');

test('literal entries are left alone', () => {
  for (const entry of ['apricot', 'buy now, act fast', 'site name', 'a/b']) {
    const result = KP.validateEntry(entry);
    assert.equal(result.isRegex, false, `${entry} should be literal`);
    assert.equal(result.ok, true);
    assert.equal(KP.compileEntry(entry), null, 'literals compile to null');
  }
});

test('a slash-wrapped entry is recognised as a regex', () => {
  assert.equal(KP.isRegexEntry('/p[o0]rn/'), true);
  assert.equal(KP.isRegexEntry('/escort(s|ing)?/i'), true);
  assert.equal(KP.isRegexEntry('apricot'), false);
  // A single slash is not a pattern — a user typing a path means it literally.
  assert.equal(KP.isRegexEntry('/'), false);
  assert.equal(KP.isRegexEntry('example.com/adult'), false);
});

test('a valid pattern compiles and matches', () => {
  const re = KP.compileEntry('/p[o0]rn/');
  assert.ok(re.test('free p0rn here'));
  assert.ok(re.test('free porn here'));
  assert.ok(!re.test('popcorn'));
});

test('matching is case-insensitive even without the i flag', () => {
  // Literal entries have always ignored capitals; a regex behaving differently
  // would be a trap.
  const re = KP.compileEntry('/apricot/');
  assert.ok(re.test('APRICOT'));
  assert.ok(re.test('Apricot'));
});

test('the suffix case Maksim reported is expressible', () => {
  const re = KP.compileEntry('/apricots?/');
  assert.ok(re.test('one apricot'));
  assert.ok(re.test('two Apricots'));
});

test('a syntax error is reported, not thrown', () => {
  const result = KP.validateEntry('/([unclosed/');
  assert.equal(result.ok, false);
  assert.equal(result.isRegex, true);
  assert.ok(result.error.length > 0, 'should carry the engine message');
  assert.equal(KP.compileEntry('/([unclosed/'), null);
});

test('the g and y flags are refused', () => {
  // Both make a RegExp stateful, so a reused pattern would match on one page
  // and silently skip the next.
  for (const flag of ['g', 'y']) {
    const result = KP.validateEntry(`/porn/${flag}`);
    assert.equal(result.ok, false, `${flag} should be refused`);
    assert.match(result.error, new RegExp(`"${flag}"`));
  }
});

test('unknown flags are refused', () => {
  const result = KP.validateEntry('/porn/x');
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown flag/);
});

test('allowed flags are accepted', () => {
  for (const flags of ['i', 'm', 's', 'u', 'im']) {
    assert.equal(KP.validateEntry(`/porn/${flags}`).ok, true, `${flags} should be allowed`);
  }
});

test('an empty pattern between slashes is refused', () => {
  const result = KP.validateEntry('//');
  assert.equal(result.ok, false);
  assert.match(result.error, /Empty pattern/);
});

test('an over-long pattern is refused', () => {
  const result = KP.validateEntry('/' + 'a'.repeat(KP.MAX_PATTERN_LENGTH + 10) + '/');
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test('a catastrophically slow pattern is refused', () => {
  // The classic exponential blow-up. It is valid, so only measurement catches
  // it — and it must be caught here rather than on the user's pages.
  const result = KP.validateEntry('/(a+)+$/');
  assert.equal(result.ok, false);
  assert.equal(result.isRegex, true);
  assert.match(result.error, /too slow|freeze/i);
  assert.equal(KP.compileEntry('/(a+)+$/'), null, 'must not compile for matching');
});

test('a second nested-quantifier form is refused', () => {
  const result = KP.validateEntry('/(x+x+)+y/');
  assert.equal(result.ok, false);
  assert.match(result.error, /too slow|freeze/i);
});

test('ordinary patterns pass the timing probe comfortably', () => {
  for (const entry of ['/p[o0]rn/', '/escort(s|ing)?/', '/\\bxxx\\b/', '/[a-z]+cam[a-z]+/']) {
    assert.equal(KP.validateEntry(entry).ok, true, `${entry} should be accepted`);
  }
});

test('whitespace around an entry does not change how it is read', () => {
  assert.equal(KP.isRegexEntry('  /porn/  '), true);
  assert.ok(KP.compileEntry('  /porn/  ').test('porn'));
});
