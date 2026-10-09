/**
 * BlockNSFW community stories.
 * Fetches approved stories through PBlockerStories (appwrite-client.js) and
 * sets them as hairline rows. Author text goes in with textContent, never
 * innerHTML; the one icon comes from ui/icons.js, which builds it with
 * createElementNS.
 */
(() => {
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  const LIKED_KEY = 'pblocker_liked_stories';

  const feed = document.getElementById('feed');
  const feedState = document.getElementById('feed-state');
  const footer = document.getElementById('feed-footer');
  const refreshBtn = document.getElementById('refresh-btn');
  const countEl = document.getElementById('count');
  const announcer = document.getElementById('announcer');

  function icon(name) {
    if (typeof UiIcons === 'undefined') return null;
    try { return UiIcons.create(name, { size: 12 }); } catch (_) { return null; }
  }

  function formatCount(n) {
    return Number(n).toLocaleString('en-US');
  }

  // A short message for screen readers. Cleared first so the same words
  // twice in a row are read twice.
  let announceTimer = null;
  function announce(message) {
    if (!announcer) return;
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => { announcer.textContent = message; }, 50);
  }

  // --- Local "liked" state (per device) -------------------------------------
  async function getLikedSet() {
    if (!api || !api.storage) return new Set();
    try {
      const stored = await api.storage.local.get(LIKED_KEY);
      return new Set(stored[LIKED_KEY] || []);
    } catch (_) {
      return new Set();
    }
  }
  async function persistLiked(id, liked) {
    if (!api || !api.storage) return;
    try {
      const stored = await api.storage.local.get(LIKED_KEY);
      const set = new Set(stored[LIKED_KEY] || []);
      if (liked) set.add(id); else set.delete(id);
      await api.storage.local.set({ [LIKED_KEY]: [...set] });
    } catch (_) {}
  }

  // --- Feed cache (stale-while-revalidate) ----------------------------------
  const CACHE_KEY = 'pblocker_stories_feed_cache';
  const CACHE_TTL_MS = 60_000;

  async function readFeedCache() {
    if (!api || !api.storage) return null;
    try {
      const stored = await api.storage.local.get(CACHE_KEY);
      const c = stored[CACHE_KEY];
      if (!c || typeof c.fetchedAt !== 'number') return null;
      if (Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
      return c;
    } catch (_) {
      return null;
    }
  }

  async function writeFeedCache(stories, total) {
    if (!api || !api.storage) return;
    try {
      await api.storage.local.set({
        [CACHE_KEY]: { stories, total, fetchedAt: Date.now() },
      });
    } catch (_) {}
  }

  async function invalidateFeedCache() {
    if (!api || !api.storage) return;
    try { await api.storage.local.remove(CACHE_KEY); } catch (_) {}
  }

  // --- States ---------------------------------------------------------------
  function updateCount(n) {
    if (!countEl) return;
    if (n > 0) {
      countEl.textContent = `${formatCount(n)} ${n === 1 ? 'story' : 'stories'}`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  // Loading, empty and error each say one line in place of the feed; an
  // error adds the detail when the code supplies one.
  function showState(kind, message, detail) {
    feed.replaceChildren();
    feedState.replaceChildren();

    const line = document.createElement('p');
    if (kind === 'loading') line.className = 'ink-2';
    if (kind === 'error') line.className = 'state-title';
    line.textContent = message;
    feedState.appendChild(line);

    if (detail) {
      const more = document.createElement('p');
      more.className = 'state-detail ink-2';
      more.textContent = detail;
      feedState.appendChild(more);
    }
  }

  function clearState() {
    feedState.replaceChildren();
  }

  // --- Post rendering -------------------------------------------------------
  let storySeq = 0;

  function buildPost(story, likedSet) {
    const card = document.createElement('article');
    card.className = 'story';

    // Optional title
    if (story.title) {
      const title = document.createElement('h3');
      title.className = 'story-title';
      title.id = `story-title-${++storySeq}`;
      title.textContent = story.title;
      card.setAttribute('aria-labelledby', title.id);
      card.appendChild(title);
    }

    // Body, with the author's line breaks kept
    const body = document.createElement('p');
    body.className = 'story-body';
    body.textContent = story.content || '';
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'story-actions';

    // Like — instant optimistic UI, but the write is debounced so rapid
    // clicks collapse into a single API call (or none if you end where you began).
    let serverLiked = likedSet.has(story.id);
    let serverLikes = Number(story.likes) || 0;   // server total (already includes this device if it liked before)
    let uiLiked = serverLiked;
    let syncTimer = null;
    let syncing = false;

    // "Like · 12": one label, so the underline runs unbroken. The check
    // shows only while pressed; the label itself never changes.
    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'btn btn-text story-like';
    const check = icon('check');
    if (check) likeBtn.appendChild(check);
    const likeLabel = document.createElement('span');
    const likeDot = document.createElement('span');
    likeDot.setAttribute('aria-hidden', 'true');
    likeDot.textContent = '·';
    const likeCount = document.createElement('span');
    likeCount.className = 'mono tnum';
    likeLabel.append('Like ', likeDot, ' ', likeCount);
    likeBtn.appendChild(likeLabel);

    function renderLike() {
      const shown = uiLiked === serverLiked
        ? serverLikes
        : Math.max(0, serverLikes + (uiLiked ? 1 : -1));
      likeBtn.setAttribute('aria-pressed', String(uiLiked));
      likeCount.textContent = formatCount(shown);
    }
    renderLike();

    async function syncLike() {
      if (syncing || uiLiked === serverLiked) return;   // nothing new to push
      syncing = true;
      const target = uiLiked;
      try {
        const res = await PBlockerStories.likeStory(story.id, target);
        serverLiked = target;
        if (res && typeof res.likes === 'number') serverLikes = res.likes;
        invalidateFeedCache();
      } catch (_) {
        // Push failed — fall back to the server's known state.
        uiLiked = serverLiked;
        persistLiked(story.id, uiLiked);
      } finally {
        syncing = false;
        renderLike();
        if (uiLiked !== serverLiked) scheduleLikeSync();   // toggled again mid-request
      }
    }

    function scheduleLikeSync() {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncLike, 500);
    }

    likeBtn.addEventListener('click', () => {
      uiLiked = !uiLiked;
      renderLike();
      persistLiked(story.id, uiLiked);
      scheduleLikeSync();
    });
    actions.appendChild(likeBtn);

    // Copy the story text
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-text story-copy';
    copyBtn.textContent = 'Copy';
    let copyTimer = null;
    copyBtn.addEventListener('click', async () => {
      const text = (story.title ? story.title + '\n\n' : '') + (story.content || '');
      let message;
      try {
        await navigator.clipboard.writeText(text);
        message = 'Copied';
      } catch (_) {
        message = 'Couldn’t copy';
      }
      copyBtn.textContent = message;
      announce(message);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
    actions.appendChild(copyBtn);

    card.appendChild(actions);
    return card;
  }

  const PAGE_SIZE = 10;
  let likedSet = new Set();
  let loaded = 0;          // stories currently shown
  let total = 0;           // total approved stories
  let loadingMore = false;
  let feedLoading = false;

  // Appends a page of stories and returns the first new one.
  function appendStories(stories) {
    const frag = document.createDocumentFragment();
    let first = null;
    for (const story of stories) {
      const post = buildPost(story, likedSet);
      if (!first) first = post;
      frag.appendChild(post);
    }
    feed.appendChild(frag);
    loaded += stories.length;
    return first;
  }

  function renderFooter() {
    footer.replaceChildren();
    if (loaded < total) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost load-more';
      btn.textContent = 'Load more stories';
      btn.addEventListener('click', loadMore);
      footer.appendChild(btn);
    } else if (total > 0) {
      const end = document.createElement('p');
      end.className = 'feed-end ink-2';
      end.textContent = 'You’ve reached the end.';
      footer.appendChild(end);
    }
  }

  function renderFirstPage(stories, totalCount) {
    loaded = 0;
    total = totalCount;
    feed.replaceChildren();
    footer.replaceChildren();

    if (!stories.length) {
      updateCount(0);
      showState('empty', 'No stories yet. Yours could be the first.');
      return;
    }
    clearState();
    appendStories(stories);
    updateCount(total);
    renderFooter();
  }

  async function loadInitial({ force = false } = {}) {
    feedLoading = true;
    refreshBtn.setAttribute('aria-disabled', 'true');

    try {
      // Liked set is always local — cheap.
      try { likedSet = await getLikedSet(); } catch (_) { likedSet = new Set(); }

      // Fresh cache and not forced → render it and make NO network request.
      if (!force) {
        const cached = await readFeedCache();
        if (cached) {
          renderFirstPage(cached.stories, cached.total);
          return;
        }
      }

      // Cache miss or forced refresh → fetch from the function.
      feed.setAttribute('aria-busy', 'true');
      showState('loading', 'Loading stories…');
      footer.replaceChildren();
      try {
        if (typeof PBlockerStories === 'undefined') {
          throw new Error('The story service didn’t start. Reload the page.');
        }
        const page = await PBlockerStories.fetchStories({ offset: 0, limit: PAGE_SIZE });
        renderFirstPage(page.stories, page.total);
        writeFeedCache(page.stories, page.total);
      } catch (err) {
        updateCount(0);
        showState('error', 'The stories didn’t load. Try again in a moment.', (err && err.message) || '');
      }
    } finally {
      feed.removeAttribute('aria-busy');
      feedLoading = false;
      refreshBtn.removeAttribute('aria-disabled');
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const btn = footer.querySelector('.load-more');
    const hadFocus = !!btn && document.activeElement === btn;
    // Busy, not disabled, so keyboard focus stays on the button.
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Loading…'; }

    try {
      const page = await PBlockerStories.fetchStories({ offset: loaded, limit: PAGE_SIZE });
      total = page.total;
      const first = appendStories(page.stories);
      updateCount(total);
      renderFooter();
      // The button was replaced; carry focus on to the first new story.
      if (hadFocus) {
        const next = first || footer.querySelector('.load-more');
        if (next) {
          if (next === first) next.tabIndex = -1;
          next.focus();
        }
      }
    } catch (err) {
      if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = 'Try again'; }
      announce('More stories didn’t load. Try again.');
    } finally {
      loadingMore = false;
    }
  }

  const REFRESH_COOLDOWN_MS = 5000;
  let refreshLockUntil = 0;
  let refreshTimer = null;

  refreshBtn.addEventListener('click', async () => {
    if (feedLoading || Date.now() < refreshLockUntil) return;   // throttle manual refreshes
    refreshLockUntil = Date.now() + REFRESH_COOLDOWN_MS;
    clearTimeout(refreshTimer);
    refreshBtn.setAttribute('aria-busy', 'true');
    refreshBtn.textContent = 'Refreshing…';
    try {
      await loadInitial({ force: true });
    } finally {
      refreshBtn.removeAttribute('aria-busy');
      refreshBtn.textContent = 'Refresh';
      // Held for the rest of the cooldown. aria-disabled rather than
      // disabled, so keyboard focus stays where it was.
      refreshBtn.setAttribute('aria-disabled', 'true');
      const remaining = Math.max(0, refreshLockUntil - Date.now());
      refreshTimer = setTimeout(() => {
        if (!feedLoading) refreshBtn.removeAttribute('aria-disabled');
      }, remaining);
    }
  });

  // --- Share dialog ---------------------------------------------------------
  //
  // Focus goes into the dialog and comes back to the button that opened it;
  // Tab stays inside, and Escape or a click on the backdrop closes it.
  function setupShareModal() {
    const openers = document.querySelectorAll('[data-open-share]');
    const modal = document.getElementById('share-modal');
    const page = document.getElementById('page');
    const closeBtn = document.getElementById('share-close');
    const cancelBtn = document.getElementById('share-cancel');
    const titleInput = document.getElementById('share-title-input');
    const contentInput = document.getElementById('share-content');
    const counter = document.getElementById('share-counter');
    const statusEl = document.getElementById('share-status');
    const errorEl = document.getElementById('share-error');
    const submitBtn = document.getElementById('share-submit');
    if (!openers.length || !modal || !submitBtn) return;

    const MAX_LENGTH = 2000;
    const NEAR_LIMIT = 1800;
    const SUBMIT_LABEL = 'Post story';

    let returnFocus = null;
    let closeTimer = null;
    let posting = false;
    let fieldInvalid = false;

    const isOpen = () => !modal.classList.contains('hidden');

    // Success and progress go to the status line; problems to the alert.
    function setStatus(msg, kind) {
      if (kind === 'error') {
        statusEl.textContent = '';
        errorEl.textContent = msg || '';
      } else {
        errorEl.textContent = '';
        statusEl.textContent = msg || '';
      }
    }

    function setFieldInvalid(invalid) {
      fieldInvalid = invalid;
      if (invalid) contentInput.setAttribute('aria-invalid', 'true');
      else contentInput.removeAttribute('aria-invalid');
    }

    function updateCounter() {
      const len = contentInput.value.length;
      const near = len >= NEAR_LIMIT;
      counter.textContent = near
        ? `${len} / ${MAX_LENGTH} · close to the limit`
        : `${len} / ${MAX_LENGTH}`;
      counter.classList.toggle('is-near', near);
    }

    async function open(e) {
      clearTimeout(closeTimer);
      const active = document.activeElement;
      returnFocus = (e && e.currentTarget) || (active && active !== document.body ? active : null);

      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      document.documentElement.classList.add('dialog-open');
      if (page) page.inert = true;

      setStatus('');
      setFieldInvalid(false);
      updateCounter();
      contentInput.focus();

      // Respect the per-device cooldown / weekly limit.
      try {
        const remaining = await PBlockerStories.getCooldownRemaining();
        submitBtn.removeAttribute('aria-disabled');
        if (remaining > 0) {
          submitBtn.disabled = true;
          setStatus(`You can share another story in ${PBlockerStories.formatWait(remaining)}.`);
        } else {
          submitBtn.disabled = false;
        }
      } catch (_) {
        submitBtn.removeAttribute('aria-disabled');
        submitBtn.disabled = false;
      }
    }

    function close() {
      clearTimeout(closeTimer);
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('dialog-open');
      if (page) page.inert = false;

      const target = returnFocus;
      returnFocus = null;
      if (target && document.contains(target) && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (_) {}
      }
    }

    openers.forEach((el) => el.addEventListener('click', open));
    closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);

    // Only a click that starts and ends on the backdrop closes the dialog,
    // so selecting text and releasing outside it keeps the draft open.
    let downOnScrim = false;
    modal.addEventListener('pointerdown', (e) => { downOnScrim = e.target === modal; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal && downOnScrim) close();
      downOnScrim = false;
    });

    document.addEventListener('keydown', (e) => {
      if (!isOpen() || e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button, input, textarea, [href], [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      const inside = focusable.includes(current);
      if (e.shiftKey && (current === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (current === last || !inside)) { e.preventDefault(); first.focus(); }
    });

    contentInput.addEventListener('input', () => {
      updateCounter();
      if (fieldInvalid && contentInput.value.trim().length >= 20) {
        setFieldInvalid(false);
        errorEl.textContent = '';
      }
    });

    submitBtn.addEventListener('click', async () => {
      if (posting || submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') return;

      const content = (contentInput.value || '').trim();
      if (content.length < 20) {
        setFieldInvalid(true);
        setStatus('Write at least 20 characters.', 'error');
        contentInput.focus();
        return;
      }

      posting = true;
      setFieldInvalid(false);
      // Busy, not disabled, so keyboard focus stays on the button.
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.textContent = 'Posting…';
      setStatus('Sending your story…');

      try {
        await PBlockerStories.submitStory({ title: (titleInput && titleInput.value) || '', content });
        setStatus('Your story is in for review. You can share another in a week.');
        titleInput.value = '';
        contentInput.value = '';
        updateCounter();
        submitBtn.setAttribute('aria-disabled', 'true');   // on cooldown now
        if (isOpen()) {
          statusEl.focus();
          closeTimer = setTimeout(close, 1800);
        }
      } catch (err) {
        setStatus((err && err.message) || 'Your story didn’t send. Check your connection and try again.', 'error');
      } finally {
        posting = false;
        submitBtn.removeAttribute('aria-busy');
        submitBtn.textContent = SUBMIT_LABEL;
      }
    });
  }

  setupShareModal();

  // Scripts are at the end of <body>, so the feed elements already exist.
  loadInitial();
})();
