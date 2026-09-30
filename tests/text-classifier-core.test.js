// Tests for shared/text-classifier-core.js -- the pure AI Text Blocker core
// (model format v4). Mirrors the vm-sandbox style of ai-image-blocker-core.test.js.
//
// Two kinds of test live here:
//
//  1. PARITY. tools/train_text_classifier.py writes golden vectors
//     (tools/seed_data/golden_vectors.json) from the same model it exports:
//     normalisation, tokens, window spans, and final page probabilities. If
//     the JS and Python pipelines drift apart, trained weights stop lining up
//     with inference features and the model silently degrades -- these catch it.
//
//  2. BEHAVIOUR on text written for this file, never taken from the training
//     corpus (which is Common Crawl page text). The v3 tests asserted on rows
//     copied from the training data and on a score that was always exactly 0
//     or 1, so they measured memorisation and passed whatever the model did.
//     The model's own quality numbers live in tools/text_corpus/EVAL.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'text-classifier-core.js'), 'utf8');

function loadCore() {
  const sandbox = { console, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'text-classifier-core.js' });
  return sandbox.module.exports;
}

function loadGolden() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'seed_data', 'golden_vectors.json'), 'utf8'));
}

function loadModelJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'text-model.json'), 'utf8'));
}

let cached = null;
function core() {
  if (!cached) {
    const TC = loadCore();
    const json = loadModelJson();
    cached = { TC, json, model: TC.loadModel(json) };
  }
  return cached;
}

function pageProb(parts) {
  const { TC, model } = core();
  return TC.scorePage(parts, model).prob;
}

// ---------------------------------------------------------------------------
// Parity with the Python trainer
// ---------------------------------------------------------------------------
test('golden: FNV-1a feature hashing matches Python', () => {
  const TC = loadCore();
  const golden = loadGolden();
  assert.equal(golden.dim, TC.DEFAULT_DIM);
  for (const { s, bucket } of golden.hashes) {
    assert.equal(TC.hashFeature(s, golden.dim), bucket, `bucket mismatch for ${JSON.stringify(s)}`);
  }
});

test('golden: normalisation matches Python (NFKC, case, punctuation, whitespace)', () => {
  const TC = loadCore();
  for (const { text, norm } of loadGolden().normalize) {
    assert.equal(TC.normalizeForClassifier(text), norm, `normalize(${JSON.stringify(text)})`);
  }
});

test('golden: tokens, token features and window spans match Python', () => {
  const TC = loadCore();
  const g = loadGolden();
  const tokens = TC.tokenize(TC.normalizeForClassifier(g.tokenize.text), 24);
  assert.equal(JSON.stringify(tokens), JSON.stringify(g.tokenize.tokens));
  // Includes CJK, Hangul and Thai tokens, which also get character bigrams.
  for (const { token, features } of g.tokenFeatures) {
    assert.equal(JSON.stringify(TC.tokenFeatureStrings(token, 3, 5)), JSON.stringify(features),
      `features for ${JSON.stringify(token)}`);
  }
  const spans = TC.windowSpans(g.spans.tokens, g.spans.chars, g.spans.stride);
  assert.equal(JSON.stringify(spans), JSON.stringify(g.spans.spans));
});

test('golden: the shipped model scores pages exactly as the trainer did', () => {
  const { TC, json, model } = core();
  const g = loadGolden();
  assert.ok(model, 'text-model.json must load');
  assert.equal(g.modelVersion, json.version, 'golden vectors are stale -- re-run the trainer');
  for (const page of g.pages) {
    const r = TC.scorePage({ head: page.head, body: page.body }, model);
    assert.equal(r.head.z.length, page.headZ.length);
    assert.equal(r.body.z.length, page.bodyZ.length);
    r.head.z.forEach((z, i) => assert.ok(Math.abs(z - page.headZ[i]) < 1e-9, `head z[${i}]`));
    r.body.z.forEach((z, i) => assert.ok(Math.abs(z - page.bodyZ[i]) < 1e-9, `body z[${i}]`));
    assert.ok(Math.abs(r.prob - page.prob) < 1e-9,
      `prob for ${JSON.stringify(page.head || page.body.slice(0, 30))}: ${r.prob} vs ${page.prob}`);
  }
});

