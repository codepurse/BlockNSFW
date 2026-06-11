const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
);

test('manifest extension_pages CSP allows wasm for AI runtime', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(csp, /wasm-unsafe-eval/);
  assert.match(csp, /script-src 'self'/);
});
