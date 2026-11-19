const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reddit refuses /r/<sub>/about.json to signed-out visitors with an HTML 403
// ("You've been blocked by network security"), for SFW and NSFW subreddits
// alike. The check read that refusal as "not NSFW", so r/<nsfw-sub> loaded
// unblocked. Reddit does give the answer in the page it serves:
// <reddit-page-data data='{"subreddit":{"id":…,"isNsfw":true,…}}'>.

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function functionSource(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `${name} should exist`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// A document holding Reddit's page-data elements, as a subreddit page has them.
function redditDocument({ page, view } = {}) {
  const elements = {
    'reddit-page-data[data]': page,
    'shreddit-screenview-data[data]': view
  };
  return {
    querySelector(selector) {
      const data = elements[selector];
      if (data === undefined) return null;
      return { getAttribute: (name) => (name === 'data' ? (typeof data === 'string' ? data : JSON.stringify(data)) : null) };
    }
  };
}

const GONEWILD_PAGE = {
  page: { subreddit: { id: 't5_2qq5c', isNsfw: true } },
  view: { subreddit: { id: 't5_2qq5c', name: 'gonewild' } }
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}

function loadRedditCheck({ href = 'https://www.reddit.com/r/gonewild/', doc = redditDocument(), replies = [] } = {}) {
  const requests = [];
  const redirects = [];
  const sandbox = {
    Map, URL, Date, JSON, Promise, console,
    window: { location: { href } },
    document: doc,
    requests,
    redirects,
    async fetch(url) {
      requests.push(url);
      const next = replies.length ? replies.shift() : response(403, '<html>blocked</html>');
      if (next instanceof Error) throw next;
      return next;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let useSmartBlocking = true;
    let debugMode = false;
    let isEnabled = true;
    let blockedTriggered = false;
    const IS_TOP_FRAME = true;
    function log() {}
    async function isCurrentPageWhitelisted() { return false; }
    function redirectToBlockedPage(reason) { blockedTriggered = true; redirects.push(reason); }
    let redditNSFWCache = new Map();
    const REDDIT_CACHE_DURATION = 30 * 60 * 1000;
    let redditApiRefusedUntil = 0;
    const REDDIT_API_BACKOFF_MS = 10 * 60 * 1000;
    ${functionSource('isRedditURL')}
    ${functionSource('extractSubredditFromURL')}
    ${functionSource('readRedditPageNsfw')}
    ${functionSource('checkRedditSubredditNSFW')}
    ${functionSource('shouldBlockRedditPage')}
    ${functionSource('recheckRedditPage')}
    this.setSmartBlocking = (on) => { useSmartBlocking = on; };
    this.cacheSize = () => redditNSFWCache.size;
  `, sandbox);
  return sandbox;
}

// ─── Reddit's answer in the page ─────────────────────────────────────────────

test('the page data answers for the subreddit it names', () => {
  const ctx = loadRedditCheck();
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument(GONEWILD_PAGE)), true);
  assert.equal(ctx.readRedditPageNsfw('GoneWild', redditDocument(GONEWILD_PAGE)), true, 'names compare case-insensitively');
  assert.equal(ctx.readRedditPageNsfw('pics', redditDocument({
    page: { subreddit: { id: 't5_2qh0u', name: 'pics', isNsfw: false } }
  })), false);
});

test('page data about another subreddit is no answer', () => {
  // An in-app navigation can leave the previous page's data behind.
  const ctx = loadRedditCheck();
  assert.equal(ctx.readRedditPageNsfw('pics', redditDocument(GONEWILD_PAGE)), null);
  // A name from a different render (ids disagree) is not trusted either.
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument({
    page: { subreddit: { id: 't5_aaaaa', isNsfw: true } },
    view: { subreddit: { id: 't5_2qq5c', name: 'gonewild' } }
  })), null);
});

test('missing, malformed or nameless page data is no answer', () => {
  const ctx = loadRedditCheck();
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument()), null, 'not parsed yet');
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument({ page: '{"subreddit":' })), null, 'bad JSON');
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument({ page: { subreddit: { id: 't5_2qq5c', isNsfw: true } } })), null, 'no name anywhere');
  assert.equal(ctx.readRedditPageNsfw('gonewild', redditDocument({
    page: { subreddit: { id: 't5_2qq5c', name: 'gonewild' } }
  })), null, 'no isNsfw flag');
});

// ─── The check ───────────────────────────────────────────────────────────────

test('an NSFW subreddit page is blocked from its own page data, with no request', async () => {
  const ctx = loadRedditCheck({ doc: redditDocument(GONEWILD_PAGE) });
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), true);
  assert.deepEqual(ctx.requests, [], 'about.json is not asked when the page already says');
});

test('a refused about.json is unknown: not "not NSFW", not cached, not asked again at once', async () => {
  // The signed-out case: no page data yet (document_start), Reddit answers 403.
  const ctx = loadRedditCheck({ replies: [response(403, '<html>blocked by network security</html>')] });
  assert.equal(await ctx.checkRedditSubredditNSFW('gonewild'), null);
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), false);
  assert.equal(ctx.cacheSize(), 0, 'a refusal is never remembered as an answer');
  // Reddit refuses the client, not one subreddit: a feed must not send one
  // refused request per post.
  await ctx.checkRedditSubredditNSFW('pics');
  await ctx.checkRedditSubredditNSFW('aww');
  assert.equal(ctx.requests.length, 1, 'no further about.json while Reddit is refusing');
});

test('a refusal does not stop the page data from answering later', async () => {
  const ctx = loadRedditCheck({ replies: [response(403, '<html>blocked</html>')] });
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), false);
  ctx.document = redditDocument(GONEWILD_PAGE); // the page has now parsed
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), true);
});

test('about.json still answers when Reddit allows it, and the answer is cached', async () => {
  const ctx = loadRedditCheck({ replies: [response(200, { data: { over18: true } })] });
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), true);
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), true);
  assert.equal(ctx.requests.length, 1, 'served from cache the second time');
});

test('a network failure or an answer without over18 is unknown', async () => {
  const failed = loadRedditCheck({ replies: [new TypeError('NetworkError')] });
  assert.equal(await failed.checkRedditSubredditNSFW('gonewild'), null);
  const odd = loadRedditCheck({ replies: [response(200, { kind: 't5' })] });
  assert.equal(await odd.checkRedditSubredditNSFW('gonewild'), null);
  assert.equal(odd.cacheSize(), 0);
});

test('page data for another subreddit is not read for a link elsewhere', async () => {
  // On r/gonewild, a post linking r/pics must not borrow r/gonewild's answer.
  const ctx = loadRedditCheck({ doc: redditDocument(GONEWILD_PAGE), replies: [response(200, { data: { over18: false } })] });
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/pics/comments/abc/'), false);
  assert.deepEqual(ctx.requests, ['https://www.reddit.com/r/pics/about.json']);
});

test('smart blocking off asks nothing and blocks nothing', async () => {
  const ctx = loadRedditCheck({ doc: redditDocument(GONEWILD_PAGE) });
  ctx.setSmartBlocking(false);
  assert.equal(await ctx.shouldBlockRedditPage('https://www.reddit.com/r/gonewild/'), false);
  assert.deepEqual(ctx.requests, []);
});

// ─── Checking again once the page has parsed ─────────────────────────────────

test('the recheck redirects once the page data says NSFW', async () => {
  const ctx = loadRedditCheck({ doc: redditDocument(GONEWILD_PAGE) });
  assert.equal(await ctx.recheckRedditPage(), true);
  assert.deepEqual(ctx.redirects, ['reddit_nsfw']);
});

test('the recheck leaves SFW, non-subreddit and non-Reddit pages alone', async () => {
  const sfw = loadRedditCheck({
    href: 'https://www.reddit.com/r/pics/',
    doc: redditDocument({ page: { subreddit: { id: 't5_2qh0u', name: 'pics', isNsfw: false } } })
  });
  assert.equal(await sfw.recheckRedditPage(), false);
  const home = loadRedditCheck({ href: 'https://www.reddit.com/' });
  assert.equal(await home.recheckRedditPage(), false);
  const other = loadRedditCheck({ href: 'https://example.com/r/gonewild/', doc: redditDocument(GONEWILD_PAGE) });
  assert.equal(await other.recheckRedditPage(), false);
  for (const ctx of [sfw, home, other]) assert.deepEqual(ctx.redirects, []);
  assert.deepEqual(home.requests, []);
  assert.deepEqual(other.requests, []);
});

test('the recheck runs when the page has parsed and when Reddit renders new page data', () => {
  const domReady = /document\.addEventListener\('DOMContentLoaded',\s*\(\)\s*=>\s*\{[^}]*recheckRedditPage\(\)/;
  assert.match(source, domReady, 'DOMContentLoaded asks again');
  assert.match(source, /el\.tagName === 'REDDIT-PAGE-DATA'/, 'the observer notices a new <reddit-page-data>');
});

// ─── Posts ───────────────────────────────────────────────────────────────────

function loadSocialPostCheck() {
  const sandbox = { URL, window: { location: { href: 'https://www.reddit.com/' } } };
  vm.createContext(sandbox);
  vm.runInContext(`
    let useSmartBlocking = true;
    function isAdultURL() { return false; }
    function isHostInDefaultBlocklist() { return false; }
    function matchesAdultKeywordHost() { return false; }
    function containsAdultKeywords() { return false; }
    ${functionSource('shouldBlockSocialPost')}
    this.setSmartBlocking = (on) => { useSmartBlocking = on; };
  `, sandbox);
  return sandbox;
}

function shredditPost(attributes) {
  return {
    tagName: 'SHREDDIT-POST',
    textContent: 'A post title',
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name),
    getAttribute: (name) => attributes[name] ?? null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

test('current Reddit posts are matched and their nsfw mark is honoured', () => {
  const selectors = /reddit:\s*\{[\s\S]*?containers:\s*'([^']*)'/.exec(source);
  assert.ok(selectors, 'SOCIAL_SELECTORS.reddit should exist');
  assert.ok(selectors[1].split(',').map(s => s.trim()).includes('shreddit-post'), '<shreddit-post> is a post container');

  const ctx = loadSocialPostCheck();
  assert.equal(ctx.shouldBlockSocialPost(shredditPost({ nsfw: '' }), 'reddit'), true);
  assert.equal(ctx.shouldBlockSocialPost(shredditPost({}), 'reddit'), false);
  ctx.setSmartBlocking(false);
  assert.equal(ctx.shouldBlockSocialPost(shredditPost({ nsfw: '' }), 'reddit'), false);
});
