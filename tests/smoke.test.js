// Smoke test for the test infrastructure: load background.js and check that
// the pure functions we plan to test are reachable in the sandbox context.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

test('background.js loads in sandbox and exposes pure functions', () => {
  const ctx = loadBackgroundContext();
  for (const name of [
    'parseHostsFile',
    'parseWhitelistFile',
    'chunkArray',
    'patternToRegex',
    'isLikelyDomain',
    'normalizeDomainForCache',
    'isHttpUrl',
    'isTrustedImageDomain',
    'isSharedCDNParent',
    'filterSharedCDNParents',
    'isInRemoteWhitelist',
    'buildHostPatterns'
  ]) {
    assert.equal(typeof ctx[name], 'function', `${name} should be a function`);
  }
});
