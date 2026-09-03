// The real vit384 artifacts, checked against what the runtime expects.
//
// tests/vit-classifier.test.js drives the loader against a stubbed model; this
// checks the actual converted files, because a mismatch here fails silently:
// wrong weight order or a missing shard decodes to garbage scores rather than
// throwing, and a wrong input size just produces confident nonsense.
//
// Regenerate the artifacts with tools/convert_vit384.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Models = require('../shared/ai-image-models.js');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'models', 'vit384', 'model.json');
// Where the shards are published from (this repo is the host — see
// VIT384_WEIGHTS_BASE_URL in shared/ai-image-models.js).
const SHARD_DIR = path.join(ROOT, 'data', 'models', 'vit384');

const present = fs.existsSync(GRAPH_PATH);

test('the packaged vit384 graph is present', () => {
  assert.equal(present, true,
    'models/vit384/model.json is missing — run tools/convert_vit384.py');
});

test('the graph is a tfjs graph-model the vendored runtime can load', { skip: !present }, () => {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  assert.equal(graph.format, 'graph-model',
    'loadGraphModel needs a graph-model, not a layers model');
  assert.ok(graph.modelTopology, 'no modelTopology');
  assert.ok(Array.isArray(graph.modelTopology.node), 'no graph nodes');
  assert.ok(Array.isArray(graph.weightsManifest), 'no weightsManifest');
});

test('the graph input matches the registry input size, in NHWC', { skip: !present }, () => {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const inputs = (graph.signature && graph.signature.inputs) || {};
  const first = Object.values(inputs)[0];
  assert.ok(first, 'the graph declares no input signature');

  const dims = first.tensorShape.dim.map((d) => Number(d.size));
  const size = Models.getModel('vit384').inputSize;
  // toInputTensor() builds exactly this shape; a mismatch means every score
  // is computed from a wrongly-shaped tensor.
  assert.deepEqual(dims, [1, size, size, 3],
    `expected [1,${size},${size},3] NHWC`);
  assert.equal(first.dtype, 'DT_FLOAT');
});

test('the graph emits two logits, and NSFW is a valid index', { skip: !present }, () => {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const outputs = (graph.signature && graph.signature.outputs) || {};
  const first = Object.values(outputs)[0];
  assert.ok(first, 'the graph declares no output signature');

  const dims = first.tensorShape.dim.map((d) => Number(d.size));
  assert.deepEqual(dims, [1, 2], 'classify() reshapes the output to [2]');

  const model = Models.getModel('vit384');
  assert.ok(model.nsfwIndex === 0 || model.nsfwIndex === 1);
  // Marqo publishes label_names ['NSFW', 'SFW'], so NSFW is index 0.
  // Flipping this inverts the entire filter.
  assert.equal(model.nsfwIndex, 0);
});

test('every shard the manifest names is published', { skip: !present }, () => {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const paths = [];
  for (const group of graph.weightsManifest) {
    for (const p of group.paths || []) paths.push(p);
  }
  assert.ok(paths.length > 0, 'the manifest names no shards');

  const missing = paths.filter((p) => !fs.existsSync(path.join(SHARD_DIR, p)));
  assert.deepEqual(missing, [],
    'shards named by models/vit384/model.json but absent from data/models/vit384/');
});

test('no stray shard is published that the manifest does not name', { skip: !present }, () => {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const named = new Set();
  for (const group of graph.weightsManifest) {
    for (const p of group.paths || []) named.add(p);
  }
  const onDisk = fs.existsSync(SHARD_DIR)
    ? fs.readdirSync(SHARD_DIR).filter((f) => f.endsWith('.bin'))
    : [];
  // A leftover shard from an older conversion is dead weight in git and a
  // trap for anyone reading the directory.
  const stray = onDisk.filter((f) => !named.has(f));
  assert.deepEqual(stray, [], 'unreferenced shards in data/models/vit384/');
});

test('the weight shards are NOT in the extension package', { skip: !present }, () => {
  // The whole point of the lazy fetch: the graph ships, the weights do not.
  const packagedDir = path.join(ROOT, 'models', 'vit384');
  const packaged = fs.readdirSync(packagedDir);
  const bins = packaged.filter((f) => f.endsWith('.bin'));
  assert.deepEqual(bins, [],
    'weight shards found in models/vit384/ — they belong in data/models/vit384/');
});
