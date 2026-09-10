// ReDoS guard regression suite (audit finding C1).
//
// Two independent holes let a catastrophic pattern through, and both are
// reproduced here as timing assertions rather than as verdict assertions,
// because the failure mode is "takes minutes", not "returns the wrong answer":
//
//   (a) probeAlphabet() collected only [A-Za-z0-9] literals and fell back to
//       "a", so a pattern whose blow-up alphabet is punctuation or a negated
//       class was probed with characters it never matches. /([-.]+)+$/ passed
//       validation in 1 ms and then cost ~15 s against a run of 30 dots —
//       text that appears on ordinary pages as an ellipsis or a separator.
//
//   (b) The 10 ms budget is read AFTER compiled.test() returns, so a probe
//       that does not return is never billed. The prose probe was the full
//       43-character pangram, which holds a 36-character run with no "a", so
//       /([^a]+)+$/ backtracked exponentially inside the validator itself.
//
// EVERY case that could hang runs in a CHILD PROCESS with a hard timeout. A
// test that hangs in-process does not fail — it wedges the whole run, which is
// exactly what happened while this finding was being investigated. The child
// either prints a verdict or is killed, and being killed is a failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KP = require('../shared/keyword-pattern.js');
const R = require('../shared/ruleset.js');

const KP_PATH = path.join(__dirname, '..', 'shared', 'keyword-pattern.js').replace(/\\/g, '/');
const RS_PATH = path.join(__dirname, '..', 'shared', 'ruleset.js').replace(/\\/g, '/');