// ---------------------------------------------------------------------------
// Pure mechanics
// ---------------------------------------------------------------------------
test('normalizeForClassifier: punctuation and symbols become word breaks', () => {
  const TC = loadCore();
  assert.equal(TC.normalizeForClassifier('Free  Porn\tVideo'), 'free porn video');
  // v3 read a comma-joined keywords tag as one long token.
  assert.equal(TC.normalizeForClassifier('xvideos,xvideos.com,x videos'), 'xvideos xvideos com x videos');
  assert.equal(TC.normalizeForClassifier('   trim me   '), 'trim me');
  assert.equal(TC.normalizeForClassifier(null), '');
  assert.equal(TC.normalizeForClassifier(123), '');
});

test('tokenize: long runs are cut into fixed pieces so one token cannot fill a window', () => {
  const TC = loadCore();
  const long = 'x'.repeat(60);
  assert.equal(JSON.stringify(TC.tokenize(long, 24)),
    JSON.stringify(['x'.repeat(24), 'x'.repeat(24), 'x'.repeat(12)]));
  assert.equal(TC.tokenize('', 24).length, 0);
});

test('windowSpans: every token is covered, windows respect the size, starts advance', () => {
  const TC = loadCore();
  const words = [];
  for (let i = 0; i < 400; i++) words.push('w' + (i % 37) + 'x'.repeat(i % 9));
  const spans = TC.windowSpans(words, 200, 100);
  const covered = new Array(words.length).fill(false);
  let prevStart = -1;
  for (const [a, b] of spans) {
    assert.ok(b > a);
    assert.ok(a > prevStart, 'window starts must strictly advance');
    prevStart = a;
    const chars = words.slice(a, b).join(' ').length;
    assert.ok(b - a === 1 || chars <= 200, `window ${a}-${b} is ${chars} chars`);
    for (let i = a; i < b; i++) covered[i] = true;
  }
  assert.ok(covered.every(Boolean), 'no token may fall between windows');
  assert.equal(spans[spans.length - 1][1], words.length);
});

test('loadModel: refuses anything that is not a complete v4 model', () => {
  const { TC, json } = core();
  assert.equal(TC.loadModel(null), null);
  assert.equal(TC.loadModel({ version: 3, format: 'fnv1a-char-ngram-logreg-v1', weights: [] }), null);
  assert.equal(TC.loadModel({ ...json, page: { ...json.page, features: ['x'] } }), null,
    'a page model for a different feature set must be rejected');
  assert.equal(TC.loadModel({ ...json, count: json.count + 1 }), null, 'truncated weights');
});

test('scoreText / scorePage: no model means no opinion', () => {
  const TC = loadCore();
  assert.equal(TC.scoreText('anything', null), -1);
  assert.equal(TC.scorePage({ head: 'x', body: 'y' }, null), null);
  assert.equal(TC.topContributors('free porn video', null).length, 0);
});

test('scorePage: empty page is safe, not an error', () => {
  const { TC, model } = core();
  const r = TC.scorePage({ head: '', body: '   ' }, model);
  assert.equal(r.prob, 0);
  assert.equal(r.empty, true);
});

test('verdictForText: block / fuse-block / allow logic', () => {
  const TC = loadCore();
  const thr = { block: 0.9, fuse: 0.6 };
  assert.equal(TC.verdictForText(0.95, thr, 0), 'block');
  assert.equal(TC.verdictForText(0.92, thr, 5), 'block');
  assert.equal(TC.verdictForText(0.70, thr, 0), 'allow');       // moderate, no image evidence
  assert.equal(TC.verdictForText(0.70, thr, 2), 'fuse-block');  // moderate + images
  assert.equal(TC.verdictForText(0.59, thr, 5), 'allow');       // below fuse threshold
  assert.equal(TC.verdictForText(-1, thr, 5), 'allow');         // no model opinion
});

