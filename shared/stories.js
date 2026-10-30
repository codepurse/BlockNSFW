// shared/stories.js
// Small pure helpers for the community stories, shared by the stories page
// (community.js) and the shelf in the Settings sidebar (options-stories.js).
//
//   passage: a few words from a story to quote on their own. The story whole
//   if it is short enough, else its closing sentences, as many as fit: most
//   stories are too long to quote whole, and the end is where people tend to
//   say what keeps them going. A closing "PS" is an afterthought, not what the
//   story came to say, so it is left off.
//
//   The shelf: one spine per story, as tall as the story is long. shelfFrom
//   keeps what the shelf needs of one page of the feed, and nothing else of a
//   story: its title, its length, when it was published, and the passages
//   short enough to quote in the sidebar.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  // The newest stories the shelf holds: one page of the feed, the most the
  // backend sends at once.
  var SHELF_SIZE = 50;
  // A passage quoted in the sidebar: four or five lines of its 15rem column.
  var SHELF_VOICE_MIN = 30;
  var SHELF_VOICE_MAX = 100;
  var TITLE_MAX = 120;
  // The longest a story can be (community.html's maxlength).
  var STORY_MAX = 2000;
  var SPINE_MIN = 6;
  var SPINE_MAX = 36;
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function flatten(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // { text, excerpt } or null, when even the last sentence is longer than
  // max, or what fits is shorter than min.
  function passage(content, min, max) {
    var whole = flatten(content);
    if (whole.length <= max) {
      return whole.length >= min ? { text: whole, excerpt: false } : null;
    }
    var sentences = whole.split(/(?<=[.!?])\s+/);
    while (sentences.length > 1 && /^p\.?\s?s\b/i.test(sentences[sentences.length - 1])) sentences.pop();
    var text = '';
    for (var i = sentences.length - 1; i >= 0; i--) {
      var next = text ? sentences[i] + ' ' + text : sentences[i];
      if (next.length > max) break;
      text = next;
    }
    // An excerpt starts at a word: a smiley or stray punctuation the split
    // left at its head ("…sin. :) stay strong") belongs to the sentence before.
    text = text.replace(/^[^\p{L}\p{N}"“‘'(]+/u, '');
    return text.length >= min ? { text: text, excerpt: true } : null;
  }

  // A spine's height in px: from 6 for an empty story to 36 for the longest
  // a story can be, on a square-root scale so the many short ones still
  // differ from each other.
  function spineHeight(length) {
    var n = Math.max(0, Math.min(Number(length) || 0, STORY_MAX));
    return Math.round(SPINE_MIN + (SPINE_MAX - SPINE_MIN) * Math.sqrt(n / STORY_MAX));
  }

  // Published in the seven days before now.
  function isNew(at, now) {
    return at > now - WEEK_MS && at <= now;
  }

  // What the shelf keeps of one page of the feed (newest first, as the feed
  // sends it): the stories oldest first, so the newest stand on the right,
  // and the passages short enough for the sidebar, an excerpt marked with an
  // ellipsis as the stories page marks it.
  function shelfFrom(page, now) {
    var list = page && Array.isArray(page.stories) ? page.stories : [];
    var stories = [];
    var voices = [];
    list.forEach(function (story) {
      if (!story || typeof story !== 'object') return;
      stories.push({
        title: flatten(story.title).slice(0, TITLE_MAX),
        length: String(story.content || '').length,
        at: Date.parse(story.createdAt) || 0
      });
      var p = passage(story.content, SHELF_VOICE_MIN, SHELF_VOICE_MAX);
      if (p) voices.push(p.excerpt ? '…' + p.text : p.text);
    });
    stories.sort(function (a, b) { return a.at - b.at; });
    return {
      total: Math.max(Number(page && page.total) || 0, stories.length),
      stories: stories,
      voices: voices,
      fetchedAt: now
    };
  }

  // A shelf read back from storage, or null when it isn't one.
  function readShelf(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.fetchedAt !== 'number') return null;
    if (!Array.isArray(raw.stories) || !Array.isArray(raw.voices)) return null;
    var stories = raw.stories.filter(function (s) {
      return s && typeof s.title === 'string' && typeof s.length === 'number' && typeof s.at === 'number';
    }).slice(-SHELF_SIZE);
    var voices = raw.voices.filter(function (v) {
      return typeof v === 'string' && v.length > 0 && v.length <= SHELF_VOICE_MAX + 1;
    });
    return {
      total: Math.max(Number(raw.total) || 0, stories.length),
      stories: stories,
      voices: voices,
      fetchedAt: raw.fetchedAt
    };
  }

  var exported = {
    SHELF_SIZE: SHELF_SIZE,
    SHELF_VOICE_MIN: SHELF_VOICE_MIN,
    SHELF_VOICE_MAX: SHELF_VOICE_MAX,
    flatten: flatten,
    passage: passage,
    spineHeight: spineHeight,
    isNew: isNew,
    shelfFrom: shelfFrom,
    readShelf: readShelf
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Stories = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
