// Tests for shared/text-classifier-core.js — the pure AI Text Blocker core.
// Mirrors the vm-sandbox style of ai-image-blocker-core.test.js.
//
// The golden-vector tests are the load-bearing ones: they assert the JS feature
// hashing matches what tools/train_text_classifier.py produced
// (tools/seed_data/golden_vectors.json). If those drift, trained weights stop
// lining up with inference features and the model silently degrades.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'shared', 'text-classifier-core.js'),
  'utf8'
);

function loadCore() {
  const sandbox = {
    console,
    Map,
    Set,
    Math,
    Array,
    Object,
    JSON,
    String,
    Number,
    parseInt,
    Error,
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'text-classifier-core.js' });
  return sandbox.module.exports;
}

function loadGolden() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools', 'seed_data', 'golden_vectors.json'), 'utf8')
  );
}

function loadModelJson() {
  const p = path.join(ROOT, 'text-model.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
test('normalizeForClassifier: NFKC + lowercase + whitespace collapse', () => {
  const TC = loadCore();
  assert.equal(TC.normalizeForClassifier('Free  Porn\tVideo'), 'free porn video');
  assert.equal(TC.normalizeForClassifier('   trim me   '), 'trim me');
  assert.equal(TC.normalizeForClassifier(null), '');
  assert.equal(TC.normalizeForClassifier(123), '');
});

test('fnv1a32 + hashFeature are deterministic and in range', () => {
  const TC = loadCore();
  const dim = TC.DEFAULT_DIM;
  const a = TC.hashFeature('#abc', dim);
  const b = TC.hashFeature('#abc', dim);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < dim);
  // Different strings should (essentially always) differ.
  assert.notEqual(TC.hashFeature('#abc', dim), TC.hashFeature('#abd', dim));
});

test('golden hash parity: JS buckets match the Python trainer', () => {
  const TC = loadCore();
  const golden = loadGolden();
  assert.equal(golden.dim, TC.DEFAULT_DIM, 'dim must match the JS core');
  for (const { s, bucket } of golden.hashes) {
    assert.equal(
      TC.hashFeature(s, golden.dim),
      bucket,
      `hashFeature mismatch for ${JSON.stringify(s)}`
    );
  }
});

test('golden extraction parity: full feature pipeline matches Python', () => {
  const TC = loadCore();
  const golden = loadGolden();
  const opts = { dim: golden.dim, ngramMin: golden.ngramMin, ngramMax: golden.ngramMax };
  for (const ex of golden.extractions) {
    const norm = TC.normalizeForClassifier(ex.text);
    assert.equal(norm, ex.norm, `normalize mismatch for ${JSON.stringify(ex.text)}`);
    const feats = TC.extractFeatures(norm, opts);
    const got = {};
    feats.forEach((count, bucket) => { got[String(bucket)] = count; });
    assert.deepEqual(
      got,
      ex.buckets,
      `feature buckets mismatch for ${JSON.stringify(ex.text)}`
    );
  }
});

test('extractFeatures: empty input yields no features', () => {
  const TC = loadCore();
  const feats = TC.extractFeatures('', { dim: TC.DEFAULT_DIM, ngramMin: 3, ngramMax: 5 });
  assert.equal(feats.size, 0);
});

test('loadModel: parses sparse int8 weights and dequantizes', () => {
  const TC = loadCore();
  const model = TC.loadModel({
    version: 1, dim: 262144, ngramMin: 3, ngramMax: 5,
    bias: -0.5, scale: 0.01, weights: [[10, 100], [20, -50]],
  });
  assert.equal(model.dim, 262144);
  assert.equal(model.bias, -0.5);
  assert.ok(Math.abs(model.weights.get(10) - 1.0) < 1e-9);
  assert.ok(Math.abs(model.weights.get(20) + 0.5) < 1e-9);
});

test('loadModel: fails closed (null) on malformed input', () => {
  const TC = loadCore();
  assert.equal(TC.loadModel(null), null);
  assert.equal(TC.loadModel({ dim: 1, weights: 42 }), null);
});

test('scoreText: returns -1 (no opinion) when model is missing', () => {
  const TC = loadCore();
  assert.equal(TC.scoreText('whatever', null), -1);
});

test('scoreText (seed model): adult clears block bar, benign stays below fuse bar', () => {
  const TC = loadCore();
  const json = loadModelJson();
  assert.ok(json, 'text-model.json must exist (run --bootstrap)');
  const model = TC.loadModel(json);
  assert.ok(model, 'model should load');

  // Assert against the real operating points: balanced block=0.90, fuse=0.60
  // (see getAiTextThresholds in content.js). Adult should be blockable on text
  // alone; benign should never even reach the fusion bar.
  const BLOCK = 0.90;
  const FUSE = 0.60;

  const adultSamples = [
    'porno gratis videos porno',
    'watch free porn video hd',
    'порно онлайн смотреть',           // Russian
    '无码视频 成人网站',                  // Chinese
    'video bokep indo',                 // Indonesian
    '야동 성인사이트',                    // Korean
  ];
  const benignSamples = [
    'chicken breast recipe healthy and easy',
    'sex education helps teenagers make healthy choices',
    'latest technology news and product reviews',
    'breast cancer awareness month medical screening',
    'nude lipstick shade natural everyday makeup',  // ambiguous token, safe context
    'the naked truth about our finances this year',
  ];

  for (const t of adultSamples) {
    const p = TC.scoreText(t, model);
    assert.ok(p >= BLOCK, `expected adult score >=${BLOCK} for ${JSON.stringify(t)}, got ${p}`);
  }
  for (const t of benignSamples) {
    const p = TC.scoreText(t, model);
    assert.ok(p < FUSE, `expected benign score <${FUSE} for ${JSON.stringify(t)}, got ${p}`);
  }
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
