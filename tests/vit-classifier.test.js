// shared/vit-classifier.js — the graph-model loader for vit384.
//
// The real weights are not in the repo (they are fetched at runtime and cached
// locally), so these tests drive the module against stubbed tf / fetch /
// caches. What they pin is everything that would silently produce a wrong
// answer rather than an error:
//   - shard order and concatenation (weights read in the wrong order decode to
//     garbage, not to an exception)
//   - the local cache actually being consulted, and a cache miss still working
//   - preprocessing arithmetic matching what the model was converted for
//   - which of the two output logits is treated as NSFW
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const REGISTRY_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'ai-image-models.js'), 'utf8');
const CLASSIFIER_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'vit-classifier.js'), 'utf8');

const INPUT_SIZE = 384;

// A model.json shaped like tensorflowjs_converter's graph output.
function fakeTopology(shardCount = 3) {
  const paths = [];
  for (let i = 1; i <= shardCount; i++) paths.push(`group1-shard${i}of${shardCount}.bin`);
  return {
    format: 'graph-model',
    modelTopology: { node: [{ name: 'input' }, { name: 'logits' }] },
    weightsManifest: [{
      paths,
      weights: [{ name: 'w', shape: [2], dtype: 'float32' }]
    }]
  };
}

// Minimal tf stand-in. Tensors are plain objects carrying their data so the
// assertions can inspect what the module actually computed.
function makeTfStub({ logits = [2.0, 0.0] } = {}) {
  const disposed = [];
  const tensor = (data, shape) => ({
    data: async () => Float32Array.from(data),
    shape,
    _data: data,
    dispose() { disposed.push(this); }
  });

  const tf = {
    loadGraphModel: async (handler) => {
      const artifacts = await handler.load();
      return {
        _artifacts: artifacts,
        predict: () => tensor(logits, [1, 2])
      };
    },
    io: {
      // Mirrors tf.io.fromMemory: wraps artifacts in a loader.
      fromMemory: (artifacts) => ({ load: async () => artifacts })
    },
    tensor4d: (values, shape) => tensor(values, shape),
    reshape: (t, shape) => tensor(t._data, shape),
    softmax: (t) => {
      const values = Array.from(t._data);
      const max = Math.max(...values);
      const exps = values.map((v) => Math.exp(v - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      return tensor(exps.map((e) => e / sum), t.shape);
    }
  };
  return { tf, disposed };
}

// `imageData` is the RGBA the canvas hands back for the resized image.
function makeCanvasStub(fillRgba) {
  const drawn = [];
  return {
    drawn,
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage: (bitmap, x, y, w, h) => drawn.push({ bitmap, x, y, w, h }),
          getImageData: (x, y, w, h) => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) {
              data[i] = fillRgba[0];
              data[i + 1] = fillRgba[1];
              data[i + 2] = fillRgba[2];
              data[i + 3] = fillRgba[3];
            }
            return { data, width: w, height: h };
          }
        };
      }
    }
  };
}

