// Regression corpus for the safe-host-token bypass (audit finding C4).
//
// The smart hostname filter suppresses a block when the hostname carries a
// recovery / support / education token, so a genuine help site is never
// filtered. That bypass used to be a BARE SUBSTRING test against the whole
// hostname, on both of the two code paths that implement it:
//
//   shared/host-keywords.js  matchesAdultKeywordHost()  -> SAFE_HOST_TOKENS
//   content.js               isLikelyAdultHostEarly()   -> its own copy
//
// So any hostname merely *containing* one of ~39 ordinary English words had
// the smart filter switched off wholesale. An operator could buy an exemption
// for a new mirror by naming it "safe-...", and several of the words were
// generic enough to collide by accident.
//
// Both paths now require a token to occupy whole hyphen-delimited segments of
// a label (shared/host-keywords.js safeHostMatches), and the words that were
// free cover rather than genuinely safety-coded have been removed.
//
// This file locks down three things at once, because the two paths compose and
// only the composition decides whether a user is actually blocked:
//   1. the shared strict matcher,
//   2. the content script's broader early check,
//   3. the OR of the two, which is what getLocalBlockReasonKey() consults.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HK = require('../shared/host-keywords.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// isLikelyAdultHostEarly lifted out of content.js and run against the real
// shared module, so the test exercises the shipped wiring rather than a copy.
function loadEarlyCheck({ withSharedModule = true } = {}) {
  const sandbox = { console, String, Array };
  if (withSharedModule) sandbox.HostBlockKeywords = HK;
  sandbox.normalizeHost = value =>
    String(value || '').trim().toLowerCase().replace(/^www\./, '');
  vm.createContext(sandbox);
  vm.runInContext(functionSource('isLikelyAdultHostEarly'), sandbox);
  return sandbox.isLikelyAdultHostEarly;
}

// ---------------------------------------------------------------------------
// The bypass corpus
// ---------------------------------------------------------------------------

// Hosts the safe-token bypass used to exempt. Each carries an adult token at a
// real label boundary, so the strict matcher has something to find once the
// bogus exemption is gone.
const FIXED_BY_C4 = [
  ['safe-pornhub.com', '"safe-" prefix'],
  ['cdn.safe.pornhub-mirror.com', '"safe" as its own label, adult token in a sibling'],
  ['xxx-study.com', '"study"'],
  ['pornhub-research.net', '"research"'],
  ['hentai-protect.io', '"protect" (bare verb; "protection" is still honoured)'],
  ['xnxx-safer.tv', '"safer"'],
];

// Hosts that also went unblocked, but for a DIFFERENT reason: the adult token
// is glued inside a longer label, which whole-label / hyphen-bounded matching
// deliberately declines. That rule is what stops "essex" matching "sex" and
// "pornreports.com" being filtered, so these are a separate design question
// (tracked as C4b), NOT something this change claims to fix.
//
// They are pinned here so the distinction stays visible: if a later change to
// the adult-token side starts catching them, that is a deliberate decision and
// this list should move, not be quietly deleted.
const NOT_FIXED_GLUED_TOKEN = [
  ['pornsafe.com', '"porn" glued to "safe" in one label'],
  ['freedomporn.com', '"porn" glued inside "freedomporn"'],
  ['libertyxxx.net', '"xxx" glued inside "libertyxxx"'],
  ['helpxxx.com', '"xxx" glued inside "helpxxx"'],
];

test('C4: safe-token bypass no longer exempts adult hosts (strict matcher)', () => {
  for (const [host, why] of FIXED_BY_C4) {
    assert.equal(HK.matchesAdultKeywordHost(host), true,
      `${host} must be blocked — bypassed via ${why}`);
  }
});

test('C4: the strict matcher still declines a glued token (documented limit)', () => {
  for (const [host, why] of NOT_FIXED_GLUED_TOKEN) {
    assert.equal(HK.matchesAdultKeywordHost(host), false,
      `${host} is out of scope for the label matcher — ${why}`);
  }
});

test('C4: the content script early check no longer exempts them either', () => {
  const isLikelyAdultHostEarly = loadEarlyCheck();
  // This path matches adult tokens as bare substrings, so it is broader than
  // the strict matcher and catches the glued-token hosts too. What it must no
  // longer do is exempt a host because "help"/"protect" appears somewhere in it.
  assert.equal(isLikelyAdultHostEarly('hentai-protect.io'), true,
    '"protect" must no longer switch the early check off');
  assert.equal(isLikelyAdultHostEarly('helpxxx.com'), true,
    '"help" is not a segment of "helpxxx" and must not exempt it');
  assert.equal(isLikelyAdultHostEarly('freedomporn.com'), true);
  assert.equal(isLikelyAdultHostEarly('pornsafe.com'), true);
});