test('thresholdsFor: the model carries ordered thresholds for every level', () => {
  const { TC, model } = core();
  const relaxed = TC.thresholdsFor(model, 'relaxed');
  const balanced = TC.thresholdsFor(model, 'balanced');
  const strict = TC.thresholdsFor(model, 'strict');
  for (const t of [relaxed, balanced, strict]) {
    assert.ok(t.block > 0 && t.block < 1, 'block threshold in (0,1)');
    assert.ok(t.fuse > 0 && t.fuse <= t.block, 'fuse never above block');
  }
  // Stricter levels block more, so their bar is lower (or equal).
  assert.ok(strict.block <= balanced.block && balanced.block <= relaxed.block);
  assert.deepEqual(TC.thresholdsFor(model, 'nonsense'), balanced);
  assert.equal(TC.thresholdsFor(null, 'balanced'), null);
});

// ---------------------------------------------------------------------------
// Behaviour on text written for this file
// ---------------------------------------------------------------------------
const ADULT_PAGES = [
  {
    head: 'Hot XXX Videos - Free Hardcore Porn Tube',
    body: 'Watch the hottest free porn videos online. Hardcore sex, amateur couples, ' +
      'big tits, milf and teen 18+ porn clips updated every hour. Join now for full ' +
      'length HD xxx movies and live sex cams with naked girls.',
  },
  {
    head: 'Live Sex Cams - Nude Girls Online',
    body: 'Chat with naked cam girls live. Free nude webcam shows, explicit private sex ' +
      'chat, pussy and anal play. Over 18 only. Sign up to tip models and unlock porn.',
  },
];

// Pages that share vocabulary with adult content but must never be blocked.
const TRAP_PAGES = [
  {
    head: 'Quit porn for good - a recovery program that works',
    body: 'Pornography addiction rewires the brain, but recovery is possible. Our free ' +
      'program helps you stop watching porn, track your streak of clean days, find an ' +
      'accountability partner, and understand your triggers. Thousands of men and women ' +
      'have broken free from compulsive porn use and rebuilt their relationships.',
  },
  {
    head: 'Sex education for teenagers',
    body: 'Good sex education gives young people accurate information about puberty, ' +
      'consent, contraception, pregnancy and sexually transmitted infections. Talk with ' +
      'a doctor or school nurse if you have questions about your body or relationships.',
  },
  {
    head: 'YouTube',
    body: 'Home Shorts Subscriptions You History Playlists Your videos Watch later Liked ' +
      'videos Trending Music Movies Live Gaming News Sports Learning Fashion and beauty',
  },
  {
    head: 'Breastfeeding tips for new mothers',
    body: 'Most babies breastfeed eight to twelve times a day. A good latch means your ' +
      'nipple and much of the breast are in the baby\'s mouth. Sore nipples usually ' +
      'mean the latch needs adjusting; a lactation consultant can help.',
  },
  // Pages that just talk about videos. Adult tube sites repeat "videos",
  // "watch" and "new episodes" constantly, and an early v4 learned that page
  // furniture instead of the content: pages like these scored 0.99.
  {
    head: 'Baking Videos - Learn to Bake',
    body: 'Watch baking videos from our pastry chefs. New video lessons every week: bread ' +
      'videos, cake decorating videos and step by step cookie tutorials for beginners and kids.',
  },
  {
    head: 'Kids Science Videos',
    body: 'Fun science videos for kids. Watch experiment videos, space videos and animal ' +
      'videos, with new episodes and short video lessons for classrooms every Monday.',
  },
  {
    head: 'Lingerie and bras - shop the new collection',
    body: 'Find your perfect fit with our bra size calculator. Shop lace bralettes, ' +
      'push-up bras, sports bras, panties and sleepwear. Free returns on all orders ' +
      'and free shipping over fifty dollars.',
  },
];

