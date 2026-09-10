// Parent-domain matching must never cross a public suffix.
//
// This was live in a shipped release. isUrlInDefaultBlocklist() blocks a host
// if the host OR ANY PARENT of it is on the blocklist, which is correct for
// `cdn.pornhub.com` matching `pornhub.com`. But data/HOSTS.txt carried
// `www.blogspot.com`, and normalizeDomainForCache() strips `www.`, leaving
// `blogspot.com` — a public suffix. Every Blogger blog on the internet then
// matched, including Google's own Webmaster Central blog. `gob.mx`, listed
// bare, did the same for every Mexican government site.
//
// The old defence was a hand-written list of 30 CDN parents. It contained
// neither, because the set of namespaces anyone can register under is
// open-ended and a hand-written list cannot cover it.
//
// These tests use the real Public Suffix List and the real blocklist, so they
// fail if either the guard or the curation regresses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PS = require('../shared/public-suffix.js');
const POLICY = require('../shared/domain-policy.js');

const pslText = fs.readFileSync(path.join(ROOT, 'data', 'public-suffixes.txt'), 'utf8');
const psl = PS.parseList(pslText);
const blocklist = new Set(require('../blocklist.json'));

// The shipped lookup, reproduced against the real data.
//
// The guard REMOVES public-suffix entries from the effective set rather than
// skipping them during the parent walk: `gob.mx` is in the list literally, so
// an exact-match lookup hits before the walk runs.
const droppedSuffixes = PS.publicSuffixesAmong(blocklist, psl);
for (const intentional of POLICY.BLOCKED_PUBLIC_SUFFIXES) droppedSuffixes.delete(intentional);
const effective = new Set([...blocklist].filter(d => !droppedSuffixes.has(d)));
const sharedParents = new Set(POLICY.SHARED_HOST_PARENTS);

function lookup(hostname) {
  const normalized = String(hostname).trim().toLowerCase().replace(/^www\./, '');
  if (effective.has(normalized)) return true;
  const labels = normalized.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (sharedParents.has(candidate)) continue;
    if (effective.has(candidate)) return true;
  }
  return false;
}

test('a public suffix in the blocklist does not block everything under it', () => {
  const mustAllow = [
    ['google-webmaster-tools.blogspot.com', "Google's own blog"],
    ['mykitchenrecipes.blogspot.com', 'an ordinary cooking blog'],
    ['anything.blogspot.com', 'any Blogger blog at all'],
    ['gob.mx', 'the Mexican government homepage'],
    ['salud.gob.mx', 'the Mexican Ministry of Health'],
  ];
  for (const [host, why] of mustAllow) {
    assert.equal(lookup(host), false, `${host} must not be blocked — ${why}`);
  }
});

test('genuine adult hosts and their subdomains are still blocked', () => {
  for (const host of ['pornhub.com', 'cdn.pornhub.com', 'www.pornhub.com',
                      'xvideos.com', 'media.xhamster.com']) {
    assert.equal(lookup(host), true, `${host} must still be blocked`);
  }
});

test('public suffixes blocked on purpose still block wholesale', () => {
  // sex.hu / szex.hu are Hungarian adult second-level domains: the namespace
  // itself exists for adult content, so blocking every registration under it
  // is the intended outcome rather than collateral damage.
  for (const host of ['sex.hu', 'anything.sex.hu', 'szex.hu', 'foo.szex.hu']) {
    assert.equal(lookup(host), true, `${host} is an intentional wholesale block`);
  }
});

test('multi-tenant hosts the PSL does not name are still skipped', () => {
  // b-cdn.net is in the blocklist and is NOT a public suffix, so the PSL
  // cannot save us — the curated list has to. bunny.net serves a great many
  // ordinary sites.
  assert.ok(blocklist.has('b-cdn.net'),
    'b-cdn.net is in the blocklist, so this guard is load-bearing');
  assert.equal(lookup('somecustomer.b-cdn.net'), false,
    'a bunny.net customer must not be blocked by the parent entry');
  // ...unless it is listed in its own right.
  const listedChild = [...blocklist].find(d => d.endsWith('.b-cdn.net'));
  if (listedChild) {
    assert.equal(lookup(listedChild), true,
      `${listedChild} is listed explicitly and must still block`);
  }
});

