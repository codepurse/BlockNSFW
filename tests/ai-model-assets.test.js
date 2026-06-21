const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const modelPath = path.join(__dirname, '..', 'nsfwjs', 'model.json');
const modelDir = path.dirname(modelPath);

test('AI model manifest paths resolve to a packaged shard or .bin fallback', () => {
  const modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const manifests = Array.isArray(modelJson.weightsManifest) ? modelJson.weightsManifest : [];

  assert.ok(manifests.length > 0, 'weightsManifest should exist');

  for (const group of manifests) {
    const paths = Array.isArray(group.paths) ? group.paths : [];
    for (const relativePath of paths) {
      const directPath = path.join(modelDir, relativePath);
      const binFallbackPath = `${directPath}.bin`;
      const exists = fs.existsSync(directPath) || fs.existsSync(binFallbackPath);
      assert.equal(exists, true, `missing shard for ${relativePath}`);
    }
  }
});
