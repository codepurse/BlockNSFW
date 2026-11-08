// The real n017 (Wingman Jr. N017) artifacts, checked against what the runtime
// expects. The companion of tests/vit384-artifacts.test.js.
//
// tests/vit-classifier.test.js drives the loader against a stubbed model; this
// checks the actual files, because a mismatch fails silently: a missing or
// truncated shard decodes to garbage scores (or, in tfjs, to an empty tensor
// deep inside load), and a wrong input layout produces confident nonsense.
//
// Source: github.com/wingman-jr-addon/model, N017/tfjs/n017_graph_model/, used
// unmodified. See data/models/n017/NOTICE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Models = require('../shared/ai-image-models.js');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'models', 'n017', 'model.json');
// Where the shards are published from: this repo (N017_WEIGHTS_BASE_URL).
const SHARD_DIR = path.join(ROOT, 'data', 'models', 'n017');

const present = fs.existsSync(GRAPH_PATH);
const readGraph = () => JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));

function manifestPaths(graph) {
  const paths = [];
  for (const group of graph.weightsManifest) {
    for (const p of group.paths || []) paths.push(p);
  }
  return paths;
}

const BYTES = { float32: 4, int32: 4, bool: 1, uint8: 1, int8: 1, float16: 2, uint16: 2, int16: 2 };

test('the packaged n017 graph is present', () => {
  assert.equal(present, true, 'models/n017/model.json is missing');
});

test('the graph is a tfjs graph-model the vendored runtime can load', { skip: !present }, () => {
  const graph = readGraph();
  assert.equal(graph.format, 'graph-model');
  assert.ok(graph.modelTopology && Array.isArray(graph.modelTopology.node), 'no graph nodes');
  assert.ok(Array.isArray(graph.weightsManifest), 'no weightsManifest');
});

test('the graph input matches the registry input size, in NHWC', { skip: !present }, () => {
  const graph = readGraph();
  const first = Object.values((graph.signature && graph.signature.inputs) || {})[0];
  assert.ok(first, 'the graph declares no input signature');
  const dims = first.tensorShape.dim.map((d) => Number(d.size));
  const size = Models.getModel('n017').inputSize;
  assert.deepEqual(dims, [1, size, size, 3], `expected [1,${size},${size},3] NHWC`);
  assert.equal(first.dtype, 'DT_FLOAT');
});

test('the graph emits the unsafe score [1,1] and the S/Q/R/X split [1,4]', { skip: !present }, () => {
  // classify() tells the two outputs apart by their last dimension, so
  // exactly one of each must exist.
  const outputs = (readGraph().signature && readGraph().signature.outputs) || {};
  const shapes = Object.values(outputs).map((o) => o.tensorShape.dim.map((d) => Number(d.size)));
  assert.equal(shapes.length, 2, 'expected exactly two outputs');
  assert.deepEqual(shapes.map((s) => s[s.length - 1]).sort(), [1, 4]);
  assert.ok(Object.prototype.hasOwnProperty.call(outputs, 'unsafe_score'));
  assert.ok(Object.prototype.hasOwnProperty.call(outputs, 'sqrx_probabilities'));
});

test('every shard the manifest names is published, at the size the manifest needs', { skip: !present }, () => {
  const graph = readGraph();
  const paths = manifestPaths(graph);
  assert.ok(paths.length > 0, 'the manifest names no shards');
  const missing = paths.filter((p) => !fs.existsSync(path.join(SHARD_DIR, p)));
  assert.deepEqual(missing, [], 'shards named by models/n017/model.json but absent from data/models/n017/');

  // A truncated shard loads without error and decodes trailing weights as
  // empty tensors, so check the bytes add up.
  let expected = 0;
  for (const group of graph.weightsManifest) {
    for (const w of group.weights) {
      const n = (w.shape || []).reduce((a, b) => a * b, 1);
      assert.ok(BYTES[w.dtype], `unexpected weight dtype ${w.dtype}`);
      expected += n * BYTES[w.dtype];
    }
  }
  const actual = paths.reduce((sum, p) => sum + fs.statSync(path.join(SHARD_DIR, p)).size, 0);
  assert.equal(actual, expected, 'published shard bytes do not match the weight manifest');
});

test('no stray shard is published that the manifest does not name', { skip: !present }, () => {
  const named = new Set(manifestPaths(readGraph()));
  const stray = fs.readdirSync(SHARD_DIR).filter((f) => f.endsWith('.bin') && !named.has(f));
  assert.deepEqual(stray, [], 'unreferenced shards in data/models/n017/');
});

test('the weight shards are NOT in the extension package', { skip: !present }, () => {
  const bins = fs.readdirSync(path.join(ROOT, 'models', 'n017')).filter((f) => f.endsWith('.bin'));
  assert.deepEqual(bins, [], 'weight shards found in models/n017/; they belong in data/models/n017/');
});

test('the Apache-2.0 notice travels with the published weights', () => {
  const notice = fs.readFileSync(path.join(SHARD_DIR, 'NOTICE'), 'utf8');
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /wingman-jr-addon\/model/);
});
