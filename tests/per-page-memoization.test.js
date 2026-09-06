const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// Pull one function's source out of content.js by brace-matching its body.
function fn(name) {
  const marker = new RegExp('(?:^|\\n)(?:async )?function ' + name + '\\s*\\(', 'm');
  const m = marker.exec(CONTENT);
  assert.ok(m, `function ${name} not found in content.js`);
  const start = m.index + (CONTENT[m.index] === '\n' ? 1 : 0);
  let i = CONTENT.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; i < CONTENT.length; i++) {
    if (CONTENT[i] === '{') depth++;
    else if (CONTENT[i] === '}') { depth--; if (depth === 0) break; }
  }
  return CONTENT.slice(start, i + 1);
}

// getSearchEngine() and getSocialSite() are called once per MutationObserver
// batch, which on a busy page is many times a second. getSearchEngine used to
// allocate a URLSearchParams per call; getSocialSite used to run two
// document-wide querySelector calls on every host that is not one of the three
// it knows. These tests pin that they now compute once and that the memo is
// invalidated when it must be.

function searchEngineSandbox(href) {
  const url = new URL(href);
  const sandbox = {
    URLSearchParams,
    calls: 0,
    window: { location: { get href() { return sandbox.window.location._href; },
                          _href: href,
                          hostname: url.hostname,
                          pathname: url.pathname,
                          search: url.search } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let _searchEngineHref = null;
    let _searchEngineValue = null;
    ${fn('getSearchEngine')}
    function computeSearchEngine() { calls++; return 'google'; }
    globalThis.getSearchEngine = getSearchEngine;
  `, sandbox);
  return sandbox;
}

test('getSearchEngine computes once per URL', () => {
  const sandbox = searchEngineSandbox('https://www.google.com/search?q=a');

  for (let i = 0; i < 50; i++) sandbox.getSearchEngine();

  assert.equal(sandbox.calls, 1, '50 mutation batches must not mean 50 query-string parses');
});

test('getSearchEngine recomputes when the URL changes', () => {
  const sandbox = searchEngineSandbox('https://www.google.com/search?q=a');
  sandbox.getSearchEngine();

  // A pushState that only changes the query still changes the vertical, which
  // is exactly how the search engines switch between web/images/video.
  sandbox.window.location._href = 'https://www.google.com/search?q=a&tbm=isch';
  sandbox.getSearchEngine();

  assert.equal(sandbox.calls, 2, 'a new href must invalidate the memo');
});

function socialSandbox() {
  const sandbox = { calls: 0 };
  vm.createContext(sandbox);
  vm.runInContext(`
    let _socialSiteCache;
    ${fn('getSocialSite')}
    ${fn('resetSocialSiteCache')}
    function computeSocialSite() { calls++; return null; }
    globalThis.getSocialSite = getSocialSite;
    globalThis.resetSocialSiteCache = resetSocialSiteCache;
  `, sandbox);
  return sandbox;
}

test('getSocialSite computes once, including when the answer is null', () => {
  const sandbox = socialSandbox();

  for (let i = 0; i < 50; i++) sandbox.getSocialSite();

  // null is the common case — every site that is not Reddit, X or Mastodon —
  // and it is the case that used to fall through to two document-wide queries.
  assert.equal(sandbox.calls, 1, 'a null verdict must be cached too, or nothing is saved');
});

test('resetSocialSiteCache lets a late generator meta tag be seen', () => {
  const sandbox = socialSandbox();
  sandbox.getSocialSite();
  sandbox.resetSocialSiteCache();
  sandbox.getSocialSite();

  assert.equal(sandbox.calls, 2);
});
