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

// A user wrote in: images on Spotify and YouTube were plainly blurred, yet the
// popup and the stats page said 0. The AI's blurs land in their own fields and
// neither figure read them.
test('the popup counts the AI\'s blurs among images today', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const line = source.slice(source.indexOf("$('images-filtered')"));
  assert.match(line.slice(0, 300), /dailyStats\.imageBlocked\b[\s\S]*dailyStats\.imageAiBlocked\b/);
});

test('the stats page counts the AI\'s blurs among images blocked', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'stats.js'), 'utf8');
  const line = source.slice(source.indexOf("$('images-filtered')"));
  assert.match(line.slice(0, 300), /stats\.imageBlockedCount\b[\s\S]*stats\.aiImageBlockedCount\b/);
});

// The page-reading checks each reported the block and then called
// redirectToBlockedPage, which reports it too, so every page they held counted
// twice under "websites blocked".
test('a page held by reading it is reported once', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const reports = source.match(/notifyBackground\('website_blocked'/g) || [];
  assert.equal(reports.length, 1, 'only redirectToBlockedPage reports a held page');
  const start = source.indexOf('function redirectToBlockedPage(');
  assert.ok(start >= 0 && source.indexOf("notifyBackground('website_blocked'", start) > start);
});
