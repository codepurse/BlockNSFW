// Blocking a whole top-level domain. Requested by Maksim: some TLDs are used
// almost entirely for spam, and listing their sites one at a time is hopeless.
//
// The engine could already do this — a bare host entry covers its subdomains,
// and "xyz" is only the shortest case of that — but the form anyone actually
// reaches for, ".xyz", matched nothing at all and said nothing about it. Worse,
// it survived as far as the image-blocking rule as the literal domain ".xyz".
//
// Three layers read these entries and all three have to agree, so each is
// covered here: the shared rule, the navigation matcher, and the DNR rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DomainValidate = require('../shared/validate-domain.js');
const { loadBackgroundContext } = require('./setup.js');

// --- the shared rule --------------------------------------------------------

test('normalizeBlockHost: a leading dot is the same entry as none', () => {
  assert.equal(DomainValidate.normalizeBlockHost('.xyz'), 'xyz');
  assert.equal(DomainValidate.normalizeBlockHost('xyz'), 'xyz');
  assert.equal(DomainValidate.normalizeBlockHost('.example.com'), 'example.com');
  assert.equal(DomainValidate.normalizeBlockHost('  .XYZ.  '), 'xyz');
  assert.equal(DomainValidate.normalizeBlockHost('..tk'), 'tk');
  assert.equal(DomainValidate.normalizeBlockHost(''), '');
  assert.equal(DomainValidate.normalizeBlockHost(null), '');
});

test('isTldEntry: one label is a TLD, anything with a dot is a site', () => {
  assert.equal(DomainValidate.isTldEntry('.xyz'), true);
  assert.equal(DomainValidate.isTldEntry('tk'), true);
  assert.equal(DomainValidate.isTldEntry('example.com'), false);
  assert.equal(DomainValidate.isTldEntry('.example.com'), false);
  assert.equal(DomainValidate.isTldEntry(''), false);
  assert.equal(DomainValidate.isTldEntry('*.xyz'), false);
});

test('validateDomain still refuses a bare TLD', () => {
  // The whitelist and the trusted-image list share this validator. Allowing a
  // TLD to be *trusted* would be the opposite of what this feature is for.
  assert.equal(DomainValidate.validateDomain('xyz'), null);
  assert.equal(DomainValidate.validateDomain('example.com'), 'example.com');
});

// --- navigation, and the in-page matcher ------------------------------------

const HOSTS = ['spam.xyz', 'deep.sub.xyz', 'xyz', 'notxyz.com', 'example.com', 'sub.example.com'];

function loadContentMatcher() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} should exist`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`could not parse ${name}`);
  }

  const sandbox = {
    console, Map, Set, RegExp, Array, String,
    self: { DomainValidate },
    normalizeHost: (v) => String(v || '').trim().toLowerCase().replace(/^www\./, ''),
    // Only host-form entries are under test here; regex and title forms have
    // their own coverage.
    customPatternCompiled: () => ({ kind: 'host' })
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [functionSource('blockHostBase'), functionSource('customPatternsMatchHost')].join('\n') +
    '\nglobalThis.customPatternsMatchHost = customPatternsMatchHost;',
    sandbox
  );
  return (pattern) => HOSTS.filter(
    (host) => sandbox.customPatternsMatchHost(`https://${host}/a`, host, [pattern])
  );
}

function navigationMatches(ctx, pattern) {
  const regex = ctx.buildHostPatterns([pattern])[0];
  return HOSTS.filter((host) => regex && regex.test(`https://${host}/a`));
}

test('a TLD entry blocks every site under it, in both layers', () => {
  const inPage = loadContentMatcher();
  const ctx = loadBackgroundContext();
  const expected = ['spam.xyz', 'deep.sub.xyz', 'xyz'];

  for (const written of ['.xyz', 'xyz']) {
    assert.deepEqual(inPage(written), expected, `in-page: ${written}`);
    assert.deepEqual(navigationMatches(ctx, written), expected, `navigation: ${written}`);
  }
});

test('a TLD entry does not catch a site that merely ends with the letters', () => {
  // "notxyz.com" is the case that makes a naive endsWith() wrong.
  const inPage = loadContentMatcher();
  const ctx = loadBackgroundContext();
  assert.ok(!inPage('.xyz').includes('notxyz.com'));
  assert.ok(!navigationMatches(ctx, '.xyz').includes('notxyz.com'));
});

test('a leading dot on a site works too, and changes nothing about it', () => {
  const inPage = loadContentMatcher();
  const ctx = loadBackgroundContext();
  const expected = ['example.com', 'sub.example.com'];

  assert.deepEqual(inPage('.example.com'), expected);
  assert.deepEqual(inPage('example.com'), expected);
  assert.deepEqual(navigationMatches(ctx, '.example.com'), ['example.com', 'sub.example.com']);
});

// --- the image-blocking rule ------------------------------------------------

test('a TLD never becomes a requestDomains entry', () => {
  // requestDomains takes domains, not suffixes. ".xyz" used to reach the rule
  // verbatim, and one bad entry is enough to invalidate the single rule every
  // other blocked host shares.
  const ctx = loadBackgroundContext();
  const domains = Array.from(ctx.customPatternsToImageBlockDomains(['xyz', '.xyz', '.example.com', 'a.com']));
  assert.deepEqual(domains, ['example.com', 'a.com']);
  assert.ok(!domains.some((d) => d.startsWith('.')), 'no entry may start with a dot');
});
