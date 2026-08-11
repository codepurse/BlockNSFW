const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function loadHostCheckContext(hostname = 'page.example') {
  const messages = [];
  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    URL,
    setTimeout,
    clearTimeout,
    window: {
      location: {
        href: `https://${hostname}/path`,
        hostname
      }
    },
    nextResponse: { success: true, blockedHosts: [] }
  };
  sandbox.browserAPI = {
    runtime: {
      sendMessage(message, callback) {
        messages.push(message);
        setTimeout(() => callback(sandbox.nextResponse), 0);
      }
    }
  };
  sandbox.normalizeHost = value => String(value || '').trim().toLowerCase().replace(/^www\./, '');
  sandbox.DEFAULT_BLOCKLIST_HOSTS_EARLY = [];
  sandbox.hostMatchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  sandbox.matchesAdultKeywordHost = () => false;
  sandbox.isLikelyAdultHostEarly = () => false;
  sandbox.messages = messages;

  vm.createContext(sandbox);
  vm.runInContext(`
    const backgroundBlocklistHostCache = new Map();
    const pendingBackgroundHostChecks = new Map();
    let backgroundHostCheckTimer = null;
    const BACKGROUND_HOST_CACHE_MAX = 5000;
    ${functionSource('isHostInDefaultBlocklist')}
    let _cleanPageHostCache = null;
    ${functionSource('isCleanPageHost')}
    ${source.slice(
      source.indexOf('function sendRuntimeMessageForResponse('),
      source.indexOf('// Check if current page hostname is whitelisted')
    )}
    ${functionSource('hasBackgroundBlockedLink')}
  `, sandbox);
  return sandbox;
}

test('host checks across many linked elements coalesce into one background message', async () => {
  const context = loadHostCheckContext();
  context.nextResponse = { success: true, blockedHosts: ['asset-7.invalid'] };
  const elements = Array.from({ length: 40 }, (_, elementIndex) => ({
    querySelectorAll: () => Array.from({ length: 3 }, (_, linkIndex) => {
      const hostIndex = (elementIndex * 3 + linkIndex) % 32;
      return {
        href: `https://asset-${hostIndex}.invalid/item`,
        getAttribute: () => null
      };
    })
  }));

  const verdicts = await Promise.all(elements.map(context.hasBackgroundBlockedLink));

  assert.equal(verdicts.some(Boolean), true);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].hosts.length, 32);
});

test('a failed host check does not cache a clean verdict', async () => {
  const context = loadHostCheckContext();
  context.nextResponse = null;

  assert.equal(await context.isUrlBlockedByBackground('https://retry.example/first'), false);
  assert.equal(vm.runInContext("backgroundBlocklistHostCache.has('retry.example')", context), false);

  context.nextResponse = { success: true, blockedHosts: ['retry.example'] };
  assert.equal(await context.isUrlBlockedByBackground('https://retry.example/second'), true);
  assert.equal(context.messages.length, 2);
});

test('warming the current page host prevents a blocklisted page being memoized clean', async () => {
  const context = loadHostCheckContext('listed.example');
  context.nextResponse = { success: true, blockedHosts: ['listed.example'] };

  await context.warmCurrentPageBlocklistHost();

  assert.equal(context.isCleanPageHost(), false);
  assert.equal(context.messages.length, 1);
});
