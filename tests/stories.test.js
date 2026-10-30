// Community stories on a shelf in the Settings sidebar.
//
// Few people found the stories: a small link at the bottom of the sidebar,
// among Statistics and Changelog. They now sit under the sections as a shelf,
// one spine per story as tall as the story is long, this week's in brass, and
// a few words from one story under it (options-stories.js). shared/stories.js
// holds what the shelf and the stories page share: the passage worth quoting,
// and what the shelf keeps of the feed, which is no more than each story's
// title, length, date and a short passage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Stories = require('../shared/stories.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('a short story is quoted whole', () => {
  assert.deepEqual(
    Stories.passage('There will be a day when all of this sadness and addiction goes away.', 30, 100),
    { text: 'There will be a day when all of this sadness and addiction goes away.', excerpt: false }
  );
});

test('a story too short to stand alone is not quoted', () => {
  assert.equal(Stories.passage('Stay strong.', 30, 100), null);
});

test('a long story gives its closing sentences, as many as fit', () => {
  const story = 'Thank you for this blocker. It stopped me. I have been struggling a lot and today I caved in and searched, but thankfully the blocker stopped me.\n\nThe urges will pass. Keep going, all of you.';
  const p = Stories.passage(story, 30, 100);
  assert.equal(p.excerpt, true);
  assert.equal(p.text, 'The urges will pass. Keep going, all of you.');
});

test('a closing PS is left off', () => {
  const story = 'It took me a long time to get here, longer than I thought it would. Every day is a little easier than the last one was. PS sorry for my English';
  const p = Stories.passage(story, 30, 100);
  assert.equal(p.text, 'Every day is a little easier than the last one was.');
});

test('an excerpt starts at a word, not at a smiley left from the sentence before', () => {
  const story = 'God helps us get through those hard moments and forgives us if we sin. :) stay strong also read the book. Enjoy your day.';
  assert.deepEqual(Stories.passage(story, 30, 100), { text: 'stay strong also read the book. Enjoy your day.', excerpt: true });
});

test('null when even the last sentence is too long', () => {
  const story = `Start. ${'word '.repeat(40).trim()}.`;
  assert.equal(Stories.passage(story, 30, 100), null);
});

test('spines run from 6px to 36px, longer for longer stories', () => {
  assert.equal(Stories.spineHeight(0), 6);
  assert.equal(Stories.spineHeight(2000), 36);
  assert.equal(Stories.spineHeight(5000), 36);
  assert.equal(Stories.spineHeight(-3), 6);
  assert.ok(Stories.spineHeight(100) < Stories.spineHeight(400));
  assert.ok(Stories.spineHeight(400) < Stories.spineHeight(1600));
});

test('new means published in the seven days before now', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(Stories.isNew(Date.parse('2026-10-29T08:00:00Z'), now), true);
  assert.equal(Stories.isNew(Date.parse('2026-10-24T08:00:00Z'), now), true);
  assert.equal(Stories.isNew(Date.parse('2026-10-22T08:00:00Z'), now), false);
  assert.equal(Stories.isNew(Date.parse('2026-11-02T08:00:00Z'), now), false);
});

test('the shelf keeps title, length, date and passage, oldest first', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const shelf = Stories.shelfFrom({
    total: 73,
    stories: [
      { id: 'b', title: 'day 3', content: 'Short, but I wanted to say it anyway: everyone here is with you.', likes: 4, createdAt: '2026-10-28T10:00:00.000Z', deviceId: 'x' },
      { id: 'a', title: '  We can   do this ', content: 'x'.repeat(900), likes: 11, createdAt: '2026-10-06T10:00:00.000Z' },
      null
    ]
  }, now);
  assert.equal(shelf.total, 73);
  assert.equal(shelf.fetchedAt, now);
  assert.deepEqual(shelf.stories, [
    { title: 'We can do this', length: 900, at: Date.parse('2026-10-06T10:00:00.000Z') },
    { title: 'day 3', length: 64, at: Date.parse('2026-10-28T10:00:00.000Z') }
  ]);
  assert.deepEqual(shelf.voices, ['Short, but I wanted to say it anyway: everyone here is with you.']);
});

test('an excerpt on the shelf opens with an ellipsis, as on the stories page', () => {
  const shelf = Stories.shelfFrom({
    total: 1,
    stories: [{ title: 'August 24th', content: `${'I have been struggling a lot with this for a long while now and today was hard. '.repeat(3)}The urges will pass, and they always do.`, createdAt: '2026-08-24T00:00:00Z' }]
  }, 0);
  assert.deepEqual(shelf.voices, ['…The urges will pass, and they always do.']);
});

test('a shelf read back from storage is checked, and junk is refused', () => {
  assert.equal(Stories.readShelf(null), null);
  assert.equal(Stories.readShelf({ stories: [] }), null);
  assert.equal(Stories.readShelf({ stories: 'x', voices: [], fetchedAt: 1 }), null);
  const shelf = Stories.readShelf({
    total: 2,
    stories: [{ title: 'ok', length: 10, at: 5 }, { title: 3, length: 1, at: 1 }],
    voices: ['A passage that fits the sidebar well enough.', 7, 'y'.repeat(500)],
    fetchedAt: 9
  });
  assert.deepEqual(shelf, {
    total: 2,
    stories: [{ title: 'ok', length: 10, at: 5 }],
    voices: ['A passage that fits the sidebar well enough.'],
    fetchedAt: 9
  });
});

test('the stories page takes its passage from shared/stories.js', () => {
  const html = read('community.html');
  assert.ok(html.indexOf('src="shared/stories.js"') > 0);
  assert.ok(html.indexOf('src="shared/stories.js"') < html.indexOf('src="community.js"'));
  assert.match(read('community.js'), /Stories\.passage\(/);
});

test('Settings shows the shelf under the nav, and no longer lists the stories as a small link', () => {
  const html = read('options.html');
  const nav = html.indexOf('</nav>');
  const shelf = html.indexOf('id="stories-shelf"');
  const footer = html.indexOf('class="sidebar-footer"');
  assert.ok(nav > 0 && nav < shelf && shelf < footer);
  assert.doesNotMatch(html, /class="row-link">Community stories/);

  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('appwrite-client.js') > 0);
  assert.ok(at('shared/stories.js') > 0);
  assert.ok(at('options.js') > 0);
  assert.ok(at('options-stories.js') > Math.max(at('appwrite-client.js'), at('shared/stories.js'), at('options.js')));
});

test('both builds ship options-stories.js', () => {
  for (const script of ['build-chrome.ps1', 'build-firefox.ps1']) {
    assert.match(read(script), /"options-stories\.js"/, script);
  }
});

test('the privacy policy says Settings fetches the stories, and what it keeps', () => {
  const policy = read('PRIVACY_POLICY.md');
  assert.match(policy, /So does opening Settings, for the stories shelf/);
  assert.match(policy, /For the stories shelf in the Settings sidebar/);
});
