// How content.js drives the AI Text Blocker: runs the real gatherTextForModel,
// getAiTextThresholds and checkPageTextWithModel from content.js against the
// real shipped model, with the page and the rest of the extension stubbed.
//
// text-classifier-core.test.js proves the model scores text correctly; this
// proves content.js hands it the right text, uses the model's own thresholds,
// and acts on the verdict. Two things here guard real regressions:
//
//  - Text alone blocks. Until model v4, a temporary catch downgraded every
//    text-only block to "allow" because the v3 model could not be trusted on
//    its own. The catch is gone; if it comes back, the detector silently
//    stops doing anything without the image filter.
//  - The model's thresholds win over the constants in content.js. A threshold
//    only means something for the model it was measured on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const TC = require('../shared/text-classifier-core.js');
const MODEL = TC.loadModel(JSON.parse(fs.readFileSync(path.join(ROOT, 'text-model.json'), 'utf8')));

function contentFunctionSource(name) {
  const start = CONTENT_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  let depth = 0;
  for (let index = CONTENT_SOURCE.indexOf('{', start); index < CONTENT_SOURCE.length; index++) {
    if (CONTENT_SOURCE[index] === '{') depth++;
    if (CONTENT_SOURCE[index] === '}') depth--;
    if (depth === 0) return CONTENT_SOURCE.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function contentConst(name) {
  const m = CONTENT_SOURCE.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\r?\\n`));
  assert.ok(m, `${name} should exist in content.js`);
  return m[1];
}

// A page: title, meta contents, visible lines. Returns what the extension did.
function runScan({ title = '', metas = [], lines = [], strictness = 'balanced', images = 0, model = MODEL }) {
  const redirects = [];
  const sandbox = {
    TextClassifier: TC,
    textModel: model,
    textModelReady: !!model,
    textScanPending: false,
    isEnabled: true,
    aiTextBlocker: true,
    blockedTriggered: false,
    aiTextStrictness: strictness,
    debugMode: false,
    document: {
      title,
      body: {},
      querySelectorAll: () => metas.map(content => ({ getAttribute: () => content })),
    },
    globalThis: { __pblockerAIImageBlockCount: images },
    getSearchEngine: () => null,
    isExtensionStorePage: () => false,
    isLocalPage: () => false,
    ensureTextModelLoaded: () => {},
    getPageTextLinesForScan: () => lines.slice(),
    log: () => {},
    notifyBackground: () => {},
    redirectToBlockedPage: (reason, detail) => redirects.push({ reason, detail }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const MIN_TEXT_TOKENS_FOR_BLOCK = ${contentConst('MIN_TEXT_TOKENS_FOR_BLOCK')};
    const AI_TEXT_META_SELECTORS = ${contentConst('AI_TEXT_META_SELECTORS')};
    ${contentFunctionSource('getAiTextThresholds')}
    ${contentFunctionSource('gatherTextForModel')}
    ${contentFunctionSource('checkPageTextWithModel')}
    this.result = checkPageTextWithModel();
    this.thresholds = getAiTextThresholds(aiTextStrictness);
    this.parts = gatherTextForModel();
  `, sandbox);
  return { blocked: sandbox.result, redirects, thresholds: sandbox.thresholds, parts: sandbox.parts };
}

const ADULT = {
  title: 'Free XXX Porn Videos - Hardcore Sex Tube',
  metas: ['Watch free porn videos, hardcore sex and naked milf xxx clips updated daily.'],
  lines: [
    'Hot amateur porn videos and hardcore sex movies with naked girls',
    'Big tits milf fucked hard in this free xxx video, anal and blowjob clips',
    'Join now for full length HD porn and live sex cams, 18+ only',
  ],
};

test('title and meta tags travel separately from the visible text', () => {
  const { parts } = runScan(ADULT);
  assert.equal(parts.head, ADULT.title + ' ' + ADULT.metas[0]);
  assert.equal(parts.body, ADULT.lines.join(' '));
});

test('an explicit page is blocked on text alone, with no image flagged', () => {
  const { blocked, redirects } = runScan({ ...ADULT, images: 0 });
  assert.equal(blocked, true, 'text-only blocking must work: the v3 safety catch is gone');
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].reason, 'ai_text_scan');
  assert.ok(redirects[0].detail.score >= TC.thresholdsFor(MODEL, 'balanced').block);
  assert.ok(redirects[0].detail.matched.length > 0, 'the blocked page should be told which words drove it');
});

