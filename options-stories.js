// options-stories.js
// Community stories in the Settings sidebar: a shelf with one spine for each
// of the newest stories, as tall as the story is long, the newest on the
// right and this week's in brass, then a few words from one of them, picked
// at random on every visit. Hovering the shelf reads each spine's title and
// date. The whole block opens the stories page.
//
// The shelf is kept in storage (shared/stories.js says what of a story it
// keeps) and fetched again when it is more than six hours old, so Settings
// opens on the last copy and asks the backend at most four times a day.
// Until the first copy arrives, and whenever the feed can't be reached, the
// sentence in the markup stands and the shelf stays hidden.
//
// Uses browserAPI from options.js and PBlockerStories from appwrite-client.js,
// both loaded before it.

(function () {
  'use strict';

  const CACHE_KEY = 'pblocker_stories_shelf';
  const FRESH_MS = 6 * 60 * 60 * 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const block = $('stories-shelf');
  if (!block || typeof Stories === 'undefined') return;
  const shelfEl = $('shelf');
  const spines = $('shelf-spines');
  const caption = $('shelf-caption');

  let current = null; // the shelf on screen
  let voice = '';     // this visit's passage, kept when a fresh copy arrives
  let lit = -1;       // the spine under the pointer

  function formatDay(ms) {
    try {
      return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  // At rest the caption counts this week's stories, or dates the newest
  // when none came this week.
  function restCaption() {
    const now = Date.now();
    const fresh = current.stories.filter((s) => Stories.isNew(s.at, now)).length;
    if (fresh > 0) {
      caption.replaceChildren(span('shelf-new-mark'), span('meta is-new', `${fresh} new this week`));
    } else {
      const newest = current.stories[current.stories.length - 1];
      caption.replaceChildren(span('meta', `Newest ${formatDay(newest.at)}`));
    }
  }

  function light(i) {
    if (i === lit) return;
    const rects = spines.children;
    if (rects[lit]) rects[lit].classList.remove('is-on');
    lit = i;
    if (!rects[i]) {
      restCaption();
      return;
    }
    rects[i].classList.add('is-on');
    const story = current.stories[i];
    caption.replaceChildren(
      span('meta shelf-title', story.title ? `“${story.title}”` : 'Untitled'),
      span('meta shelf-day', formatDay(story.at))
    );
  }

  function render(shelf) {
    const n = shelf.stories.length;
    if (!n) return;
    current = shelf;
    lit = -1;

    // One unit per spine across, so the shelf fills the column at any width.
    const now = Date.now();
    spines.setAttribute('viewBox', `0 0 ${n} 40`);
    spines.replaceChildren(...shelf.stories.map((story, i) => {
      const h = Stories.spineHeight(story.length);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(i + 0.2));
      rect.setAttribute('y', String(40 - h));
      rect.setAttribute('width', '0.6');
      rect.setAttribute('height', String(h));
      if (Stories.isNew(story.at, now)) rect.classList.add('is-new');
      return rect;
    }));
    restCaption();
    shelfEl.hidden = false;

    if (!voice && shelf.voices.length) {
      voice = shelf.voices[Math.floor(Math.random() * shelf.voices.length)];
      $('shelf-quote').textContent = voice;
      $('shelf-by').textContent = 'Anonymous';
      block.classList.add('has-voice');
    }
    const total = shelf.total;
    $('shelf-count').textContent = `${total.toLocaleString('en-US')} ${total === 1 ? 'story' : 'stories'}`;
  }

  spines.addEventListener('pointermove', (event) => {
    if (!current || event.pointerType === 'touch') return;
    const box = spines.getBoundingClientRect();
    if (!box.width) return;
    const i = Math.floor(((event.clientX - box.left) / box.width) * current.stories.length);
    light(Math.max(0, Math.min(current.stories.length - 1, i)));
  });
  spines.addEventListener('pointerleave', () => light(-1));

  async function load() {
    let cached = null;
    try {
      const stored = await browserAPI.storage.local.get(CACHE_KEY);
      cached = Stories.readShelf(stored[CACHE_KEY]);
    } catch (_) {}
    if (cached) render(cached);
    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return;
    if (typeof PBlockerStories === 'undefined' || !PBlockerStories.isConfigured()) return;
    try {
      const page = await PBlockerStories.fetchStories({ offset: 0, limit: Stories.SHELF_SIZE });
      const shelf = Stories.shelfFrom(page, Date.now());
      render(shelf);
      await browserAPI.storage.local.set({ [CACHE_KEY]: shelf });
    } catch (_) {
      // Offline, or the backend is down: the last copy, or the sentence, stays.
    }
  }

  load();
})();
