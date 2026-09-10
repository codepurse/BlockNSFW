// The static declarativeNetRequest ruleset (audit finding C2).
//
// Until now the curated blocklist was enforced only by the content script:
// window.stop() plus a redirect at document_start. Every blocked host still
// received the request, and anywhere a content script does not run — most
// importantly sub-frames — nothing was enforced at all.
//
// These rules move that into the browser's request engine. The danger of
// getting them wrong is asymmetric: `requestDomains` matches sub-domains, and
// a bad entry blocks a whole namespace at the network layer, where the user
// sees no explanation and no whitelist entry can save them. So the guards get
// more attention here than the happy path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PS = require('../shared/public-suffix.js');
const POLICY = require('../shared/domain-policy.js');

const rules = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'rules', 'blocklist-rules.json'), 'utf8'));
const psl = PS.parseList(fs.readFileSync(
  path.join(ROOT, 'data', 'public-suffixes.txt'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'manifest.firefox.json'), 'utf8'));

const allDomains = new Set();
for (const rule of rules) {
  for (const d of rule.condition.requestDomains) allDomains.add(d);
}

// ---------------------------------------------------------------------------
// The guard that matters most
// ---------------------------------------------------------------------------

test('C2: no rule blocks a whole namespace', () => {
  const intentional = POLICY.blockedPublicSuffixSet();
  const offenders = [];
  for (const domain of allDomains) {
    if (intentional.has(domain)) continue;
    if (POLICY.sharedHostParentSet().has(domain) ||
        PS.isPublicSuffix(domain, psl, { wildcards: false })) {
      offenders.push(domain);
    }
  }
  assert.deepEqual(offenders, [],
    'requestDomains matches sub-domains, so each of these would block every ' +
    'site under it at the network layer, with no whitelist escape: ' +
    offenders.join(', '));
});

test('C2: the namespaces that caused the shipped bug are absent', () => {
  for (const namespace of ['blogspot.com', 'gob.mx', 'b-cdn.net']) {
    assert.equal(allDomains.has(namespace), false,
      `${namespace} must never appear in a rule`);
  }
  // Their individually listed children must still be there — dropping the
  // parent must not drop the sites that were the point of listing it.
  const blogspotChildren = [...allDomains].filter(d => d.endsWith('.blogspot.com'));
  assert.ok(blogspotChildren.length > 10000,
    `expected the explicitly listed blogspot blogs to survive, found ${blogspotChildren.length}`);
});

test('C2: intentional wholesale blocks are still emitted', () => {
  for (const suffix of POLICY.BLOCKED_PUBLIC_SUFFIXES) {
    assert.ok(allDomains.has(suffix),
      `${suffix} is an intentional wholesale block and should be in the ruleset`);
  }
});

// ---------------------------------------------------------------------------
// Platform limits
// ---------------------------------------------------------------------------

test('C2: the ruleset fits inside the static rule budget', () => {
  // Chrome guarantees 30,000 enabled static rules. The generator caps itself
  // at 20,000 to leave room for the list to grow.
  assert.ok(rules.length <= 20000, `${rules.length} rules exceeds the self-imposed cap`);
  assert.ok(rules.length < 30000, `${rules.length} rules exceeds Chrome's guaranteed minimum`);
});

test('C2: every rule stays under the per-rule size limit', () => {
  // "each rule must be less than 2KB once compiled". Compiled size is not JSON
  // size, so the generator works to a 1KB JSON budget for margin.
  const oversized = rules.filter(r => JSON.stringify(r).length > 1024);
  assert.deepEqual(oversized.map(r => r.id), [], 'rules over the 1KB JSON budget');
});

