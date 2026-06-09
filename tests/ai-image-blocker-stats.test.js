// Regression: aiImageBlockedCount is defined in background.js's
// DEFAULT_STATS object. We verify by source-string match because const
// declarations are not reachable through the vm sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('background.js declares aiImageBlockedCount in DEFAULT_STATS', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'), 'utf8'
  );
  assert.match(
    source,
    /aiImageBlockedCount\s*:\s*0/,
    'DEFAULT_STATS should initialize aiImageBlockedCount to 0'
  );
});

test('background.js handles the image_ai_filtered message', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'), 'utf8'
  );
  assert.match(
    source,
    /['"]image_ai_filtered['"]/,
    'background.js should reference the image_ai_filtered message type'
  );
});
