// The page-text scan judges words a person can see. A user's blocked word
// /s[e3]x/ held a TikTok video page with nothing like it on screen: while the
// page loaded, innerText was empty, the scan fell back to textContent, and that
// is the source of every <script> in the body. TikTok's config carries base64
// ("bWFseXRpY3M", i.e. "analytics") that lowercases to "…bmfsexrp…".

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

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

const SCRIPT_SOURCE = '{"pattern":{"$regex":"^(www.google-analytics.com|analytics.google.com)"},"b64":"Lmdvb2dsZS1hbmFseXRpY3MuY29t"}';

function linesFor(body) {
  const sandbox = { document: { body } };
  vm.createContext(sandbox);
  vm.runInContext([
    'const MAX_TEXT_LENGTH = 8000;',
    'const PAGE_TEXT_SCAN_MIN_LINE_LENGTH = 12;',
    'const PAGE_TEXT_SCAN_MAX_LINES = 48;',
    fn('sanitizeTextForScan'),
    fn('getPageTextLinesForScan'),
    'globalThis.lines = getPageTextLinesForScan;'
  ].join('\n'), sandbox);
  return Array.from(sandbox.lines()); // out of the sandbox's realm, for deepEqual
}

function body({ innerText, rendered = true }) {
  return {
    innerText,
    textContent: SCRIPT_SOURCE,
    getClientRects: () => (rendered ? [{ width: 1280, height: 900 }] : [])
  };
}

test('a page with nothing drawn yet has nothing to scan, not its scripts', () => {
  assert.deepEqual(linesFor(body({ innerText: '' })), []);
});

test('a body that is not rendered is not read either', () => {
  // innerText of an unrendered element is its textContent, scripts and all.
  assert.deepEqual(linesFor(body({ innerText: SCRIPT_SOURCE, rendered: false })), []);
});

test('once the page has text, that text is what gets scanned', () => {
  const lines = linesFor(body({ innerText: '#franseth #francinediaz #sethfedelin\nshort\nFrancine Diaz and Seth Fedelin' }));
  assert.deepEqual(lines, ['#franseth #francinediaz #sethfedelin', 'Francine Diaz and Seth Fedelin']);
});

test('the reported page: script base64 never reaches the blocked words', () => {
  assert.match(SCRIPT_SOURCE.toLowerCase(), /s[e3]x/, 'the fixture really does contain the false match');
  const joined = linesFor(body({ innerText: '' })).join('\n');
  assert.doesNotMatch(joined, /s[e3]x/i);
  assert.doesNotMatch(fn('getPageTextLinesForScan'), /\.textContent/);
});