test('C2: rule ids are unique and stable in shape', () => {
  const ids = rules.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate rule ids');
  for (const rule of rules) {
    assert.equal(rule.action.type, 'block');
    assert.ok(Array.isArray(rule.condition.requestDomains));
    assert.ok(rule.condition.requestDomains.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Scope: sub-resources only, deliberately
// ---------------------------------------------------------------------------

test('C2: main_frame is NOT blocked by the static rules', () => {
  // A DNR block on a navigation gives the browser's own ERR_BLOCKED_BY_CLIENT
  // page: no content script, so no blocked page, no reason, no audit entry and
  // no counted stat. Navigation stays with the content script on purpose. If
  // this ever changes, the blocked-page handoff has to be solved first.
  for (const rule of rules) {
    assert.equal(rule.condition.resourceTypes.includes('main_frame'), false,
      `rule ${rule.id} blocks main_frame — that removes the blocked page`);
  }
});

test('C2: sub_frame IS blocked — this is the iframe hole closing', () => {
  // The content script runs in the top frame only, so an adult site inside an
  // iframe had no coverage whatsoever. This is the layer that fixes it for
  // every host on the curated list.
  for (const rule of rules) {
    assert.ok(rule.condition.resourceTypes.includes('sub_frame'),
      `rule ${rule.id} does not cover sub_frame`);
    assert.ok(rule.condition.resourceTypes.includes('image'),
      `rule ${rule.id} does not cover image — hotlinked media is the other half`);
  }
});

// ---------------------------------------------------------------------------
// Manifest wiring
// ---------------------------------------------------------------------------

test('C2: both manifests declare the ruleset, at the path that exists', () => {
  for (const [label, m] of [['chrome', manifest], ['firefox', firefoxManifest]]) {
    const declared = m.declarative_net_request;
    assert.ok(declared, `${label}: no declarative_net_request key`);
    const resource = declared.rule_resources[0];
    assert.equal(resource.enabled, true, `${label}: ruleset is not enabled`);
    assert.ok(fs.existsSync(path.join(ROOT, resource.path)),
      `${label}: declares ${resource.path}, which does not exist`);
  }
});

test('C2: minimum_chrome_version covers requestDomains', () => {
  // requestDomains is Chrome 101+. Below that the condition is not understood
  // and the rules would be dropped or the ruleset rejected at install time.
  assert.ok(Number(manifest.minimum_chrome_version) >= 101,
    `minimum_chrome_version is ${manifest.minimum_chrome_version}; requestDomains needs 101`);
  // Firefox shipped both static rulesets and requestDomains in 113, which is
  // already the declared floor.
  const gecko = firefoxManifest.browser_specific_settings.gecko;
  assert.ok(parseFloat(gecko.strict_min_version) >= 113,
    `strict_min_version is ${gecko.strict_min_version}; static rulesets need 113`);
});

test('C2: the committed ruleset matches data/HOSTS.txt', async () => {
  // A stale ruleset ships rules for domains no longer listed and misses ones
  // that are — invisibly, because the network layer shows the user nothing.
  const { buildRuleset } = await import('../scripts/build-dnr-ruleset.mjs');
  const built = buildRuleset(
    fs.readFileSync(path.join(ROOT, 'data', 'HOSTS.txt'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'data', 'public-suffixes.txt'), 'utf8'));
  assert.equal(JSON.stringify(built.rules), JSON.stringify(rules),
    'rules/blocklist-rules.json is out of date — run node scripts/build-dnr-ruleset.mjs');
});

// ---------------------------------------------------------------------------
// Whitelist allow rules must outrank the block rules
// ---------------------------------------------------------------------------

test('C2: whitelist allow rules outrank the static block rules', () => {
  const { loadBackgroundContext } = require('./setup.js');
  const context = loadBackgroundContext();
  const allows = context.buildWhitelistAllowRules(['allowed.example']);

  assert.equal(allows.length, 1);
  assert.equal(allows[0].action.type, 'allow');
  const blockPriority = rules[0].priority;
  assert.ok(allows[0].priority > blockPriority,
    `allow priority ${allows[0].priority} must beat block priority ${blockPriority}`);
  // The allow has to cover main_frame too, so a whitelisted site is not left
  // half-blocked by the custom-pattern image rule.
  assert.ok(allows[0].condition.resourceTypes.includes('main_frame'));
  assert.ok(allows[0].condition.resourceTypes.includes('sub_frame'));
});

test('C2: allow rules reject anything that is not a bare host', () => {
  const { loadBackgroundContext } = require('./setup.js');
  const context = loadBackgroundContext();
  const allows = context.buildWhitelistAllowRules([
    'good.example', 'has/path', 'has*star', 'nodot', '', null, 'WWW.Upper.CoM'
  ]);
  // Array.from, because `allows` is built inside the vm sandbox and carries
  // that realm's Array.prototype — deepStrictEqual compares prototypes and
  // would fail on otherwise identical values.
  const domains = Array.from(allows).flatMap(r => Array.from(r.condition.requestDomains));
  assert.deepEqual(domains, ['good.example', 'upper.com']);
});

test('C2: the allow id range is fully reclaimed on every update', () => {
  const { loadBackgroundContext } = require('./setup.js');
  const vm = require('node:vm');
  const context = loadBackgroundContext();
  const allIds = vm.runInContext('ALL_DNR_RULE_IDS', context);
  const start = vm.runInContext('WHITELIST_ALLOW_RULE_ID_START', context);
  const max = vm.runInContext('MAX_WHITELIST_ALLOW_RULES', context);
  // Removing a whitelist entry has to remove its rule, so the whole range is
  // cleared each time rather than just the ids currently in use.
  for (const id of [start, start + 1, start + max - 1]) {
    assert.ok(allIds.includes(id), `rule id ${id} is never removed`);
  }
});
