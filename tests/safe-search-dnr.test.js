// SafeSearch must be enforced before page JavaScript runs. These tests cover
// the browser-network rules, particularly DuckDuckGo's dedicated safe host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();
const rules = JSON.parse(JSON.stringify(ctx.buildSafeSearchRules()));

function rule(id) {
  return rules.find(candidate => candidate.id === id);
}

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function contentConstArraySource(name) {
  const start = contentSource.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = contentSource.indexOf('];', start);
  assert.notEqual(end, -1, `${name} should have an array terminator`);
  return contentSource.slice(start, end + 2);
}

function contentFunctionSource(name) {
  const start = contentSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = contentSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < contentSource.length; index++) {
    if (contentSource[index] === '{') depth++;
    if (contentSource[index] === '}') depth--;
    if (depth === 0) return contentSource.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function detectedSearchEngine(url) {
  const parsed = new URL(url);
  const sandbox = {
    URLSearchParams,
    window: {
      location: {
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        search: parsed.search
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${contentConstArraySource('YANDEX_SEARCH_BASE_DOMAINS')}
    ${contentFunctionSource('getYandexSearchBaseDomain')}
    ${contentFunctionSource('isYandexSearchHost')}
    ${contentFunctionSource('getSearchEngine')}
    globalThis.result = getSearchEngine();
  `, sandbox);
  return sandbox.result;
}

function updatedYandexFamilyCookie(currentValue, expiresAt) {
  const sandbox = { currentValue, expiresAt };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${contentFunctionSource('updateYandexFamilyCookieValue')}
    globalThis.result = updateYandexFamilyCookieValue(currentValue, expiresAt);
  `, sandbox);
  return sandbox.result;
}

test('DuckDuckGo navigation is forced onto its dedicated safe host', () => {
  const ddg = rule(10003);

  assert.ok(ddg, 'DuckDuckGo safe-host rule should exist');
  assert.equal(ddg.priority, 3);
  assert.equal(ddg.action.type, 'redirect');
  assert.equal(ddg.action.redirect.transform.scheme, 'https');
  assert.equal(ddg.action.redirect.transform.host, 'safe.duckduckgo.com');
  assert.deepEqual(ddg.condition.resourceTypes, ['main_frame']);
  assert.deepEqual(ddg.action.redirect.transform.queryTransform.addOrReplaceParams, [
    { key: 'kp', value: '1' }
  ]);
});

test('DuckDuckGo safe-host rule matches normal hosts but cannot loop', () => {
  const pattern = new RegExp(rule(10003).condition.regexFilter);

  assert.equal(pattern.test('https://duckduckgo.com/?q=flowers&kp=-2'), true);
  assert.equal(pattern.test('http://www.duckduckgo.com/settings'), true);
  assert.equal(pattern.test('https://safe.duckduckgo.com/?q=flowers'), false);
  assert.equal(pattern.test('https://notduckduckgo.com/?q=flowers'), false);
});

test('Brave navigation is forced onto its dedicated safe host', () => {
  const brave = rule(10005);
  const pattern = new RegExp(brave.condition.regexFilter);

  assert.equal(brave.priority, 3);
  assert.equal(brave.action.redirect.transform.host, 'safe.search.brave.com');
  assert.equal(pattern.test('https://search.brave.com/search?q=flowers&safesearch=off'), true);
  assert.equal(pattern.test('https://safe.search.brave.com/search?q=flowers'), false);
  assert.deepEqual(brave.action.redirect.transform.queryTransform.addOrReplaceParams, [
    { key: 'safesearch', value: 'strict' }
  ]);
});

test('secondary result filtering still recognizes Brave safe-host pages', () => {
  assert.equal(detectedSearchEngine('https://search.brave.com/search?q=flowers'), 'brave');
  assert.equal(detectedSearchEngine('https://safe.search.brave.com/search?q=flowers'), 'brave');
});

test('DuckDuckGo HTML and Lite searches still have strict parameters', () => {
  const fallback = rule(10011);
  const pattern = new RegExp(fallback.condition.regexFilter);

  assert.ok(fallback, 'non-JavaScript frontend rule should exist');
  assert.equal(pattern.test('https://html.duckduckgo.com/html/?q=flowers&kp=-2'), true);
  assert.equal(pattern.test('https://lite.duckduckgo.com/lite/?q=flowers'), true);
  assert.deepEqual(fallback.action.redirect.transform.queryTransform.addOrReplaceParams, [
    { key: 'kp', value: '1' }
  ]);
});

test('strict parameters cover search-engine media verticals', () => {
  const cases = [
    [10002, 'https://www.bing.com/images/search?q=flowers', 'https://www.bing.com/maps?q=flowers'],
    [10006, 'https://www.ecosia.org/images?q=flowers', 'https://www.ecosia.org/settings'],
    [10009, 'https://presearch.com/videos?q=flowers', 'https://presearch.com/account']
  ];

  for (const [id, covered, unrelated] of cases) {
    const pattern = new RegExp(rule(id).condition.regexFilter);
    assert.equal(pattern.test(covered), true, `rule ${id} should cover ${covered}`);
    assert.equal(pattern.test(unrelated), false, `rule ${id} should not cover ${unrelated}`);
  }
});

test('Yandex receives Family mode on the first network request', () => {
  const yandex = rule(10012);

  assert.ok(yandex, 'Yandex Family-mode rule should exist');
  assert.equal(yandex.priority, 3);
  assert.equal(yandex.action.type, 'modifyHeaders');
  assert.deepEqual(yandex.action.requestHeaders.map(header => ({
    header: header.header,
    operation: header.operation
  })), [{ header: 'cookie', operation: 'append' }]);
  assert.match(yandex.action.requestHeaders[0].value, /^yp=\d+\.sp\.family%3A2$/);
  assert.ok(yandex.condition.requestDomains.includes('yandex.com'));
  assert.ok(yandex.condition.requestDomains.includes('yandex.com.tr'));
  assert.ok(yandex.condition.requestDomains.includes('ya.ru'));
  assert.deepEqual(yandex.condition.resourceTypes, ['main_frame', 'sub_frame', 'xmlhttprequest']);

  const pattern = new RegExp(yandex.condition.regexFilter);
  assert.equal(pattern.test('https://yandex.ru/search/?text=flowers'), true);
  assert.equal(pattern.test('https://www.yandex.com/images/search?text=flowers'), true);
  assert.equal(pattern.test('https://ya.ru/video/search?text=flowers'), true);
  assert.equal(pattern.test('https://mail.yandex.ru/search/?text=flowers'), false);
  assert.equal(pattern.test('https://disk.yandex.ru/images/file.jpg'), false);
});

test('Yandex regional search hosts are recognized without accepting lookalikes', () => {
  assert.equal(detectedSearchEngine('https://yandex.com/search/?text=flowers'), 'yandex');
  assert.equal(detectedSearchEngine('https://www.yandex.com.tr/images/search?text=flowers'), 'yandex');
  assert.equal(detectedSearchEngine('https://ya.ru/search/?text=flowers'), 'yandex');
  assert.equal(detectedSearchEngine('https://mail.yandex.ru/search/?text=flowers'), null);
  assert.equal(detectedSearchEngine('https://yandex.com.evil.example/search/?text=flowers'), null);
  assert.equal(detectedSearchEngine('https://notyandex.com/search/?text=flowers'), null);
});

test('Yandex Family mode preserves unrelated yp preference blocks', () => {
  const existing = '1790777965.ygu.1#1803953969.szm.1:0x0:724x400';
  const expiresAt = 1819721986;

  assert.equal(
    updatedYandexFamilyCookie(existing, expiresAt),
    `${existing}#${expiresAt}.sp.family%3A2`
  );
  assert.equal(
    updatedYandexFamilyCookie(`${existing}#1700000000.sp.family%3A0`, expiresAt),
    `${existing}#${expiresAt}.sp.family%3A2`
  );
  assert.equal(
    updatedYandexFamilyCookie(`${existing}#1700000000.sp.family:1`, expiresAt),
    `${existing}#${expiresAt}.sp.family%3A2`
  );
});

test('safe-search rule ids are unique', () => {
  const ids = rules.map(candidate => candidate.id);
  assert.equal(new Set(ids).size, ids.length);
});
