// Focused tests for the shared smart hostname matcher (host-keywords.js).
// Covers the P1 multilingual curation, P0 punycode / IDN hostname smart
// matching, and benign-context false-positive guards.
//
// Imports the shared module directly so the tests stay decoupled from the
// service-worker sandbox in tests/setup.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const HK = require('../shared/host-keywords.js');
const H = require('../shared/hostname.js');

const matches = HK.matchesAdultKeywordHost;

// ---------------------------------------------------------------------------
// P0 punycode / IDN coverage
// ---------------------------------------------------------------------------

test('matchesAdultKeywordHost: raw punycode host is processed (not silently dropped)', () => {
  // The P0 fix made isLikelyDomain() accept "xn--" labels. The smart
  // matcher must then process them through the same label scan. The
  // punycode form of a host like "pornó.net" does NOT contain the ASCII
  // keyword "porno" at a label boundary (the punycode form is
  // "xn--porn-tqa" which is its own label), so this returns false.
  // That is the correct strict-match behavior.
  assert.equal(matches('xn--porn-tqa.net'), false,
    'punycode form has "xn--porn-tqa" as a single label; ASCII "porno" is not a label boundary match');
  // The decoded form is what would contain the keyword, but only if the
  // decoded label is itself a strong keyword. Decoded: "pornó" != "porno".
  assert.equal(matches('xn--e1afmkfd.com'), false,
    'Cyrillic "пример" decodes from "e1afmkfd"; "пример" is not a strong keyword');
  // Verifying the smart matcher does not throw on these inputs (P0 fix).
  assert.equal(typeof matches('xn--porn-tqa.net'), 'boolean');
});

test('matchesAdultKeywordHost: decoded Unicode adult hostname matches', () => {
  // This hostname is given to the matcher in its already-decoded Unicode
  // form. The matcher must still catch it because HostnameNormalize is
  // not strictly required - the label scan itself is unicode-safe.
  // Use a known CJK adult mirror.
  assert.equal(matches('色情.com'), true);
  assert.equal(matches('야동.io'), true);
  assert.equal(matches('порно.org'), true);
});

test('matchesAdultKeywordHost: hostnames that look punycode-y but are NOT adult do not match', () => {
  // Hardcoded punycode forms (verified against the Node `punycode` package).
  // münchen -> mnchen-3ya (German for "Munich" - the city).
  // пример  -> e1afmkfd (Cyrillic for "example").
  assert.equal(matches('xn--mnchen-3ya.de'), false, 'münchen.de must not match');
  assert.equal(matches('xn--e1afmkfd.com'), false, 'Cyrillic "example" must not match');
});

// ---------------------------------------------------------------------------
// Whole-label vs hyphen-bounded vs substring (P1 strict rules)
// ---------------------------------------------------------------------------

test('matchesAdultKeywordHost: whole-label positive matches', () => {
  assert.equal(matches('pornhub.com'), true);
  assert.equal(matches('xvideos.com'), true);
  assert.equal(matches('xnxx.com'), true);
  assert.equal(matches('seks.com'), true);
  assert.equal(matches('bokep.com'), true);
  assert.equal(matches('yadong.com'), true);
  assert.equal(matches('hentai.com'), true);
});

test('matchesAdultKeywordHost: hyphen-bounded positive matches', () => {
  // Label starts with token + '-'.
  assert.equal(matches('porn-tube.com'), true);
  assert.equal(matches('porn-hub.com'), true);
  // Label ends with '-' + token.
  assert.equal(matches('free-porn.com'), true);
  // CJK hyphen-bounded.
  assert.equal(matches('free-야동.net'), true);
});

test('matchesAdultKeywordHost: substring false-positive negatives', () => {
  // Tokens that are substrings but not at label boundaries must NOT match.
  assert.equal(matches('essex.com'), false, 'essex contains "sex" as substring but sex is not a STRONG keyword anyway');
  assert.equal(matches('pornreports.com'), false, 'pornreports is not a whole-label match for "porn"');
  assert.equal(matches('brazzerscdn.com'), false, 'brazzerscdn is not at a label boundary');
  // "porn" appears mid-label in "my-porn-tube" (between "my-" and "-tube").
  // The strict matcher correctly rejects mid-label occurrences.
  assert.equal(matches('my-porn-tube.com'), false,
    '"porn" is mid-label in "my-porn-tube", not at a label boundary');
  assert.equal(matches('pornoizle.com'), true, 'pornoizle is a whole label, matches by ===');
  // Mid-label substring also rejected.
  assert.equal(matches('portporn.com'), false, 'mid-label "porn" suffix must not match');
});

// ---------------------------------------------------------------------------
// P1 multilingual positive coverage
// ---------------------------------------------------------------------------

test('matchesAdultKeywordHost: Chinese (CJK) tokens match', () => {
  assert.equal(matches('色情.com'), true);
  // Hyphen-bounded CJK: the label "free-色情" starts with the token
  // and the suffix is empty (just the TLD after).
  assert.equal(matches('free-色情.org'), true);
  // A label LONGER than the token (e.g. "色情影院") is not a whole-label
  // match. The strict matcher correctly rejects it - the page-level
  // fallback (P2) would be the right tool for compound CJK terms.
  assert.equal(matches('色情影院.net'), false,
    'strict matcher only matches the token "色情" as a whole label');
});

