// Sub-frame coverage and its cost ceiling (audit finding C3).
//
// The content script ran in the top frame only, so nothing filtered an adult
// site loaded inside an iframe — no image filter, no AI classifier, no text
// scan. processIframe() checked the frame's src against the blocklist from the
// parent, which catches a known host and nothing else, so any unknown mirror,
// shortener or redirector passed. Iframe-proxy sites made that a two-click
// bypass needing no technical skill.
//
// Turning on all_frames closes it, and immediately creates the opposite risk:
// an ordinary article page carries a dozen ad and analytics iframes, and this
// file sets up three observers and reads settings on startup. Running the full
// pass in each is the shape of regression that made 1.7.0 slow. So these tests
// pin BOTH halves — that sub-frames are covered, and that they are cheap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'manifest.firefox.json'), 'utf8'));

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// Evaluate isNegligibleFrame() against a chosen frame geometry.
function negligible({ top, width, height }) {
  const sandbox = {
    IS_TOP_FRAME: top,
    FRAME_MIN_DIMENSION_PX: 120,
    window: { innerWidth: width, innerHeight: height }
  };
  const vm = require('node:vm');
  vm.createContext(sandbox);
  vm.runInContext(functionSource('isNegligibleFrame'), sandbox);
  return sandbox.isNegligibleFrame();
}

test('C3: both manifests inject into every frame', () => {
  for (const [label, m] of [['chrome', manifest], ['firefox', firefoxManifest]]) {
    const cs = m.content_scripts[0];
    assert.equal(cs.all_frames, true,
      `${label}: without all_frames an adult site in an iframe is filtered by nothing`);
    assert.equal(cs.match_about_blank, true,
      `${label}: about:blank frames inherit their parent's origin and carry content too`);
    assert.equal(cs.run_at, 'document_start', `${label}: run_at must not have changed`);
  }
});

test('C3: a tiny frame does no work at all', () => {
  // Tracking pixels and share buttons. Bailing before the storage read is the
  // whole reason all_frames is affordable.
  assert.equal(negligible({ top: false, width: 1, height: 1 }), true);
  assert.equal(negligible({ top: false, width: 100, height: 600 }), true);
  assert.equal(negligible({ top: false, width: 600, height: 40 }), true);
});

test('C3: a frame big enough to show content is scanned', () => {
  assert.equal(negligible({ top: false, width: 300, height: 250 }), false,
    'a standard ad slot is big enough to show an image worth filtering');
  assert.equal(negligible({ top: false, width: 800, height: 600 }), false);
});

test('C3: a frame not yet laid out is scanned, not skipped', () => {
  // A frame reports 0 before layout. Treating that as "too small" would skip
  // frames that matter, which is the failure this feature exists to fix.
  assert.equal(negligible({ top: false, width: 0, height: 0 }), false);
});

test('C3: the top frame is never treated as negligible', () => {
  // A small browser window is still the page.
  assert.equal(negligible({ top: true, width: 10, height: 10 }), false);
});

test('C3: init bails before reading settings in a negligible frame', () => {
  const init = functionSource('init');
  const bail = init.indexOf('isNegligibleFrame()');
  const settings = init.indexOf('loadSettings()');
  assert.notEqual(bail, -1, 'init() must check the frame first');
  assert.ok(bail < settings,
    'the bail must come before loadSettings() — a storage read per ad frame is ' +
    'the cost this gate exists to avoid');
});

test('C3: element filters run in sub-frames, page verdicts do not', () => {
  const body = source.slice(
    source.indexOf('async function processContent()'),
    source.indexOf('function redirectToBlockedPage('));

  // The point of the feature: images and media are filtered inside frames.
  const imageCall = body.indexOf('filterImages();');
  const gate = body.indexOf('if (!IS_TOP_FRAME) return;');
  assert.notEqual(imageCall, -1);
  assert.notEqual(gate, -1, 'processContent must gate its page-level half');
  assert.ok(imageCall < gate,
    'filterImages() must run before the top-frame gate, or sub-frames get no ' +
    'image filtering and the feature does nothing');

  // Page-level verdicts must sit after it.
  for (const call of ['checkPageMetadata()', 'checkPageBodyText()', 'checkPageTextWithModel()']) {
    const at = body.indexOf(call);
    assert.notEqual(at, -1, `${call} should be in processContent`);
    assert.ok(at > gate, `${call} must be behind the top-frame gate`);
  }
});

test('C3: page-level UI is never drawn inside a frame', () => {
  for (const name of ['updateBlockedResultsNotice', 'updateFloatingCounter']) {
    assert.match(functionSource(name), /if \(!IS_TOP_FRAME\) return;/,
      `${name} would otherwise draw once per iframe`);
  }
});

test('C3: the page-text scan is not even armed in a sub-frame', () => {
  // anyTextFeatureOn gates the MutationObserver's scheduling. Left true in a
  // frame, every element insertion in every ad slot would arm a debounced
  // scan that then declines to run.
  assert.match(source, /anyTextFeatureOn = IS_TOP_FRAME && /,
    'anyTextFeatureOn must be false in sub-frames');
});

test('C3: a blocked sub-frame is counted as a frame, not as a website', () => {
  // Otherwise "websites blocked" inflates every time an article embeds
  // something, and the figure stops meaning what the stats page says.
  assert.match(source, /type: IS_TOP_FRAME \? 'website_blocked' : 'iframe_filtered'/);
});

test('C3: SafeSearch enforcement stays in the top frame', () => {
  const iife = source.slice(0, source.indexOf('// Configuration and state management'));
  assert.match(iife, /if \(!IS_TOP_FRAME\) return;/,
    'cookie and localStorage writes make no sense inside someone else\'s iframe');
});
