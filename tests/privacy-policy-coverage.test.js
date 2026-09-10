// The privacy policy has to describe what the code actually does (audit
// finding H8).
//
// It had drifted in three ways, none of them visible from the document:
//   - it named `family.cloudflare-dns.com` as *the* DNS service, while four
//     presets plus a user-supplied endpoint ship, with automatic failover to a
//     resolver the user did not pick;
//   - rule-list subscriptions, which fetch arbitrary user-chosen URLs daily,
//     were absent entirely;
//   - so was the community stories feature, which sends free-text personal
//     recovery stories and a device identifier to our backend.
//
// Both stores treat an inaccurate data disclosure as a policy violation rather
// than a documentation bug, and this is a category that gets reviewed
// attentively. So the endpoints are asserted from the source, not from memory:
// add a new host to the code and this fails until the policy mentions it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const policy = fs.readFileSync(path.join(ROOT, 'PRIVACY_POLICY.md'), 'utf8');

// Files that can originate a network request at runtime.
const NETWORK_SOURCES = [
  'background.js', 'content.js', 'offscreen.js', 'appwrite-client.js',
  'community.js', 'options.js',
  path.join('shared', 'dns-providers.js'),
  path.join('shared', 'vit-classifier.js')
];

function remoteHosts() {
  const hosts = new Set();
  for (const file of NETWORK_SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      hosts.add(match[1].toLowerCase());
    }
  }
  return hosts;
}

// Hosts that appear in source but are not endpoints the extension calls:
// documentation links, redirect targets for SafeSearch lockdown, and the
// example URLs in comments.
const NOT_ENDPOINTS = new Set([
  'search.aol.com', 'www.qwant.com', 'presearch.com', 'reddit.com',
  'ublacklist.github.io', '4get.ca', 'example.com',
  'external-content.duckduckgo.com', 'github.com',
  'developer.mozilla.org', 'support.google.com', 'developer.chrome.com',
  'chromewebstore.google.com', 'addons.mozilla.org',
  'microsoftedge.microsoft.com', 'mzl.la'
]);

test('H8: every remote host the code calls is named in the privacy policy', () => {
  const undocumented = [...remoteHosts()]
    .filter(host => !NOT_ENDPOINTS.has(host))
    .filter(host => !policy.includes(host));

  assert.deepEqual(undocumented, [],
    'These hosts are contacted by the extension but appear nowhere in ' +
    'PRIVACY_POLICY.md:\n  ' + undocumented.join('\n  ') +
    '\nAdd them, or add them to NOT_ENDPOINTS if they are not really called.');
});

test('H8: all four DNS presets and the custom option are disclosed', () => {
  const DNS = require('../shared/dns-providers.js');
  for (const provider of DNS.DNS_PROVIDERS) {
    const host = new URL(provider.doh).hostname;
    assert.ok(policy.includes(host),
      `${provider.label} (${host}) ships as a resolver but is not in the policy`);
  }
  assert.match(policy, /custom/i, 'the custom DoH endpoint option must be disclosed');
  assert.match(policy, /fail(s|ed|ing)?[ -]?over|failover/i,
    'automatic failover sends hostnames to a resolver the user did not pick, ' +
    'so it has to be disclosed');
});

test('H8: features that send data off-device are each described', () => {
  const required = [
    [/subscri/i, 'rule list subscriptions fetch user-chosen URLs daily'],
    [/stor(y|ies)/i, 'community stories send free text and a device id to our backend'],
    [/version/i, 'the update check is a separate periodic request'],
    [/image/i, 'the image classifier re-requests image files'],
    [/device identifier|device ID/i, 'a persistent device identifier is sent with reports and stories'],
  ];
  for (const [pattern, why] of required) {
    assert.match(policy, pattern, `not disclosed: ${why}`);
  }
});

test('H8: the policy says the classifiers are off by default and local', () => {
  assert.match(policy, /never uploaded/i,
    'the strongest privacy property of the image classifier should be stated plainly');
  assert.match(policy, /opt-in|off by default|\*\*off\*\*/i,
    'the off-by-default posture of the classifiers should be stated');
});

test('H8: the policy is honest about how the PIN is stored', () => {
  // It is stored unhashed. Saying so is what stops someone reusing a PIN that
  // protects something else. See audit finding H6, still open.
  assert.match(policy, /plain form|not hashed|unhashed/i,
    'the PIN is stored unhashed; the policy should not imply otherwise');
});

test('H8: the policy still makes its core promises', () => {
  for (const promise of [
    /do not sell/i,
    /do not.{0,40}advertis/i,
    /no automatic background telemetry|do not send automatic background telemetry/i
  ]) {
    assert.match(policy, promise, 'a core commitment went missing in an edit');
  }
});
