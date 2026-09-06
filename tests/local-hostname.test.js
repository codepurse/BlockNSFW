// Regression tests for the local-hostname exemption in the DNS layer.
//
// The bug: turning on DNS Protection blocked every local development server,
// on every load, for as long as it stayed on. Nothing in the blocklist or the
// keyword filter was involved — the DNS check did it alone. A filtering
// resolver signals a block three ways, one of which is NXDOMAIN, and a
// *public* resolver returns NXDOMAIN for every name that does not exist in
// public DNS: `localhost`, `app.test`, `nas.local`, an intranet short name, a
// bare IP. So the answer to "is localhost:3000 filtered?" was always yes.
//
// The fix is to never ask. These tests pin down all three parts of that: the
// predicate, the coupling that made the answer wrong, and the two entry points
// that must refuse to query.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { isLocalHostname, isIpLiteral } = require('../shared/hostname.js');
const { interpret } = require('../shared/dns-providers.js');
const { loadBackgroundContext } = require('./setup.js');

const LOCAL_HOSTS = [
  'localhost',            // the whole point
  'LOCALHOST.',           // case, and the fully-qualified trailing dot
  'dev.localhost',        // RFC 6761 reserves the subtree, not just the label
  'myapp.test',
  'nas.local',            // mDNS
  'wiki.internal',
  'router.home.arpa',
  'buildbox',             // a bare intranet label resolves nowhere public
  '127.0.0.1',
  '127.1.2.3',            // all of 127/8 is loopback, not just .0.1
  '0.0.0.0',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.10',
  '169.254.7.7',          // link-local
  '::1',
  '[::1]',                // URL.hostname keeps the brackets
  'fd00::1',              // unique local
  'fe80::1'               // link-local
];

const PUBLIC_NAMES = [
  'example.com',
  'pornhub.com',
  'tester.com',           // "test" is reserved only as a whole label
  'contest.example.org',
  'my.testing.com'
];

// Routable addresses: not local, but still not something to ask a resolver
// about, because there is no name here to look up. They sit in their own list
// because they answer the two questions differently.
const PUBLIC_IPS = [
  '172.15.0.1',           // just below the private 172.16/12 block
  '172.32.0.1',           // just above it
  '8.8.8.8',
  '2606:4700::1111'
];

test('isLocalHostname recognizes every shape of non-public host', () => {
  for (const host of LOCAL_HOSTS) {
    assert.equal(isLocalHostname(host), true, `${host} should be local`);
  }
});

test('isLocalHostname does not overreach into public names', () => {
  for (const host of [...PUBLIC_NAMES, ...PUBLIC_IPS]) {
    assert.equal(isLocalHostname(host), false, `${host} should be public`);
  }
  assert.equal(isLocalHostname(''), false);
  assert.equal(isLocalHostname(null), false);
});

test('isIpLiteral separates addresses from names', () => {
  for (const host of ['127.0.0.1', '8.8.8.8', '::1', '[::1]', '2606:4700::1111']) {
    assert.equal(isIpLiteral(host), true, `${host} is an address`);
  }
  for (const host of ['localhost', 'example.com', '', null]) {
    assert.equal(isIpLiteral(host), false, `${host} is not an address`);
  }
});

// This is the coupling that turned a harmless-looking DNS check into a
// dev-environment outage. It is correct on its own terms — Mullvad really does
// signal a block with NXDOMAIN — which is exactly why the guard has to live at
// the call site rather than in interpret().
test('NXDOMAIN reads as blocked, which is why local names must never be queried', () => {
  assert.equal(interpret(3, []), true);
});

// Loading the worker kicks off its own background fetches (blocklist, update
// check), so counting every call would be counting the wrong thing. Only the
// resolver endpoints matter here.
function recordDohRequests(ctx) {
  const urls = [];
  ctx.fetch = (url) => {
    if (String(url).includes('dns-query') || String(url).includes('/doh/')) urls.push(String(url));
    return Promise.reject(new Error('no network in tests'));
  };
  return urls;
}

test('checkDnsFilter answers "not blocked" for a local host without querying anyone', async () => {
  const ctx = loadBackgroundContext();
  const dohRequests = recordDohRequests(ctx);

  for (const host of ['localhost', 'dev.localhost', 'myapp.test', '127.0.0.1', '192.168.1.10', '::1']) {
    // false, not null: "no DNS filter blocks this" is a definite verdict for a
    // local name, and shouldBlock caches only definite verdicts.
    assert.equal(await ctx.checkDnsFilter(host, 'cloudflare'), false, `${host} should be answered false`);
  }
  assert.deepEqual(dohRequests, [], 'no resolver should have been contacted');
});

test('checkDnsFilter still queries the resolvers for a public host', async () => {
  const ctx = loadBackgroundContext();
  const dohRequests = recordDohRequests(ctx);

  // Both providers fail, so the verdict is null ("nobody answered"). The point
  // here is that the guard did not swallow the lookup.
  assert.equal(await ctx.checkDnsFilter('pornhub.com', 'cloudflare'), null);
  assert.ok(dohRequests.length > 0, 'a public host must still reach a resolver');
});

test('the background guard survives the shared helper failing to load', () => {
  const ctx = loadBackgroundContext();
  // importScripts is wrapped in try/catch, so HostnameNormalize can legitimately
  // be missing. The fallback must not reopen the hole.
  ctx.HostnameNormalize = undefined;
  for (const host of [...LOCAL_HOSTS, ...PUBLIC_IPS]) {
    assert.equal(ctx.isDnsCheckableHost(host), false, `${host} must not be queried`);
  }
  for (const host of PUBLIC_NAMES) {
    assert.equal(ctx.isDnsCheckableHost(host), true, `${host} should be queried`);
  }
});