test('the curated CDN list survives a failed public-suffix fetch', () => {
  // The PSL is fetched at runtime; when that fails the guard drops nothing.
  // The curated list is the floor underneath it, so it has to keep working on
  // its own — including for the names the PSL also covers. Trimming that
  // overlap "because the PSL covers it" made safe.cloudfront.net blockable
  // whenever the fetch failed.
  const noPsl = { exact: new Set(), wildcard: new Set(), exception: new Set() };
  const dropped = PS.publicSuffixesAmong(blocklist, noPsl);
  assert.equal(dropped.size, 0, 'with no PSL the guard must drop nothing');

  const parents = new Set(POLICY.SHARED_HOST_PARENTS);
  for (const host of ['cloudfront.net', 'b-cdn.net', 'github.io', 'pages.dev',
                      'amazonaws.com', 'googleapis.com']) {
    assert.ok(parents.has(host),
      `${host} must stay in SHARED_HOST_PARENTS — it is the fallback when the ` +
      'public suffix list cannot be loaded');
  }
});

test('every intentional wholesale block really is a public suffix', () => {
  // If one stops being a public suffix, it is just an ordinary blocklist entry
  // and the exception is dead weight that hides intent.
  for (const suffix of POLICY.BLOCKED_PUBLIC_SUFFIXES) {
    assert.ok(PS.isPublicSuffix(suffix, psl),
      `${suffix} is listed as an intentional suffix block but is not a public suffix`);
  }
});

test('the blocklist gains no new public suffixes unnoticed', () => {
  // A curation guard. If HOSTS.txt picks up a namespace, this names it so the
  // decision is made deliberately — block it wholesale by adding it to
  // BLOCKED_PUBLIC_SUFFIXES, or drop it from the list.
  assert.deepEqual([...droppedSuffixes].sort(), ['blogspot.com', 'gob.mx'],
    'the set of public suffixes in the blocklist changed. Each one blocks an ' +
    'entire namespace via parent matching, so decide deliberately: remove it ' +
    'from data/HOSTS.txt, or add it to BLOCKED_PUBLIC_SUFFIXES in ' +
    'shared/domain-policy.js. Found: ' + [...droppedSuffixes].join(', '));
});

test('the public suffix list itself parses to something plausible', () => {
  assert.ok(psl.exact.size > 5000, 'PSL looks truncated');
  assert.ok(psl.wildcard.size > 100, 'wildcard rules missing');
  assert.equal(PS.isPublicSuffix('com', psl), true);
  assert.equal(PS.isPublicSuffix('co.uk', psl), true);
  assert.equal(PS.isPublicSuffix('example.com', psl), false);
  // Exception rules invert a wildcard.
  assert.equal(PS.isPublicSuffix('www.ck', psl), false, '!www.ck is an exception');
});

// ---------------------------------------------------------------------------
// Against the real background lookup, not the reproduction above
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

test('the shipped isUrlInDefaultBlocklist honours the guard', async () => {
  const context = loadBackgroundContext();
  await context.backgroundInitializationPromise;

  // The shape that shipped: the namespace itself, plus one adult site that is
  // genuinely listed under it.
  vm.runInContext(
    "defaultBlocklistSet = new Set(['blogspot.com', 'someadultblog.blogspot.com', " +
    "'gob.mx', 'pornhub.com', 'sex.hu'])",
    context
  );
  await context.applyPublicSuffixGuard();

  assert.equal(context.isUrlInDefaultBlocklist('https://mykitchenrecipes.blogspot.com/'), false,
    'an ordinary Blogger blog must not be blocked by the blogspot.com entry');
  assert.equal(context.isUrlInDefaultBlocklist('https://www.gob.mx/salud'), false,
    'the Mexican Ministry of Health must not be blocked');
  assert.equal(context.isUrlInDefaultBlocklist('https://gob.mx/'), false,
    'nor the bare entry itself — it matches exactly, before the parent walk');

  assert.equal(context.isUrlInDefaultBlocklist('https://someadultblog.blogspot.com/'), true,
    'an explicitly listed adult blog must still be blocked');
  assert.equal(context.isUrlInDefaultBlocklist('https://cdn.pornhub.com/x.jpg'), true,
    'ordinary parent matching must be untouched');
  assert.equal(context.isUrlInDefaultBlocklist('https://anything.sex.hu/'), true,
    'an intentional wholesale suffix block still applies');
});
