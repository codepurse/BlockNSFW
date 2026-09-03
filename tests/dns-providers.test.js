// Tests for shared/dns-providers.js — the multi-resolver DoH client behind
// DNS Protection.
//
// Everything here is offline. The wireformat codec is exercised against packets
// captured from the live resolvers rather than by hitting the network, so CI
// does not depend on four third-party services being up.
//
// The behaviours worth pinning down, all of which are ways this layer can fail
// *silently* rather than loudly:
//
//   1. AdGuard signals a block with its own block-page IP, not a sinkhole. Read
//      naively that is NOERROR + a routable address, i.e. "not blocked", and
//      the whole filter passes adult domains through while looking healthy.
//   2. A failed lookup must be null, never false. Collapsing the two makes an
//      outage indistinguishable from a clean bill of health.
//   3. Mullvad answers NXDOMAIN, Cloudflare and CleanBrowsing sinkhole. All
//      three shapes have to read as blocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DNS_PROVIDERS,
  getProvider,
  getProviderOrDefault,
  getFallbackProvider,
  encodeQuery,
  decodeResponse,
  toBase64Url,
  interpret,
} = require('../shared/dns-providers.js');

const toArrayBuffer = (hex) => {
  const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
};

test('every listed provider is queryable and self-describing', () => {
  assert.ok(DNS_PROVIDERS.length >= 2, 'failover needs at least two providers');
  for (const provider of DNS_PROVIDERS) {
    assert.match(provider.doh, /^https:\/\//, `${provider.id} must be HTTPS`);
    assert.ok(['json', 'wire'].includes(provider.mode), `${provider.id} mode`);
    // Both strings are rendered in the options dropdown, so a missing one ships
    // as a blank line in the UI rather than throwing anywhere.
    assert.ok(provider.label && provider.blocks && provider.note, `${provider.id} copy`);
  }
});

test('resolvers whose terms forbid third-party querying are not in the roster', () => {
  // OpenDNS/Cisco forbid "providing the functionality of the DNS Service to any
  // third party", and Control D forbids transferring the service without
  // written authorization. Both are fine for a user to set on their own device
  // and we suggest them in onboarding — but the extension must not query them.
  const ids = DNS_PROVIDERS.map((p) => p.id);
  for (const forbidden of ['opendns', 'familyshield', 'controld', 'nextdns']) {
    assert.ok(!ids.includes(forbidden), `${forbidden} must not be queried by us`);
  }
});

test('an unknown or missing provider id falls back to the default', () => {
  assert.equal(getProvider('nope'), null);
  assert.equal(getProviderOrDefault('nope').id, 'cloudflare');
  assert.equal(getProviderOrDefault(undefined).id, 'cloudflare');
});

test('the fallback is always a different provider than the primary', () => {
  for (const provider of DNS_PROVIDERS) {
    const fallback = getFallbackProvider(provider.id);
    assert.ok(fallback, `${provider.id} needs a partner`);
    assert.notEqual(fallback.id, provider.id, `${provider.id} cannot fall back to itself`);
  }
});

test('encodeQuery builds a well-formed A query', () => {
  const packet = encodeQuery('example.com');
  assert.equal(packet[0], 0, 'ID stays 0 so identical GETs share an HTTP cache entry');
  assert.equal(packet[1], 0);
  assert.equal(packet[2], 0x01, 'recursion desired');
  assert.equal(packet[5], 0x01, 'exactly one question');
  // 12-byte header + 7"example" + 3"com" + root + QTYPE + QCLASS
  assert.equal(packet.length, 12 + 8 + 4 + 1 + 4);
  assert.equal(packet[12], 7);
  assert.equal(String.fromCharCode(...packet.slice(13, 20)), 'example');
  assert.equal(packet[20], 3);
  assert.equal(String.fromCharCode(...packet.slice(21, 24)), 'com');
  assert.equal(packet[24], 0, 'root label');
  assert.deepEqual([...packet.slice(25)], [0x00, 0x01, 0x00, 0x01], 'A / IN');
});

test('a trailing dot on the hostname does not produce an empty label', () => {
  assert.deepEqual([...encodeQuery('example.com.')], [...encodeQuery('example.com')]);
});

test('base64url output is URL-safe and unpadded', () => {
  const encoded = toBase64Url(encodeQuery('example.com'));
  assert.ok(!/[+/=]/.test(encoded), 'no +, / or = may appear in a query string');
  assert.equal(encoded, 'AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE');
});

test('decodeResponse reads a normal answer', () => {
  // Real Cloudflare reply for example.com, one A record.
  const packet =
    '0000818000010001000000000765786' +
    '16d706c6503636f6d0000010001c00c' +
    '000100010000012c000468146417';
  assert.deepEqual(decodeResponse(toArrayBuffer(packet)), {
    rcode: 0,
    addresses: ['104.20.100.23'],
  });
});

test('decodeResponse reads NXDOMAIN, the shape Mullvad uses to block', () => {
  const packet = '000081830001000000000000077' + '06f726e687562' + '03636f6d0000010001';
  const decoded = decodeResponse(toArrayBuffer(packet.replace(/\s/g, '')));
  assert.equal(decoded.rcode, 3);
  assert.deepEqual(decoded.addresses, []);
});

test('a truncated packet throws rather than reporting "not blocked"', () => {
  // Half a header. Returning {rcode:0, addresses:[]} here would read as a clean
  // domain; the caller has to see this as a failed lookup instead.
  assert.throws(() => decodeResponse(toArrayBuffer('000081800001')));
});

test('interpret: NXDOMAIN means blocked', () => {
  assert.equal(interpret(3, []), true);
});

test('interpret: sinkhole addresses mean blocked', () => {
  assert.equal(interpret(0, ['0.0.0.0']), true);
  assert.equal(interpret(0, ['127.0.0.1']), true);
});

test("interpret: AdGuard's block-page IP means blocked, not resolved", () => {
  const adguard = getProvider('adguard');
  assert.ok(adguard.blockedIps.includes('94.140.14.35'));
  // The regression this guards: without provider.blockedIps this is NOERROR
  // plus a routable address, so AdGuard reads as "nothing is ever blocked" and
  // the DNS layer quietly does nothing at all.
  assert.equal(interpret(0, ['94.140.14.35'], adguard.blockedIps), true);
  assert.equal(interpret(0, ['94.140.14.35']), false, 'only AdGuard treats this IP as a block');
});

test('interpret: a real address means the domain resolved normally', () => {
  assert.equal(interpret(0, ['104.20.100.23']), false);
  assert.equal(interpret(0, ['104.20.100.23'], ['94.140.14.35']), false);
});

test('interpret: SERVFAIL is "no answer", never "safe"', () => {
  // 2 = SERVFAIL, 5 = REFUSED. Both mean the resolver did not answer the
  // question. Returning false here would cache a domain as clean because the
  // resolver was struggling.
  assert.equal(interpret(2, []), null);
  assert.equal(interpret(5, []), null);
});

test('interpret: NOERROR with no A records is not a block', () => {
  // CNAME-only or IPv6-only hosts legitimately answer this way.
  assert.equal(interpret(0, []), false);
});

// --- Custom resolvers -------------------------------------------------------
// A typed-in DoH endpoint. The risks here are different from the presets': the
// value is user input rather than a constant, so it can be malformed, insecure,
// or carry its own query string.

const {
  CUSTOM_PROVIDER_ID,
  resolveProvider,
  makeCustomProvider,
  validateCustomDohUrl,
  withQuery,
} = require('../shared/dns-providers.js');

test('a custom address must be https', () => {
  // Plaintext DoH would put the user's browsing history on the wire in clear,
  // which is worse than not running the check at all.
  assert.equal(validateCustomDohUrl('http://dns.example.com/dns-query').ok, false);
  assert.equal(validateCustomDohUrl('https://dns.example.com/dns-query').ok, true);
});

test('a custom address is rejected when it cannot be a resolver', () => {
  for (const bad of ['', '   ', 'not a url', 'https://localhost/dns-query', 'ftp://x.example.com']) {
    const result = validateCustomDohUrl(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} should be rejected`);
    assert.ok(result.error, 'a rejection must explain itself to the user');
  }
});

test('credentials embedded in the address are rejected', () => {
  // https://user:pass@host/ would ship the credentials on every lookup.
  assert.equal(validateCustomDohUrl('https://user:pw@dns.example.com/dns-query').ok, false);
});

test('a custom provider speaks wireformat, never the JSON dialect', () => {
  // JSON is a Cloudflare/Google extra that most resolvers do not implement.
  // Guessing it would look exactly like "your resolver is broken".
  const provider = makeCustomProvider('https://dns.nextdns.io/abc123');
  assert.equal(provider.mode, 'wire');
  assert.equal(provider.id, CUSTOM_PROVIDER_ID);
  assert.equal(provider.custom, true);
});

test('a broken custom URL degrades to the default rather than to no DNS', () => {
  assert.equal(resolveProvider(CUSTOM_PROVIDER_ID, 'garbage').id, 'cloudflare');
  assert.equal(resolveProvider(CUSTOM_PROVIDER_ID, '').id, 'cloudflare');
  assert.equal(resolveProvider(CUSTOM_PROVIDER_ID, undefined).id, 'cloudflare');
  assert.equal(resolveProvider('mullvad', 'ignored').id, 'mullvad');
});

test('a custom resolver has no fallback, by design', () => {
  // Someone who typed in their own endpoint chose who sees their browsing.
  // Silently failing over to Cloudflare would override that without telling
  // them, so a custom resolver that fails yields no opinion at all.
  assert.equal(getFallbackProvider(CUSTOM_PROVIDER_ID), null);
  assert.ok(getFallbackProvider('cloudflare'), 'presets still fail over');
});

test('the query string is appended with the right separator', () => {
  // NextDNS-style endpoints carry no query; some custom ones do. Appending
  // "?dns=" to a URL that already has a "?" yields a request servers reject.
  assert.equal(withQuery('https://x.example.com/dns-query', 'dns=AAA'),
    'https://x.example.com/dns-query?dns=AAA');
  assert.equal(withQuery('https://x.example.com/dns-query?profile=kids', 'dns=AAA'),
    'https://x.example.com/dns-query?profile=kids&dns=AAA');
});