function loadClassifier({
  topology = fakeTopology(),
  shardBytes = null,
  cacheSeed = new Map(),
  tfStub = makeTfStub(),
  fillRgba = [255, 0, 0, 255],
  failShard = null,
  topologyMissing = false
} = {}) {
  const fetched = [];
  const cachePuts = [];
  const cacheStore = new Map(cacheSeed);

  // Each shard is filled with its own index so concatenation order is visible
  // in the assembled buffer.
  const shardFor = (name, index) => {
    if (shardBytes && shardBytes[name]) return shardBytes[name];
    return new Uint8Array([index, index, index, index]).buffer;
  };
  const shardIndex = {};
  // Tolerate a malformed/absent manifest: some tests hand one in deliberately.
  const manifestPaths =
    (topology && topology.weightsManifest && topology.weightsManifest[0] &&
      topology.weightsManifest[0].paths) || [];
  manifestPaths.forEach((p, i) => { shardIndex[p] = i + 1; });

  const makeResponse = (body, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => body,
    clone() { return this; }
  });

  const canvas = makeCanvasStub(fillRgba);

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Object, Array, Math, JSON, Map, Set, Promise, Error, Number,
    Uint8Array, Uint8ClampedArray, Float32Array, ArrayBuffer,
    setTimeout, clearTimeout,
    tf: tfStub.tf,
    OffscreenCanvas: canvas.OffscreenCanvas,
    chrome: { runtime: { getURL: (p) => 'chrome-extension://test/' + p } },
    fetch: async (url) => {
      fetched.push(url);
      if (String(url).startsWith('chrome-extension://')) {
        // A missing extension resource rejects; it does not return !ok.
        if (topologyMissing) throw new Error('net::ERR_FILE_NOT_FOUND');
        return makeResponse(topology);
      }
      const name = String(url).split('/').pop().split('?')[0];
      if (failShard && name === failShard) return makeResponse(null, false, 502);
      return makeResponse(shardFor(name, shardIndex[name] || 0));
    },
    caches: {
      open: async () => ({
        match: async (key) => cacheStore.get(key) || undefined,
        put: async (key, value) => { cachePuts.push(key); cacheStore.set(key, value); },
        delete: async (key) => cacheStore.delete(key)
      }),
      delete: async () => { cacheStore.clear(); return true; }
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(REGISTRY_SOURCE, sandbox, { filename: 'shared/ai-image-models.js' });
  vm.runInContext(CLASSIFIER_SOURCE, sandbox, { filename: 'shared/vit-classifier.js' });

  return {
    api: sandbox.VitClassifier,
    models: sandbox.AiImageModels,
    fetched,
    cachePuts,
    cacheStore,
    canvas,
    disposed: tfStub.disposed,
    makeResponse
  };
}

// ─── manifest handling ───────────────────────────────────────────────────

test('readManifest flattens shard paths and weight specs in order', () => {
  const h = loadClassifier();
  const manifest = h.api.readManifest({
    weightsManifest: [
      { paths: ['a.bin', 'b.bin'], weights: [{ name: 'w1' }] },
      { paths: ['c.bin'], weights: [{ name: 'w2' }, { name: 'w3' }] }
    ]
  });
  assert.deepEqual(Array.from(manifest.paths), ['a.bin', 'b.bin', 'c.bin']);
  assert.deepEqual(Array.from(manifest.specs, (spec) => spec.name), ['w1', 'w2', 'w3']);
});

test('readManifest rejects a malformed model.json instead of loading nothing', () => {
  const h = loadClassifier();
  assert.throws(() => h.api.readManifest({}), /no weightsManifest/);
  assert.throws(() => h.api.readManifest({ weightsManifest: [] }), /no weightsManifest/);
  assert.throws(() => h.api.readManifest({ weightsManifest: [{ paths: [], weights: [] }] }),
    /no shards/);
  assert.throws(() => h.api.readManifest({ weightsManifest: [{ paths: ['a.bin'], weights: [] }] }),
    /no weights/);
});

test('concatBuffers preserves byte order across shards', () => {
  const h = loadClassifier();
  const out = new Uint8Array(h.api.concatBuffers([
    new Uint8Array([1, 2]).buffer,
    new Uint8Array([3]).buffer,
    new Uint8Array([4, 5, 6]).buffer
  ]));
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6]);
});

test('the shard cache key carries the weights version', () => {
  const h = loadClassifier();
  const key = h.api.shardCacheKey(h.models.getModel('vit384'), 'group1-shard1of3.bin');
  assert.match(key, /group1-shard1of3\.bin\?v=1$/);
  // A version bump must produce a different key, or clients serve stale
  // weights from cache forever after a re-publish.
  const bumped = h.api.shardCacheKey(
    { ...h.models.getModel('vit384'), weightsVersion: 2 },
    'group1-shard1of3.bin'
  );
  assert.notEqual(key, bumped);
});

// ─── load() ──────────────────────────────────────────────────────────────