// Short strings that put v3 behind a safety catch, or that it scored adult.
const V3_REGRESSIONS = [
  'videos',
  'video tutorials cooking video recipes video guide videos channel',
  'april 16 español',
  'showing page 4 of 19 results',
  'this forum thread reviews movies and music some links may be nsfw so browse carefully',
];

test('behaviour: explicit adult pages clear the Balanced block bar', () => {
  const { TC, model } = core();
  const bar = TC.thresholdsFor(model, 'balanced').block;
  for (const page of ADULT_PAGES) {
    const p = pageProb(page);
    assert.ok(p >= bar, `expected >= ${bar.toFixed(3)} for ${JSON.stringify(page.head)}, got ${p.toFixed(3)}`);
  }
});

test('behaviour: trap pages stay under even the Strict block bar', () => {
  const { TC, model } = core();
  const bar = TC.thresholdsFor(model, 'strict').block;
  for (const page of TRAP_PAGES) {
    const p = pageProb(page);
    assert.ok(p < bar, `trap page ${JSON.stringify(page.head)} scored ${p.toFixed(3)} (strict bar ${bar.toFixed(3)})`);
  }
});

test('behaviour: the v3 regressions stay under the Strict block bar', () => {
  const { TC, model } = core();
  const bar = TC.thresholdsFor(model, 'strict').block;
  for (const body of V3_REGRESSIONS) {
    const p = pageProb({ head: '', body });
    assert.ok(p < bar, `${JSON.stringify(body)} scored ${p.toFixed(3)} (strict bar ${bar.toFixed(3)})`);
  }
});

test('behaviour: scores are graded, not saturated at 0 and 1', () => {
  // v3 returned exactly 0.0000 or 1.0000 for every real page, which made its
  // strictness setting and the blocked page's confidence meaningless.
  const probs = [...ADULT_PAGES, ...TRAP_PAGES].map(pageProb);
  const interior = probs.filter(p => p > 0.001 && p < 0.999);
  assert.ok(interior.length >= 2, `expected graded scores, got ${probs.map(p => p.toFixed(4)).join(', ')}`);
});

test('behaviour: one explicit passage inside a long ordinary page is still found', () => {
  // v3 scored this at 0.0000: 700 benign words outvoted one explicit sentence.
  const { model, TC } = core();
  const filler = 'The city council met on Tuesday to discuss the new library budget, road ' +
    'repairs on the east side, and a proposal to extend bus service into the evening. ';
  const explicit = 'Watch hardcore porn videos free, naked milf sex and xxx anal clips here. ';
  const body = filler.repeat(12) + explicit + filler.repeat(12);
  const r = TC.scorePage({ head: 'City council news', body }, model);
  const top = Math.max(...r.body.z);
  assert.ok(top >= 2.2, `the explicit window should score p >= 0.9, top z was ${top.toFixed(2)}`);
  const clean = TC.scorePage({ head: 'City council news', body: filler.repeat(24) }, model);
  assert.ok(Math.max(...clean.body.z) < 0, 'the same page without the passage has no adult window');
});

test('explain: names the words that drove an adult page, strongest first', () => {
  const { TC, model } = core();
  const top = TC.topContributors(ADULT_PAGES[0], model, 6);
  assert.ok(top.length > 0);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].contribution >= top[i].contribution);
  assert.ok(top.every(t => t.contribution > 0));
  const words = top.map(t => t.feature);
  assert.ok(words.some(w => ['porn', 'xxx', 'hardcore', 'sex'].includes(w)),
    `expected an explicit word among ${JSON.stringify(words)}`);
});

test('performance: an 8,000-character page scores in well under a frame', () => {
  const { TC, model } = core();
  const words = 'the quick brown fox jumps over lazy dogs while reading news about ' +
    'weather sports music travel cooking science history and technology today ';
  let body = '';
  while (body.length < 8000) body += words;
  TC.scorePage({ head: 'warm up', body }, model); // warm the token cache like a rescan would
  const t0 = process.hrtime.bigint();
  TC.scorePage({ head: 'News', body: body + ' fresh words ' + Date.now() }, model);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `scorePage took ${ms.toFixed(1)} ms`);
});