test('a porn-recovery page is not blocked, even at Strict', () => {
  const { blocked, redirects } = runScan({
    title: 'How to quit porn: a 90-day recovery plan',
    metas: ['Practical steps to beat porn addiction, rebuild trust and stay accountable.'],
    lines: [
      'Porn addiction is real, and recovery is possible. Here is what worked for thousands of our members.',
      'Install a blocker, find an accountability partner, and track your streak of porn-free days.',
      'When an urge hits, leave the room, call a friend, or go for a walk until it passes.',
      'Relapse is part of many recovery stories. What matters is what you do the day after.',
    ],
    strictness: 'strict',
  });
  assert.equal(blocked, false);
  assert.equal(redirects.length, 0);
});

test('a page that just talks about videos is not blocked, even at Strict', () => {
  const { blocked } = runScan({
    title: 'Easy Recipe Videos | Home Cooking',
    metas: ['Watch our cooking videos: quick dinners, baking videos and video tutorials.'],
    lines: [
      'New recipe videos every week from our test kitchen, with step by step video guides.',
      'Watch the most popular videos: pasta, curry, sourdough bread and birthday cakes.',
      'Subscribe to get new cooking videos and meal plans straight to your inbox.',
    ],
    strictness: 'strict',
  });
  assert.equal(blocked, false);
});

test('a page under the evidence floor is never scored, however explicit', () => {
  const { blocked } = runScan({ title: 'porn xxx sex', metas: [], lines: [] });
  assert.equal(blocked, false);
});

test('the model\'s own thresholds are used, for every level', () => {
  for (const level of ['relaxed', 'balanced', 'strict']) {
    const { thresholds } = runScan({ ...ADULT, strictness: level });
    const own = TC.thresholdsFor(MODEL, level);
    assert.equal(thresholds.block, own.block, `${level} block`);
    assert.equal(thresholds.fuse, own.fuse, `${level} fuse`);
  }
});

test('loading the shipped model succeeds cleanly and runs the scan that was waiting for it', async () => {
  // Its "ready" log line read v3's `m.weights.size`, which v4 does not have.
  // The model was already marked ready when that threw, so scanning still
  // worked -- but every page load threw and logged "model load failed".
  const modelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'text-model.json'), 'utf8'));
  const logs = [];
  let deferredRuns = 0;
  const sandbox = {
    TextClassifier: TC,
    textModel: null, textModelReady: false, textModelLoading: false, textModelFailed: false,
    textScanPending: true,
    browserAPI: { runtime: { getURL: p => 'chrome-extension://test/' + p } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(modelJson) }),
    log: (...args) => logs.push(args.map(String).join(' ')),
    runDeferredTextScan: () => { deferredRuns++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${contentFunctionSource('ensureTextModelLoaded')}\nensureTextModelLoaded();`, sandbox);
  for (let i = 0; i < 20 && sandbox.textModelLoading; i++) await new Promise(r => setImmediate(r));
  assert.equal(sandbox.textModelReady, true);
  assert.equal(sandbox.textModelFailed, false);
  assert.ok(!logs.some(l => l.includes('load failed')), `unexpected: ${logs.join(' | ')}`);
  assert.equal(deferredRuns, 1, 'the scan requested before the model loaded must run once it has');
});

test('without a model the scan does nothing and the constants remain as a fallback', () => {
  const { blocked, thresholds } = runScan({ ...ADULT, model: null });
  assert.equal(blocked, false);
  assert.ok(thresholds.block > 0 && thresholds.block < 1);
});
