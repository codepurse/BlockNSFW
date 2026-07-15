// Tests for path-scoped whitelisting: the shared parse/normalize/match helpers
// in shared/validate-domain.js, plus the end-to-end isWhitelisted() gate in
// background.js. A bug here would either block a page the user explicitly
// allowed (e.g. reddit.com/r/NoFap) or — worse — allow a path the user did NOT
// whitelist because a scoped entry leaked into whole-domain behavior.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWhitelistPath,
  whitelistPathMatches,
  parseWhitelistInput,
} = require('../shared/validate-domain.js');

const { loadBackgroundContext } = require('./setup.js');

// --- normalizeWhitelistPath --------------------------------------------------

test('normalizeWhitelistPath: root / empty / non-string collapse to null (whole-domain)', () => {
  assert.equal(normalizeWhitelistPath(''), null);
  assert.equal(normalizeWhitelistPath('/'), null);
  assert.equal(normalizeWhitelistPath('   '), null);
  assert.equal(normalizeWhitelistPath(null), null);
  assert.equal(normalizeWhitelistPath(undefined), null);
});

test('normalizeWhitelistPath: lowercases and adds leading + trailing slash', () => {
  assert.equal(normalizeWhitelistPath('/r/NoFap'), '/r/nofap/');
  assert.equal(normalizeWhitelistPath('r/NoFap/'), '/r/nofap/');
  assert.equal(normalizeWhitelistPath('/R/NoFap/'), '/r/nofap/');
});

test('normalizeWhitelistPath: strips query and fragment', () => {
  assert.equal(normalizeWhitelistPath('/r/NoFap?sort=new'), '/r/nofap/');
  assert.equal(normalizeWhitelistPath('/r/NoFap#top'), '/r/nofap/');
});

// --- whitelistPathMatches ----------------------------------------------------

test('whitelistPathMatches: null stored path matches any page (whole domain)', () => {
  assert.equal(whitelistPathMatches('/anything/here', null), true);
  assert.equal(whitelistPathMatches('/', null), true);
});

test('whitelistPathMatches: exact and descendant paths match', () => {
  assert.equal(whitelistPathMatches('/r/NoFap', '/r/nofap/'), true);
  assert.equal(whitelistPathMatches('/r/NoFap/', '/r/nofap/'), true);
  assert.equal(whitelistPathMatches('/r/NoFap/comments/abc', '/r/nofap/'), true);
});

test('whitelistPathMatches: respects segment boundary (no prefix leak)', () => {
  // "/r/nofap/" must NOT allow the different subreddit "/r/nofapville".
  assert.equal(whitelistPathMatches('/r/NoFapVille', '/r/nofap/'), false);
  assert.equal(whitelistPathMatches('/r/nsfw', '/r/nofap/'), false);
  assert.equal(whitelistPathMatches('/', '/r/nofap/'), false);
});

// --- parseWhitelistInput -----------------------------------------------------

test('parseWhitelistInput: bare domain -> no path', () => {
  assert.deepEqual(parseWhitelistInput('reddit.com'), { domain: 'reddit.com', path: null });
});

test('parseWhitelistInput: domain + path', () => {
  assert.deepEqual(parseWhitelistInput('old.reddit.com/r/NoFap/'), {
    domain: 'old.reddit.com',
    path: '/r/nofap/',
  });
});

test('parseWhitelistInput: full URL with scheme and www', () => {
  assert.deepEqual(parseWhitelistInput('https://www.reddit.com/r/NoFap'), {
    domain: 'reddit.com',
    path: '/r/nofap/',
  });
});

test('parseWhitelistInput: trailing-slash-only path is whole domain', () => {
  assert.deepEqual(parseWhitelistInput('reddit.com/'), { domain: 'reddit.com', path: null });
});

test('parseWhitelistInput: invalid host -> null', () => {
  assert.equal(parseWhitelistInput('not a domain !!'), null);
  assert.equal(parseWhitelistInput(''), null);
  assert.equal(parseWhitelistInput('   '), null);
});

// --- isWhitelisted() end-to-end (background.js gate) --------------------------

// Load background once, then swap the storage stub per assertion.
const ctx = loadBackgroundContext();

function withWhitelist(entries, fn) {
  ctx.chrome.storage.local.get = () => Promise.resolve({ pblocker_whitelist: entries });
  ctx.chrome.storage.local.set = () => Promise.resolve();
  return fn();
}

test('isWhitelisted: path-scoped entry allows the scoped path only', async () => {
  const entry = { domain: 'reddit.com', path: '/r/nofap/', type: 'permanent', addedAt: 1, expiresAt: null };
  await withWhitelist([entry], async () => {
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/r/NoFap/'), true);
    assert.equal(await ctx.isWhitelisted('https://old.reddit.com/r/NoFap/comments/x'), true);
    // Same host, different (NSFW) subreddit -> still blocked.
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/r/nsfw'), false);
    // Same host, root -> still blocked.
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/'), false);
  });
});

test('isWhitelisted: whole-domain entry (no path) allows everything on host', async () => {
  const entry = { domain: 'reddit.com', path: null, type: 'permanent', addedAt: 1, expiresAt: null };
  await withWhitelist([entry], async () => {
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/r/nsfw'), true);
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/'), true);
  });
});

test('isWhitelisted: legacy entry without a path field behaves as whole-domain', async () => {
  // Entries created before this feature have no `path` key at all.
  const entry = { domain: 'reddit.com', type: 'permanent', addedAt: 1, expiresAt: null };
  await withWhitelist([entry], async () => {
    assert.equal(await ctx.isWhitelisted('https://www.reddit.com/r/nsfw'), true);
  });
});

test('isWhitelisted: whole-domain and scoped entries for same host coexist', async () => {
  const scoped = { domain: 'reddit.com', path: '/r/nofap/', type: 'permanent', addedAt: 1, expiresAt: null };
  const other = { domain: 'example.com', path: null, type: 'permanent', addedAt: 1, expiresAt: null };
  await withWhitelist([scoped, other], async () => {
    assert.equal(await ctx.isWhitelisted('https://reddit.com/r/nofap/'), true);
    assert.equal(await ctx.isWhitelisted('https://reddit.com/r/nsfw'), false);
    assert.equal(await ctx.isWhitelisted('https://example.com/anything'), true);
  });
});