test('load fetches the packaged topology and every shard, in manifest order', async () => {
  const h = loadClassifier({ topology: fakeTopology(3) });
  const model = await h.api.load('vit384');

  // Topology from the package, shards from the remote host.
  assert.match(h.fetched[0], /^chrome-extension:\/\/test\/models\/vit384\/model\.json$/);
  const shardFetches = h.fetched.slice(1).map((u) => String(u).split('/').pop());
  assert.deepEqual(shardFetches, [
    'group1-shard1of3.bin',
    'group1-shard2of3.bin',
    'group1-shard3of3.bin'
  ]);

  // Assembled in that same order: each stub shard is filled with its index.
  const bytes = new Uint8Array(model._artifacts.weightData);
  assert.deepEqual(Array.from(bytes), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  assert.equal(
    JSON.stringify(model._artifacts.modelTopology),
    JSON.stringify(fakeTopology().modelTopology)
  );
  assert.equal(model._artifacts.weightSpecs.length, 1);
});

test('load reports progress so a 22 MB first download is visible', async () => {
  const h = loadClassifier({ topology: fakeTopology(3) });
  const seen = [];
  await h.api.load('vit384', (p) => seen.push(p));

  const phases = seen.map((p) => p.phase);
  assert.ok(phases.includes('topology'));
  assert.ok(phases.includes('weights'));
  assert.ok(phases.includes('ready'));

  const weightTicks = seen.filter((p) => p.phase === 'weights');
  assert.equal(weightTicks[0].total, 3);
  assert.equal(weightTicks[weightTicks.length - 1].loaded, 3);
});

test('load caches fetched shards, and a second load re-uses them', async () => {
  const h = loadClassifier({ topology: fakeTopology(2) });
  await h.api.load('vit384');
  assert.equal(h.cachePuts.length, 2, 'both shards should be cached');

  const before = h.fetched.length;
  await h.api.load('vit384');
  // Only the packaged topology is re-read; the shards come from the cache.
  const newFetches = h.fetched.slice(before).filter((u) => !String(u).startsWith('chrome-extension://'));
  assert.deepEqual(newFetches, [], 'a cached shard must not be re-downloaded');
});

test('a failed shard download surfaces as an error, not as a half-built model', async () => {
  const h = loadClassifier({ topology: fakeTopology(3), failShard: 'group1-shard2of3.bin' });
  await assert.rejects(h.api.load('vit384'), /group1-shard2of3\.bin: HTTP 502/);
});

test('isCached is false until every shard is present', async () => {
  const h = loadClassifier({ topology: fakeTopology(2) });
  assert.equal(await h.api.isCached('vit384'), false);
  await h.api.load('vit384');
  assert.equal(await h.api.isCached('vit384'), true);

  // Losing one shard (quota eviction) must read as "not cached", so the
  // options page does not claim the model is ready to run offline.
  const firstKey = Array.from(h.cacheStore.keys())[0];
  h.cacheStore.delete(firstKey);
  assert.equal(await h.api.isCached('vit384'), false);
});

test('the bundled model reports no remote weights rather than throwing', async () => {
  const h = loadClassifier();
  assert.equal(await h.api.isCached('nsfwjs'), false);
  await assert.rejects(h.api.load('nsfwjs'), /not a graph model/);
});

test('topologyStatus reports available when the packaged graph is present', async () => {
  const h = loadClassifier({ topology: fakeTopology(2) });
  const status = await h.api.topologyStatus('vit384');
  assert.equal(status.available, true);
  assert.equal(status.error, '');
});

test('topologyStatus reports unavailable when the packaged graph is absent', async () => {
  // The case that made "Download model now" look broken: a build made before
  // the model was converted has no models/vit384/model.json, so no amount of
  // retrying can help and the UI must say so instead of offering a download.
  const h = loadClassifier({ topologyMissing: true });
  const status = await h.api.topologyStatus('vit384');
  assert.equal(status.available, false);
  assert.match(status.error, /does not include the vit384 model graph/);
});

test('topologyStatus reports unavailable for a malformed packaged graph', async () => {
  const h = loadClassifier({ topology: { format: 'graph-model' } });
  const status = await h.api.topologyStatus('vit384');
  assert.equal(status.available, false);
  assert.match(status.error, /does not include the vit384 model graph/);
});

test('the bundled model is always available', async () => {
  const h = loadClassifier();
  const status = await h.api.topologyStatus('nsfwjs');
  assert.equal(status.available, true);
  assert.equal(status.error, '');
});

test('clearCachedWeights removes the shards', async () => {
  const h = loadClassifier({ topology: fakeTopology(2) });
  await h.api.load('vit384');
  assert.equal(await h.api.isCached('vit384'), true);
  await h.api.clearCachedWeights('vit384');
  assert.equal(await h.api.isCached('vit384'), false);
});

// ─── classify() ──────────────────────────────────────────────────────────

test('classify normalizes to (x/255 - 0.5) / 0.5 in NHWC', async () => {
  // Pure red: R=255 -> (1 - 0.5)/0.5 = 1; G=B=0 -> (0 - 0.5)/0.5 = -1.
  const h = loadClassifier({ fillRgba: [255, 0, 0, 255] });
  const model = await h.api.load('vit384');
  await h.api.classify(model, { fake: 'bitmap' }, 'vit384');

  // The canvas is the model's input size, and the bitmap is drawn to fill it.
  assert.equal(h.canvas.drawn.length, 1);
  assert.equal(h.canvas.drawn[0].w, INPUT_SIZE);
  assert.equal(h.canvas.drawn[0].h, INPUT_SIZE);

  const input = h.disposed.find((t) => t.shape && t.shape.length === 4);
  assert.ok(input, 'an input tensor should have been created and disposed');
  assert.deepEqual(Array.from(input.shape), [1, INPUT_SIZE, INPUT_SIZE, 3]);
  assert.equal(input._data.length, INPUT_SIZE * INPUT_SIZE * 3);
  // Alpha dropped, channels in RGB order.
  assert.equal(input._data[0], 1);
  assert.equal(input._data[1], -1);
  assert.equal(input._data[2], -1);
});

test('classify softmaxes the logits and reads NSFW from index 0', async () => {
  // logits [2, 0] -> softmax ≈ [0.8808, 0.1192], NSFW first.
  const h = loadClassifier({ tfStub: makeTfStub({ logits: [2.0, 0.0] }) });
  const model = await h.api.load('vit384');
  const scores = await h.api.classify(model, { fake: 'bitmap' }, 'vit384');

  assert.ok(Math.abs(scores.NSFW - 0.8807971) < 1e-5, `got ${scores.NSFW}`);
  assert.ok(Math.abs(scores.SFW - 0.1192029) < 1e-5, `got ${scores.SFW}`);
  assert.ok(Math.abs(scores.NSFW + scores.SFW - 1) < 1e-6);
});

test('classify returns the score shape the rest of the pipeline expects', async () => {
  const h = loadClassifier({ tfStub: makeTfStub({ logits: [0.0, 3.0] }) });
  const model = await h.api.load('vit384');
  const scores = await h.api.classify(model, { fake: 'bitmap' }, 'vit384');

  assert.deepEqual(Object.keys(scores).sort(), ['NSFW', 'SFW']);
  assert.equal(h.models.scoresMatchModel(scores, 'vit384'), true);
  assert.equal(h.models.scoresMatchModel(scores, 'nsfwjs'), false);
  // A confident SFW image.
  assert.ok(scores.NSFW < 0.05);
});

test('classify releases its tensors', async () => {
  const h = loadClassifier();
  const model = await h.api.load('vit384');
  const before = h.disposed.length;
  await h.api.classify(model, { fake: 'bitmap' }, 'vit384');
  // input + logits + softmax output.
  assert.equal(h.disposed.length - before, 3);
});