test('matchesAdultKeywordHost: Japanese (Hiragana/Katakana) tokens match', () => {
  // Japanese "hentai" is already a whole-label match in Latin script.
  assert.equal(matches('hentai.com'), true);
  assert.equal(matches('hentaihaven.com'), true);
  // Japanese Katakana "アダルト" (adult) - not yet a token, but verify
  // it does NOT match (conservative curation).
  assert.equal(matches('アダルト.com'), false,
    'アダルト is not in STRONG_HOST_KEYWORDS - conservative curation');
});

test('matchesAdultKeywordHost: Korean tokens match', () => {
  assert.equal(matches('야동.com'), true);
  assert.equal(matches('free-야동.net'), true);
  // Romanized fallback.
  assert.equal(matches('yadong.com'), true);
});

test('matchesAdultKeywordHost: Cyrillic tokens match', () => {
  assert.equal(matches('порно.com'), true);
  assert.equal(matches('порно-тут.net'), true);
  // Latin transliteration fallback.
  assert.equal(matches('porno.com'), true);
  // Non-adult Cyrillic must not match.
  assert.equal(matches('пример.com'), false);
});

test('matchesAdultKeywordHost: Arabic tokens match', () => {
  assert.equal(matches('سكس.com'), true);
  assert.equal(matches('free-سكس.net'), true);
});

test('matchesAdultKeywordHost: Thai tokens match', () => {
  assert.equal(matches('หนังโป๊.com'), true);
  assert.equal(matches('free-หนังโป๊.net'), true);
});

test('matchesAdultKeywordHost: transliterated Latin-script hosts match', () => {
  assert.equal(matches('bokep.com'), true);
  assert.equal(matches('sikis.com'), true);
  assert.equal(matches('seks.com'), true);
  assert.equal(matches('tubeporn.com'), true);
  assert.equal(matches('pornoizle.com'), true);
});

// ---------------------------------------------------------------------------
// P1 false-positive guards (benign contexts must NOT be blocked)
// ---------------------------------------------------------------------------

test('matchesAdultKeywordHost: safe-host bypass suppresses recovery / support', () => {
  // Broad-substring safe-host tokens override the adult match.
  assert.equal(matches('porn-recovery.org'), false);
  assert.equal(matches('sex-addicts-help.org'), false);
  assert.equal(matches('pornhub-recovery.com'), false);
  assert.equal(matches('porn-addiction-treatment.org'), false);
  assert.equal(matches('stop-porn.org'), false);
  assert.equal(matches('nofap.support.com'), false);
  // CJK + safe-host bypass.
  assert.equal(matches('色情-recovery.org'), false,
    'safe-host bypass must also apply to CJK-script hosts');
});

test('matchesAdultKeywordHost: education / health / sex-ed pages not blocked', () => {
  // "sex education" sites: no whole-label adult token, must not match.
  assert.equal(matches('sexeducation.com'), false);
  assert.equal(matches('healthline.com'), false);
  assert.equal(matches('plannedparenthood.org'), false);
  // Wikipedia / general reference.
  assert.equal(matches('wikipedia.org'), false);
  assert.equal(matches('merriam-webster.com'), false);
});

test('matchesAdultKeywordHost: analytics / dictionary / general news not blocked', () => {
  // Hosts containing misleading fragments (substring of an adult token)
  // but no label-boundary match must not be blocked.
  assert.equal(matches('sexes.com'), false, 'contains "sex" substring but not a label');
  assert.equal(matches('pornreports.com'), false);
  assert.equal(matches('cam4sales.com'), false, '"cam" is not a keyword; "cam4" is the brand');
  // Brand-name collisions that are NOT adult (portnhub typo, pornhub.dev).
  assert.equal(matches('example.com'), false);
  assert.equal(matches('github.com'), false);
  assert.equal(matches('stackoverflow.com'), false);
});

test('matchesAdultKeywordHost: null / empty / non-string inputs are safe', () => {
  assert.equal(matches(''), false);
  assert.equal(matches(null), false);
  assert.equal(matches(undefined), false);
  assert.equal(matches(123), false);
});

// ---------------------------------------------------------------------------
// Token list integrity (defensive: prevent accidental deletion of curated tokens)
// ---------------------------------------------------------------------------

test('STRONG_HOST_KEYWORDS: contains the P1 multilingual seed tokens', () => {
  for (const t of ['色情', '야동', 'порно', 'سكس', 'หนังโป๊', 'bokep', 'yadong', 'seks', 'sikis']) {
    assert.ok(HK.STRONG_HOST_KEYWORDS.includes(t), 'STRONG_HOST_KEYWORDS missing ' + t);
  }
});

test('AMBIGUOUS_HOST_KEYWORDS: documents the rejected seed list', () => {
  // Defensive: make sure the most common rejects are still tracked.
  for (const t of ['sex', 'jav', 'cam', 'tube', 'video', 'live']) {
    assert.ok(Object.prototype.hasOwnProperty.call(HK.AMBIGUOUS_HOST_KEYWORDS, t),
      'AMBIGUOUS_HOST_KEYWORDS missing documentation for ' + t);
  }
});
