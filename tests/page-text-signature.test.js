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

const sandbox = { Math };
vm.createContext(sandbox);
vm.runInContext(`${fn('pageTextSignature')}; globalThis.sig = pageTextSignature;`, sandbox);
const sig = sandbox.sig;

// checkPageBodyText skips its analysis when this signature is unchanged. A
// collision therefore does not cost performance, it costs a block: the page is
// never scanned. These pin that the signature actually depends on the whole
// text, not just its edges.

test('identical text produces an identical signature', () => {
  const lines = ['header line here', 'some body content', 'footer line here'];
  assert.equal(sig(lines), sig([...lines]));
});

test('a change in the MIDDLE changes the signature', () => {
  // The case the old count+first+last key missed: an SPA swapping its route
  // under a fixed header and footer. Same line count, same ends, different page.
  const before = ['site header here', 'ordinary article text', 'site footer here'];
  const after  = ['site header here', 'explicit adult text!!', 'site footer here'];

  assert.notEqual(sig(before), sig(after),
    'a page whose middle changed must be re-scanned');
});

test('same length and ends but reordered middle still differs', () => {
  const a = ['header xxxxxxxxxx', 'aaaa', 'bbbb', 'footer xxxxxxxxxx'];
  const b = ['header xxxxxxxxxx', 'bbbb', 'aaaa', 'footer xxxxxxxxxx'];
  assert.notEqual(sig(a), sig(b));
});

test('re-splitting the same characters differently is not the same page', () => {
  // Without a separator in the hash, ['ab','c'] and ['a','bc'] would collide.
  assert.notEqual(sig(['ab', 'c']), sig(['a', 'bc']));
});

test('a longer page differs from a shorter one', () => {
  const base = ['alpha line one', 'beta line two'];
  assert.notEqual(sig(base), sig([...base, 'gamma line three']));
});

test('the signature is a short stable string', () => {
  const s = sig(['some ordinary page text', 'and a second line']);
  assert.equal(typeof s, 'string');
  assert.ok(s.length < 40, 'this is compared on every scan; it must stay cheap');
  assert.match(s, /^\d+:\d+:[0-9a-z]+$/);
});

test('an empty slice is handled', () => {
  assert.equal(typeof sig([]), 'string');
});

test('no source file ships NUL bytes', () => {
  // A stray NUL makes tooling treat the file as binary (grep, diff, some
  // minifiers and store scanners), and one was introduced by an edit in this
  // branch and shipped into a build before it was noticed.
  for (const file of ['content.js', 'background.js', 'ai-image-blocker.js',
                      'ai-image-blocker-core.js', 'offscreen.js', 'popup.js', 'options.js']) {
    const buf = fs.readFileSync(path.join(ROOT, file));
    assert.equal(buf.includes(0), false, `${file} contains a NUL byte`);
  }
});