test('the background guard and the shared helper agree on every host', () => {
  const ctx = loadBackgroundContext();
  const withFallback = loadBackgroundContext();
  withFallback.HostnameNormalize = undefined;
  for (const host of [...LOCAL_HOSTS, ...PUBLIC_IPS, ...PUBLIC_NAMES]) {
    assert.equal(
      ctx.isDnsCheckableHost(host),
      withFallback.isDnsCheckableHost(host),
      `${host} is classified differently by the fallback`
    );
  }
});

// --- content script -------------------------------------------------------
// content.js asks the background for a DNS verdict at document_start. It skips
// that round trip for local pages using its own copy of the predicate, so that
// copy needs the same coverage — including its no-shared-module fallback.

const CONTENT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function contentFunctionSource(name) {
  const start = CONTENT_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  let depth = 0;
  for (let index = CONTENT_SOURCE.indexOf('{', start); index < CONTENT_SOURCE.length; index++) {
    if (CONTENT_SOURCE[index] === '{') depth++;
    if (CONTENT_SOURCE[index] === '}') depth--;
    if (depth === 0) return CONTENT_SOURCE.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function loadContentHostHelpers({ withSharedModule, hostname = 'page.example' }) {
  const sandbox = {
    normalizeHost: value => String(value || '').trim().toLowerCase().replace(/^www\./, ''),
    HostnameNormalize: withSharedModule ? require('../shared/hostname.js') : undefined,
    window: { location: { hostname } },
    RegExp,
    String
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${contentFunctionSource('hostIsLocal')}
    ${contentFunctionSource('hostIsIpLiteral')}
    ${contentFunctionSource('isDnsCheckableHost')}
    let _localPageCache = null;
    ${contentFunctionSource('isLocalPage')}
  `, sandbox, { filename: 'content.js' });
  return sandbox;
}

for (const withSharedModule of [true, false]) {
  const label = withSharedModule ? 'via the shared module' : 'via its fallback';

  test(`content.js skips the DNS round trip for a local page ${label}`, () => {
    const { isDnsCheckableHost } = loadContentHostHelpers({ withSharedModule });
    for (const host of [...LOCAL_HOSTS, ...PUBLIC_IPS]) {
      assert.equal(isDnsCheckableHost(host), false, `${host} must not be queried`);
    }
    for (const host of PUBLIC_NAMES) {
      assert.equal(isDnsCheckableHost(host), true, `${host} should be queried`);
    }
  });

  test(`content.js recognizes a local host ${label}`, () => {
    const { hostIsLocal } = loadContentHostHelpers({ withSharedModule });
    for (const host of LOCAL_HOSTS) {
      assert.equal(hostIsLocal(host), true, `${host} should be local`);
    }
    // A routable address is not local: it can serve anything, so the heuristic
    // scans must still run there.
    for (const host of [...PUBLIC_NAMES, ...PUBLIC_IPS]) {
      assert.equal(hostIsLocal(host), false, `${host} should not be local`);
    }
  });
}

test('isLocalPage reads the page host and is memoized', () => {
  const local = loadContentHostHelpers({ withSharedModule: true, hostname: 'localhost' });
  assert.equal(local.isLocalPage(), true);
  // Memoized: a second call must not re-read a host that cannot change without
  // a navigation. Move the hostname and the answer should stand.
  local.window.location.hostname = 'example.com';
  assert.equal(local.isLocalPage(), true);

  const remote = loadContentHostHelpers({ withSharedModule: true, hostname: 'example.com' });
  assert.equal(remote.isLocalPage(), false);

  const privateIp = loadContentHostHelpers({ withSharedModule: true, hostname: '192.168.1.10' });
  assert.equal(privateIp.isLocalPage(), true);

  // A public IP page is not local.
  const publicIp = loadContentHostHelpers({ withSharedModule: true, hostname: '8.8.8.8' });
  assert.equal(publicIp.isLocalPage(), false);
});

// The three heuristic scans infer what an unknown site is about from a few
// keywords, which is meaningless on localhost. checkPageMetadata in particular
// blocks on a *single* keyword in the title or meta tags, which is what put
// every dev page on the blocked page. If one of these guards is ever removed,
// that regression comes straight back, so each is asserted by name.
for (const fn of ['checkPageMetadata', 'checkPageBodyText', 'checkPageTextWithModel']) {
  test(`${fn} skips local pages`, () => {
    assert.match(
      contentFunctionSource(fn),
      /if \(isLocalPage\(\)\) return false;/,
      `${fn} must bail out on a local page`
    );
  });
}

// Explicitly NOT exempted, so a rule the user wrote themselves still applies on
// localhost, and images are still judged on the picture rather than on a word.
for (const fn of ['checkCustomTitlePatterns', 'shouldBlockImage']) {
  test(`${fn} still runs on local pages`, () => {
    assert.doesNotMatch(
      contentFunctionSource(fn),
      /isLocalPage\(\)/,
      `${fn} should not have been exempted`
    );
  });
}

test('the metadata block names the keyword that fired', () => {
  // It used to pass no detail at all, so the blocked page could only say "its
  // title or metadata matched" — undiagnosable, and the reason this bug took a
  // second round to find.
  assert.match(
    contentFunctionSource('checkPageMetadata'),
    /redirectToBlockedPage\('metadata_scan', \{ matched:/,
    'metadata_scan must report its matched keywords like page_text_scan does'
  );
});