test('C4: composed navigation verdict blocks every host in the corpus', () => {
  // getLocalBlockReasonKey() ORs the two, and that composition is the only
  // thing that decides whether a navigation is stopped.
  const isLikelyAdultHostEarly = loadEarlyCheck();
  const blocked = host =>
    HK.matchesAdultKeywordHost(host) || isLikelyAdultHostEarly(host);
  for (const [host] of [...FIXED_BY_C4, ...NOT_FIXED_GLUED_TOKEN]) {
    assert.equal(blocked(host), true, `${host} must be blocked at navigation`);
  }
});

// ---------------------------------------------------------------------------
// The exemption still has to work — this is the half that protects users
// ---------------------------------------------------------------------------

test('C4: genuine recovery and support hosts stay exempt', () => {
  const isLikelyAdultHostEarly = loadEarlyCheck();
  const exempt = [
    ['porn-recovery.org', 'suffix segment'],
    ['pornhub-recovery.com', 'suffix segment'],
    ['porn-addiction-treatment.org', 'two middle segments'],
    ['stop-porn.org', 'hyphenated token matched whole'],
    ['no-porn.net', 'hyphenated token matched whole'],
    ['anti-porn.org', 'hyphenated token matched whole'],
    ['nofap.support.com', 'token in a subdomain label'],
    ['porn-help.org', 'a real support site named for what it does'],
    ['porn-addiction-counselling.co.uk', 'multi-part TLD must not break it'],
    ['色情-recovery.org', 'CJK label plus a safe segment'],
    ['hentai-protection.io', '"protection" is kept where "protect" was dropped'],
  ];
  for (const [host, why] of exempt) {
    assert.equal(HK.matchesAdultKeywordHost(host), false,
      `${host} must stay exempt — ${why}`);
    assert.equal(isLikelyAdultHostEarly(host), false,
      `${host} must stay exempt on the early path too — ${why}`);
  }
});

test('C4: safeHostMatches requires whole hyphen-delimited segments', () => {
  const safe = HK.safeHostMatches;
  // Whole label, prefix, suffix, middle — all four positions count.
  assert.equal(safe('recovery.org'), true);
  assert.equal(safe('recovery-porn.org'), true);
  assert.equal(safe('porn-recovery.org'), true);
  assert.equal(safe('porn-recovery-group.org'), true);
  // Glued into a longer segment — does not count.
  assert.equal(safe('recoveryporn.org'), false);
  assert.equal(safe('pornrecovery.org'), false);
  assert.equal(safe('helpxxx.com'), false);
  assert.equal(safe(''), false);
  assert.equal(safe(null), false);
});

test('C4: the words that were free cover are gone and must not come back', () => {
  // Each of these let an operator exempt a new mirror for the price of a
  // hyphen. See the curation note in shared/host-keywords.js before re-adding.
  for (const token of ['safe', 'safer', 'study', 'research', 'academic',
    'freedom', 'liberty', 'protect']) {
    assert.equal(HK.SAFE_HOST_TOKENS.includes(token), false,
      `"${token}" must not be a safe-host token — it is generic enough to be free cover`);
  }
  // The specific replacements that were kept.
  assert.ok(HK.SAFE_HOST_TOKENS.includes('protection'));
  assert.ok(HK.SAFE_HOST_TOKENS.includes('accountability'));
  assert.ok(HK.SAFE_HOST_TOKENS.includes('nofap'));
});

test('C4: the early check falls back to segment matching without the shared module', () => {
  // content.js is injected as a list of files; if host-keywords.js failed to
  // load, the inline fallback must apply the same segment rule rather than
  // reverting to the substring bypass.
  const isLikelyAdultHostEarly = loadEarlyCheck({ withSharedModule: false });
  assert.equal(isLikelyAdultHostEarly('hentai-protect.io'), true);
  assert.equal(isLikelyAdultHostEarly('helpxxx.com'), true);
  assert.equal(isLikelyAdultHostEarly('porn-recovery.org'), false);
  assert.equal(isLikelyAdultHostEarly('porn-addiction-treatment.org'), false);
});
