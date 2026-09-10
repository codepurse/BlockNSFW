// Guard for audit finding H5: the content script must not write the page's
// title or URL to the page's own console unless debug mode is on.
//
// content.js runs on every page. Page-side RUM and error SDKs (Sentry,
// LogRocket, Datadog RUM) capture console output as breadcrumbs by default, so
// an ungated console.log here hands a site's analytics vendor both the fact
// that BlockNSFW is installed and the title of every page the user opens. That
// is a privacy leak from an extension whose premise is that browsing stays
// local, and it is a second install-detection channel that no CSP can close.
//
// This is a source-level check rather than a behavioural one on purpose: the
// failure mode is a stray console.log added later, and the cheapest place to
// catch that is the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const lines = source.split(/\r?\n/);

// Values that identify the user's browsing rather than the extension's state.
const SENSITIVE = [
  'location.href',
  'document.title',
  'window.location.href',
  'location.hostname',
];

// The text of a console call that may span several lines, read by walking
// forward until its parentheses balance. Bounding the read to the call itself
// matters: a fixed line window bleeds into unrelated code and reports calls
// that never touch a URL.
function callTextAt(index) {
  let depth = 0;
  let started = false;
  let text = '';
  for (let i = index; i < Math.min(lines.length, index + 12); i++) {
    text += lines[i] + '\n';
    for (const ch of lines[i]) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') depth--;
    }
    if (started && depth <= 0) break;
  }
  return text;
}

// A call is acceptable when a debug switch guards it. The guard is usually an
// early return at the top of the enclosing function rather than an `if` on the
// line above, so look back far enough to find one.
const GUARD_LOOKBACK = 30;

function isGuarded(index) {
  const before = lines.slice(Math.max(0, index - GUARD_LOOKBACK), index + 1).join('\n');
  return /\bdebugMode\b/.test(before) || /\bsafeSearchDebug\b/.test(before);
}

test('H5: no ungated console call logs the page URL or title', () => {
  const offenders = [];
  lines.forEach((line, index) => {
    if (!/\bconsole\.(log|info|debug|warn)\s*\(/.test(line)) return;
    const call = callTextAt(index);
    if (!SENSITIVE.some(token => call.includes(token))) return;
    if (isGuarded(index)) return;
    offenders.push(`content.js:${index + 1}  ${line.trim()}`);
  });

  assert.deepEqual(offenders, [],
    'These console calls leak the page URL or title to the host page:\n  ' +
    offenders.join('\n  ') +
    '\nRoute them through log() or gate them on debugMode / safeSearchDebug.');
});

test('H5: consoleLogPageTitle returns early unless debug mode is on', () => {
  const start = source.indexOf('function consoleLogPageTitle(');
  assert.notEqual(start, -1, 'consoleLogPageTitle should exist');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.match(body, /if\s*\(\s*!debugMode\s*\)\s*return;/,
    'consoleLogPageTitle must bail out before touching document.title');
});

test('H5: the AOL SafeSearch audit is gated (it logs the search query)', () => {
  const start = source.indexOf('const logAolSafeSearchAudit =');
  assert.notEqual(start, -1, 'logAolSafeSearchAudit should exist');
  const body = source.slice(start, start + 400);
  assert.match(body, /if\s*\(\s*!safeSearchDebug\s*\)\s*return;/,
    'logAolSafeSearchAudit logs location.href on a search page and must be gated');
});

test('H5: the init diagnostic runs after settings load, so debugMode is real', () => {
  const initStart = source.indexOf('async function init()');
  assert.notEqual(initStart, -1);
  const body = source.slice(initStart, initStart + 900);
  const loadAt = body.indexOf('await loadSettings()');
  const logAt = body.indexOf("consoleLogPageTitle('init')");
  assert.ok(loadAt !== -1 && logAt !== -1, 'both calls should be present in init()');
  assert.ok(loadAt < logAt,
    'consoleLogPageTitle(\'init\') must run after loadSettings(), or debugMode is still the default and the diagnostic is dropped even for debug users');
});
