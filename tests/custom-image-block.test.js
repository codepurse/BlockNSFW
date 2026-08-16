// Issue #23: blocking a site must also stop its images from loading elsewhere.
// These cover the DNR half — reducing the user's customPatterns to a
// requestDomains condition. The DOM half lives in content.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();

// background.js runs in a vm realm, so its arrays/objects are not
// reference-equal to this realm's prototypes. Copy across before asserting.
const domainsFor = (...args) => Array.from(ctx.customPatternsToImageBlockDomains(...args));
const rulesFor = (...args) => JSON.parse(JSON.stringify(ctx.buildCustomImageBlockRules(...args)));

test('plain and wildcard host patterns collapse to one domain', () => {
  // requestDomains already matches subdomains, so both forms are equivalent
  assert.deepEqual(domainsFor(['deviantart.com']), ['deviantart.com']);
  assert.deepEqual(domainsFor(['*.deviantart.com']), ['deviantart.com']);
  assert.deepEqual(domainsFor(['deviantart.com', '*.deviantart.com']), ['deviantart.com']);
});

test('patterns are normalized before use', () => {
  assert.deepEqual(domainsFor(['  DeviantArt.COM  ']), ['deviantart.com']);
  assert.deepEqual(domainsFor(['example.com.']), ['example.com']);
});

test('path-scoped patterns are left to the content script', () => {
  // A host-wide image block would be broader than the user asked for
  assert.deepEqual(domainsFor(['example.com/gallery']), []);
  assert.deepEqual(domainsFor(['*.example.com/a/b']), []);
});

test('unusable patterns are dropped rather than guessed at', () => {
  assert.deepEqual(domainsFor(['ex*mple.com']), []); // no requestDomains equivalent
  assert.deepEqual(domainsFor(['localhost']), []);   // no dot
  assert.deepEqual(domainsFor(['exa mple.com']), []);
  assert.deepEqual(domainsFor(['']), []);
  assert.deepEqual(domainsFor([null, undefined]), []);
});

test('non-array input is tolerated', () => {
  assert.deepEqual(domainsFor(undefined), []);
  assert.deepEqual(domainsFor(null), []);
  assert.deepEqual(domainsFor([]), []);
});

test('an active whitelist entry outranks the pattern', () => {
  assert.deepEqual(domainsFor(['deviantart.com', 'example.com'], ['deviantart.com']), ['example.com']);
  assert.deepEqual(domainsFor(['*.deviantart.com'], ['DeviantArt.com']), []);
});

test('domain count is capped so the rule stays within DNR limits', () => {
  const many = Array.from({ length: 1500 }, (_, i) => `site${i}.com`);
  assert.equal(domainsFor(many).length, 1000);
});

test('the rule blocks image and media sub-resources only', () => {
  const [rule] = rulesFor(['deviantart.com']);
  assert.equal(rule.action.type, 'block');
  assert.deepEqual(rule.condition.requestDomains, ['deviantart.com']);
  assert.deepEqual(rule.condition.resourceTypes, ['image', 'media']);
  // Navigation must stay with the content script so the user still gets the
  // blocked page rather than a browser network error
  assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(!rule.condition.resourceTypes.includes('sub_frame'));
});

test('no domains means no rule at all', () => {
  assert.deepEqual(rulesFor([]), []);
  assert.deepEqual(rulesFor(undefined), []);
});

test('the rule id sits in the reserved range cleared on every update', () => {
  // Must stay in sync with CUSTOM_IMAGE_BLOCK_RULE_IDS / ALL_DNR_RULE_IDS,
  // which are lexical consts and so not reachable from the vm sandbox.
  const [rule] = rulesFor(['example.com']);
  assert.equal(rule.id, 10050);
});