// Run one snippet in a fresh node process. Returns its stdout, or throws if it
// did not finish inside `timeoutMs` — which is the assertion that matters.
function runIsolated(snippet, timeoutMs = 5000) {
  return execFileSync(process.execPath, ['-e', snippet], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validateIsolated(pattern, timeoutMs = 5000) {
  const snippet =
    `const KP=require(${JSON.stringify(KP_PATH)});` +
    `const t=Date.now();` +
    `const v=KP.validateEntry(${JSON.stringify(pattern)});` +
    `process.stdout.write(JSON.stringify({ok:v.ok,ms:Date.now()-t}));`;
  return JSON.parse(runIsolated(snippet, timeoutMs));
}

// The family that hangs. Each is catastrophic on some input; the guard must
// refuse every one of them, and must do so quickly.
const CATASTROPHIC = [
  ['/(a+)+$/', 'the textbook case'],
  ['/(a*)*$/', 'star nested in star'],
  ['/(a+)*$/', 'plus nested in star'],
  ['/(x+x+)+y/', 'two inner repeats, alphabet not "a"'],
  ['/([-.]+)+$/', 'punctuation class — hole (a)'],
  ['/([._-]*)*!/', 'punctuation class, star form — hole (a)'],
  ['/([^a]+)+$/', 'negated class — hole (b), hung the validator'],
  ['/([^x]+)+$/', 'negated class, different escape char'],
  ['/(\\s+\\s+)+$/', 'whitespace runs'],
  ['/(\\d+\\d+)+$/', 'digit runs'],
  ['/(\\w+\\s?)*$/', 'the classic log-parser pattern'],
  ['/([a-z]+)+$/', 'range class'],
  ['/(a{1,}){2,}$/', 'brace quantifiers spelling the same shape'],
];

test('C1: every catastrophic pattern is refused, in a bounded time', () => {
  for (const [pattern, why] of CATASTROPHIC) {
    let result;
    try {
      result = validateIsolated(pattern);
    } catch (err) {
      assert.fail(
        `validateEntry(${pattern}) did not return within 5 s — the guard itself ` +
        `hangs on this pattern (${why}). ${err.killed ? 'Child was killed.' : err.message}`
      );
    }
    assert.equal(result.ok, false, `${pattern} must be rejected (${why})`);
    assert.ok(result.ms < 2000,
      `${pattern} took ${result.ms} ms to reject; the guard must not stall (${why})`);
  }
});

test('C1: rejection is structural, so it costs no execution at all', () => {
  // The shape check runs before the pattern is compiled or tested even once,
  // which is the only way to be safe: test() cannot be interrupted.
  for (const [pattern] of CATASTROPHIC) {
    const t0 = Date.now();
    const verdict = KP.validateEntry(pattern);
    const ms = Date.now() - t0;
    assert.equal(verdict.ok, false);
    assert.ok(ms < 50, `${pattern} should be refused on shape in <50 ms, took ${ms} ms`);
  }
});

test('C1: findNestedQuantifier names the offending construct', () => {
  assert.equal(KP.findNestedQuantifier('(a+)+$'), '(a+)+');
  assert.equal(KP.findNestedQuantifier('([-.]+)+$'), '([-.]+)+');
  assert.equal(KP.findNestedQuantifier('foo(\\w+\\s?)*bar'), '(\\w+\\s?)*');
  // The message the user sees has to say what to change.
  const verdict = KP.validateEntry('/(a+)+$/');
  assert.match(verdict.error, /repeats a repeat/i);
  assert.match(verdict.error, /\(a\+\)\+/);
});

// ---------------------------------------------------------------------------
// The guard must not become so blunt that ordinary patterns stop working
// ---------------------------------------------------------------------------

const LEGITIMATE = [
  ['/p[o0]rn/', 'character class, the documented example'],
  ['/porn|xxx/', 'plain alternation'],
  ['/(porn|xxx)/', 'grouped alternation, no inner repeat'],
  ['/(foo|bar)+/', 'repeated group with no inner repeat'],
  ['/(\\d{3}-)+\\d{4}/', 'bounded inner quantifier stays legal'],
  ['/(ab){2,4}/', 'bounded group repeat'],
  ['/^https?:\\/\\/\\S+$/', 'a URL pattern'],
  ['/sex+y/', 'quantifier on a plain atom'],
  ['/(?:free)?porn/', 'non-capturing group with ?'],
  ['/(?=.*adult).*/', 'lookahead containing a star'],
  ['/nsfw\\s*content/', 'escape plus star, no group'],
  ['/[a-z]+\\.(com|net)/', 'class repeat outside any group'],
];

test('C1: ordinary patterns still validate', () => {
  for (const [pattern, why] of LEGITIMATE) {
    const verdict = KP.validateEntry(pattern);
    assert.equal(verdict.ok, true,
      `${pattern} must stay valid (${why}) — got: ${verdict.error}`);
  }
});

test('C1: literals and comments are untouched by the shape check', () => {
  assert.equal(KP.validateEntry('porn').ok, true);
  assert.equal(KP.validateEntry('adult content').ok, true);
  assert.equal(KP.validateEntry('# a note').ok, true);
  assert.equal(KP.validateEntry('\\#nsfw').ok, true);
  // A literal containing (a+)+ is a phrase, not a pattern.
  assert.equal(KP.validateEntry('(a+)+').ok, true);
});

// ---------------------------------------------------------------------------
// Probe hardening — hole (a) and hole (b) directly
// ---------------------------------------------------------------------------

test('C1: no probe string exceeds the calibrated length', () => {
  // The cap IS the calibration: at ~22 characters an exponential pattern costs
  // a few million steps, which is over budget and detectable, while an honest
  // one finishes in microseconds. An uncapped probe breaks that guarantee.
  for (const body of ['[^a]+', 'a+', '[-.]+', 'the', '\\w+\\s?']) {
    for (const probe of KP.probeStrings(body)) {
      assert.ok(probe.length <= KP.PROBE_REPEAT,
        `probe ${JSON.stringify(probe)} is ${probe.length} chars, over PROBE_REPEAT`);
    }
  }
});

test('C1: the probe alphabet reaches punctuation and negated classes', () => {
  // Hole (a): a pattern about hyphens and dots was only ever probed with "a".
  const punct = KP.probeStrings('([-.]+)+$').join('\n');
  assert.ok(punct.includes('---'), 'a run of hyphens must be probed');
  assert.ok(punct.includes('...'), 'a run of dots must be probed');
  // Hole (b): a negated class is stressed by a character it excludes.
  const negated = KP.probeStrings('([^a]+)+$').join('\n');
  assert.ok(/[^a\n]{5,}/.test(negated),
    'a negated class must be probed with characters it does not contain');
});

// ---------------------------------------------------------------------------
// The subscription path — where the stall became a remote outage
// ---------------------------------------------------------------------------

test('C1: a hostile line in a subscribed list cannot stall the parser', () => {
  const file = 'spam.example\n' + '/([^a]+)+$/\n'.repeat(4) + 'other.example\n';
  let out;
  try {
    out = runIsolated(
      `const R=require(${JSON.stringify(RS_PATH)});` +
      `const t=Date.now();` +
      `const p=R.parseRuleset(${JSON.stringify(file)});` +
      `process.stdout.write(JSON.stringify({n:p.entries.length,skipped:p.skipped,ms:Date.now()-t}));`,
      5000
    );
    out = JSON.parse(out);
  } catch (err) {
    assert.fail(
      'parseRuleset() did not return within 5 s on a 6-line file. This runs on ' +
      'the background thread at every startup, so a stall here stops the ' +
      'blocklist being consulted at all while the UI still reads "Protection on". ' +
      (err.killed ? 'Child was killed.' : err.message)
    );
  }
  assert.equal(out.n, 2, 'the two real host rules survive');
  assert.equal(out.skipped, 4, 'the four hostile regexes are skipped');
  assert.ok(out.ms < 2000, `parse took ${out.ms} ms`);
});

test('C1: regex rules in a subscription are capped well below MAX_ENTRIES', () => {
  assert.ok(R.MAX_REGEX_ENTRIES < R.MAX_ENTRIES / 100,
    'the regex cap must be far below the entry cap — validation is the expensive step');
  // Distinct patterns, so deduplication is not what limits them.
  const lines = [];
  for (let i = 0; i < R.MAX_REGEX_ENTRIES + 60; i++) lines.push(`/spam${i}\\.example/`);
  const parsed = R.parseRuleset(lines.join('\n'));
  assert.equal(parsed.entries.length, R.MAX_REGEX_ENTRIES);
  assert.equal(parsed.skipped, 60, 'rules past the cap are reported, not silently dropped');
});

test('C1: the regex cap does not limit ordinary host rules', () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`host${i}.example`);
  const parsed = R.parseRuleset(lines.join('\n'));
  assert.equal(parsed.entries.length, 1000);
  assert.equal(parsed.skipped, 0);
});

// ---------------------------------------------------------------------------
// The end-to-end symptom: a saved pattern running against page text
// ---------------------------------------------------------------------------

test('C1: an accepted pattern is fast on the text it will actually meet', () => {
  // matchesCustomKeywords() runs compiled patterns over up to 48 lines of body
  // text on every page, so anything that survives validation has to be quick
  // on the punctuation runs ordinary pages are full of.
  const pageText = [
    '-'.repeat(40),
    '.'.repeat(40),
    ' '.repeat(40) + 'indented code',
    'the quick brown fox jumps over the lazy dog',
    'a'.repeat(40) + '!',
  ];
  for (const [pattern] of LEGITIMATE) {
    const compiled = KP.compileEntry(pattern);
    if (!compiled) continue;
    const t0 = Date.now();
    for (const line of pageText) compiled.test(line);
    const ms = Date.now() - t0;
    assert.ok(ms < 100, `${pattern} took ${ms} ms across five lines of ordinary text`);
  }
});
