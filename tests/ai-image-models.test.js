// The model registry: thresholds, id normalization, and score-shape identity.
//
// These are the invariants the three inference routes (offscreen document,
// service worker, Firefox event page) and the content script all depend on to
// agree with each other.
const test = require('node:test');
const assert = require('node:assert/strict');
const Models = require('../shared/ai-image-models.js');

test('both models are registered with the fields every caller reads', () => {
  for (const id of ['nsfwjs', 'vit384']) {
    const model = Models.getModel(id);
    assert.ok(model, `${id} should be registered`);
    assert.equal(model.id, id);
    assert.equal(typeof model.label, 'string');
    assert.equal(typeof model.inputSize, 'number');
    assert.ok(model.inputSize > 0);
    assert.equal(typeof model.modelPath, 'string');
    assert.ok(Array.isArray(model.scoreKeys) && model.scoreKeys.length > 0);
    for (const level of ['relaxed', 'balanced', 'strict']) {
      assert.ok(model.thresholds[level], `${id} needs a ${level} preset`);
    }
  }
});

test('the bundled model is the default, so a fresh install works offline', () => {
  assert.equal(Models.DEFAULT_MODEL_ID, 'nsfwjs');
  assert.equal(Models.getModel('nsfwjs').bundled, true);
  assert.equal(Models.getModel('vit384').bundled, false);
});

test('resolveModel never returns null — a corrupt setting degrades to the default', () => {
  for (const bad of [undefined, null, '', 'nope', 'VIT384 ', 42, {}]) {
    const model = Models.resolveModel(bad);
    assert.ok(model);
    assert.equal(model.id, 'nsfwjs');
  }
  assert.equal(Models.normalizeModelId('vit384'), 'vit384');
});

test('getThresholds returns the right bar shape per model', () => {
  const mobilenet = Models.getThresholds('nsfwjs', 'balanced');
  assert.equal(mobilenet.model, 'nsfwjs');
  assert.equal(mobilenet.pornHentai, 0.60);
  assert.equal(mobilenet.sexy, 0.90);
  assert.equal(mobilenet.nsfw, undefined);

  const vit = Models.getThresholds('vit384', 'balanced');
  assert.equal(vit.model, 'vit384');
  assert.equal(vit.nsfw, 0.30);
  assert.equal(vit.pornHentai, undefined);
});

test('strictness moves each model bar in the blocking direction', () => {
  const relaxed = Models.getThresholds('nsfwjs', 'relaxed');
  const strict = Models.getThresholds('nsfwjs', 'strict');
  // Lower bar = blocks more.
  assert.ok(strict.pornHentai < relaxed.pornHentai);
  assert.ok(strict.sexy < relaxed.sexy);

  assert.ok(Models.getThresholds('vit384', 'strict').nsfw <
    Models.getThresholds('vit384', 'relaxed').nsfw);
});

test('unknown strictness falls back to balanced rather than throwing', () => {
  assert.deepEqual(
    Models.getThresholds('vit384', 'bogus'),
    Models.getThresholds('vit384', 'balanced')
  );
  assert.equal(Models.normalizeStrictness('STRICT'), 'strict');
});

test('the two models have disjoint score keys, so cached scores are identifiable', () => {
  const a = new Set(Models.getModel('nsfwjs').scoreKeys);
  const b = new Set(Models.getModel('vit384').scoreKeys);
  for (const key of b) {
    assert.equal(a.has(key), false, `${key} appears in both models' score shapes`);
  }
});

test('scoresMatchModel tells the two score shapes apart', () => {
  const mobilenetScores = { Porn: 0.1, Hentai: 0.0, Sexy: 0.8, Drawing: 0.05, Neutral: 0.05 };
  const vitScores = { NSFW: 0.8, SFW: 0.2 };

  assert.equal(Models.scoresMatchModel(mobilenetScores, 'nsfwjs'), true);
  assert.equal(Models.scoresMatchModel(mobilenetScores, 'vit384'), false);
  assert.equal(Models.scoresMatchModel(vitScores, 'vit384'), true);
  assert.equal(Models.scoresMatchModel(vitScores, 'nsfwjs'), false);

  for (const junk of [null, undefined, {}, 'nope', 5]) {
    assert.equal(Models.scoresMatchModel(junk, 'nsfwjs'), false);
  }
});

test('weightShardUrl builds an absolute https URL, and only for the fetched model', () => {
  const url = Models.weightShardUrl('vit384', 'group1-shard1of6.bin');
  assert.match(url, /^https:\/\//);
  assert.match(url, /group1-shard1of6\.bin$/);
  // A leading slash in the manifest path must not produce a double slash.
  assert.equal(
    Models.weightShardUrl('vit384', '/group1-shard1of6.bin'),
    Models.weightShardUrl('vit384', 'group1-shard1of6.bin')
  );
  // The bundled model has no remote weights.
  assert.equal(Models.weightShardUrl('nsfwjs', 'anything.bin'), null);
});

test("every vit384 preset sits inside the model's usable range", () => {
  // Calibration guard, not a style check. Two hard bounds, both measured:
  //
  //   lower: safe photos score up to ~0.094 on this model, so a bar at or
  //          below that blurs ordinary pictures.
  //   upper: Marqo's threshold evaluation shows recall collapsing past ~0.9,
  //          so a bar above it silently stops blocking almost everything.
  //
  // The first cut of these presets had relaxed at 0.90 — right on the cliff —
  // which is how the ViT ended up performing worse in practice than the
  // MobileNet it replaced.
  const SAFE_CEILING = 0.094;
  const RECALL_CLIFF = 0.90;

  for (const level of ['relaxed', 'balanced', 'strict']) {
    const bar = Models.getThresholds('vit384', level).nsfw;
    assert.ok(bar > SAFE_CEILING,
      `${level} bar ${bar} is at or below the measured safe-photo ceiling`);
    assert.ok(bar < RECALL_CLIFF,
      `${level} bar ${bar} is at or past the recall cliff`);
  }
});
