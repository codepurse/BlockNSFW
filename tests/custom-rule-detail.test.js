// "Which of my rules did that?" A user asked for the blocked page to name the
// custom word or rule that held a page: a rule that is too broad (/sex/ also
// holding a page about Essex) was otherwise a guessing game.
//
// The chain under test: content.js finds which of the user's own entries
// matched (blocklist host, /regex/, title/…/ entry, or blocked word), carries
// it to the blocked page through session storage only, and the blocked page
// offers it behind "Show" with a way to open it in Settings, which selects its
// line. The page's own text is never passed on, and a site cannot set the rule
// through the address, since blocked.html is web-accessible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DomainValidate = require('../shared/validate-domain.js');
const KeywordPattern = require('../shared/keyword-pattern.js');

const root = path.join(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const blockedSource = fs.readFileSync(path.join(root, 'blocked.js'), 'utf8');
const optionsSource = fs.readFileSync(path.join(root, 'options.js'), 'utf8');

function functionSource(source, name) {
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

function loadMatchers() {
  const sandbox = {
    console, Map, Set, RegExp, Array, String,
    self: { DomainValidate },
    KeywordPattern,
    normalizeHost: (v) => String(v || '').trim().toLowerCase().replace(/^www\./, ''),
    escapeRegExp: (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    customKeywordList: []
  };
  vm.createContext(sandbox);
  vm.runInContext([
    'let customPatternRegexCache = new Map();',
    'const customKeywordRegexCache = new Map();',
    functionSource(contentSource, 'customPatternCompiled'),
    functionSource(contentSource, 'siteMatchAddress'),
    functionSource(contentSource, 'customPatternsMatchHost'),
    functionSource(contentSource, 'customPatternMatchingHost'),
    functionSource(contentSource, 'customPatternsMatchTitle'),
    functionSource(contentSource, 'customPatternMatchingTitle'),
    functionSource(contentSource, 'customKeywordRegex'),
    functionSource(contentSource, 'matchesCustomKeywords'),
    functionSource(contentSource, 'matchingCustomKeyword'),
    'globalThis.setKeywords = (list) => { customKeywordList = list; };',
    'globalThis.api = { customPatternMatchingHost, customPatternsMatchHost, customPatternMatchingTitle, customPatternsMatchTitle, matchingCustomKeyword, matchesCustomKeywords };'
  ].join('\n'), sandbox);
  return sandbox;
}

const ctx = loadMatchers();

test('the blocklist entry that matched an address comes back as written', () => {
  const list = ['# my sites', 'example.org', '*.spam.test', '/casino/', 'title/poker/', 'news.test/gossip*'];
  const { customPatternMatchingHost: which, customPatternsMatchHost: matches } = ctx.api;
  assert.equal(which('https://www.example.org/a', 'www.example.org', list), 'example.org');
  assert.equal(which('https://deep.spam.test/', 'deep.spam.test', list), '*.spam.test');
  assert.equal(which('https://ok.test/online-casino', 'ok.test', list), '/casino/');
  assert.equal(which('https://news.test/gossip/today', 'news.test', list), 'news.test/gossip*');
  assert.equal(which('https://fine.test/', 'fine.test', list), null);
  // The boolean form agrees, so every other caller behaves exactly as before.
  assert.equal(matches('https://ok.test/online-casino', 'ok.test', list), true);
  assert.equal(matches('https://fine.test/', 'fine.test', list), false);
});

test('the title entry that matched comes back as written', () => {
  const list = ['example.org', 'title/poker|roulette/'];
  assert.equal(ctx.api.customPatternMatchingTitle('Live Roulette Tonight', list), 'title/poker|roulette/');
  assert.equal(ctx.api.customPatternMatchingTitle('Cooking with herbs', list), null);
  assert.equal(ctx.api.customPatternsMatchTitle('Live Roulette Tonight', list), true);
});

test('the blocked word that matched comes back as written, not the page text', () => {
  ctx.setKeywords(['apricot', '/s[e3]x/', 'red velvet']);
  // The reported case: a pattern that is too broad holds a page about Essex.
  assert.equal(ctx.api.matchingCustomKeyword('a weekend in essex'), '/s[e3]x/');
  assert.equal(ctx.api.matchingCustomKeyword('apricot jam'), 'apricot');
  assert.equal(ctx.api.matchingCustomKeyword('red velvet cake'), 'red velvet');
  assert.equal(ctx.api.matchingCustomKeyword('apricots'), null, 'a literal word keeps its word boundary');
  assert.equal(ctx.api.matchesCustomKeywords('apricot jam'), true);
  ctx.setKeywords([]);
});

test('every block by the user\'s own rules carries the rule', () => {
  // Address: the early check works out which entry it was.
  assert.match(contentSource, /localReasonKey === 'custom_blocklist'[\s\S]{0,200}customPatternMatchingHost\(urlStr, normalizedHost, customPatterns\)/);
  assert.match(contentSource, /redirectNow\(localReasonKey, getBlockedReasonLabel\(localReasonKey\), rule \? \{ rule \} : undefined\)/);
  // Title, page details, page text.
  assert.match(contentSource, /redirectToBlockedPage\('custom_title_pattern', \{ rule \}[,)]/);
  assert.match(contentSource, /redirectToBlockedPage\('custom_keyword', \{ rule: analysis\.customRule \}\)/);
  assert.match(contentSource, /redirectToBlockedPage\('custom_keyword', \{ rule: customRule \}\)/);
  assert.match(contentSource, /matchedKeywords: \['Custom Blocked Word'\], customRule \}/);
});

test('the rule travels in session storage only, never in an address', () => {
  const builder = functionSource(contentSource, 'getBlockedRedirectUrl');
  assert.match(builder, /rule: typeof detail\.rule === 'string'/);
  // Nothing appends it to a query string: not ours, not a custom page's.
  assert.doesNotMatch(builder, /&rule=/);
  // The blocked page reads it from the stashed record, and from nowhere else.
  assert.match(blockedSource, /rule = typeof record\.rule === 'string' \? record\.rule : '';/);
  assert.doesNotMatch(blockedSource, /getParam\('rule'\)/);
});

test('the blocked page names the user\'s own rules and the box each lives in', () => {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(functionSource(blockedSource, 'getReasonMeta') + '\nglobalThis.meta = getReasonMeta;', sandbox);
  assert.equal(sandbox.meta('custom_blocklist').list, 'patterns');
  assert.equal(sandbox.meta('custom_title_pattern').list, 'patterns');
  assert.equal(sandbox.meta('custom_keyword').list, 'custom-keywords');
  assert.equal(sandbox.meta('custom_keyword').sourceLabel, 'Your blocked words');
  assert.equal(sandbox.meta('default_blocklist').list, undefined);
  assert.equal(sandbox.meta('page_text_scan').list, undefined);
  // Both boxes are real elements in Settings, which opens at an element's id.
  const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
  assert.match(html, /id="patterns"/);
  assert.match(html, /id="custom-keywords"/);
});

test('the rule waits behind "Show", in Classic and in the other designs', () => {
  const builder = functionSource(blockedSource, 'appendRuleControls');
  assert.match(builder, /show\.textContent = 'Show'/);
  // Written as text, never as markup.
  assert.match(builder, /code\.textContent = ruleText/);
  assert.doesNotMatch(builder, /innerHTML/);
  // Classic hides "Why this page was held", so it has its own line under the
  // address; the other designs hide that line and use the panel.
  assert.match(functionSource(blockedSource, 'addRuleRecord'), /appendRuleControls\(data, ruleText, settingsList\)/);
  assert.match(functionSource(blockedSource, 'showHeldRule'), /appendRuleControls\(line, ruleText, settingsList\)/);
  const html = fs.readFileSync(path.join(root, 'blocked.html'), 'utf8');
  assert.match(html, /<p class="held-address">[^\n]*<span class="held-rule" id="held-rule" hidden>Your rule: <\/span><\/p>/);
  assert.match(html, /html:not\(\[data-theme\]\) \.why \{\s*display: none;/);
  assert.match(html, /html\[data-theme\] \.held-address,/);
});

test('Settings finds the rule\'s line, escaped or not', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(functionSource(optionsSource, 'ruleLineRange') + '\nglobalThis.range = ruleLineRange;', sandbox);
  const text = '# my words\napricot\n  /s[e3]x/  \n\\#nsfw';
  const at = (rule) => {
    const r = sandbox.range(text, rule);
    return r && text.slice(r.start, r.end);
  };
  assert.equal(at('/s[e3]x/'), '/s[e3]x/');
  assert.equal(at('apricot'), 'apricot');
  assert.equal(at('#nsfw'), '\\#nsfw');
  assert.equal(sandbox.range(text, 'plum'), null);
  assert.equal(sandbox.range(text, ''), null);
  // The request names one of the two boxes, and nothing else gets focused.
  assert.match(optionsSource, /const FOCUS_RULE_LISTS = \['patterns', 'custom-keywords'\];/);
});
