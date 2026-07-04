/**
 * BlockNSFW community stories feed.
 * Fetches approved stories via PBlockerStories.fetchStories() and renders them
 * as social-style posts. Author text is inserted with textContent (never
 * innerHTML); innerHTML is used only for the static, trusted SVG icons below.
 */
(() => {
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  const LIKED_KEY = 'pblocker_liked_stories';

  const feed = document.getElementById('feed');
  const footer = document.getElementById('feed-footer');
  const refreshBtn = document.getElementById('refresh-btn');
  const countEl = document.getElementById('count');

  // --- Static icons (trusted markup) ----------------------------------------
  const ICON_HEART =
    '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const ICON_SHARE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  const ICON_ALERT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  function svgNode(markup) {
    const span = document.createElement('span');
    span.innerHTML = markup; // static SVG only
    return span.firstElementChild;
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
      countEl.textContent = `${n} ${n === 1 ? 'story' : 'stories'}`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  function showState({ className = '', icon, title, detail }) {
    feed.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = `state ${className}`.trim();

    if (icon === 'spinner') {
      const sp = document.createElement('div');
      sp.className = 'spinner';
      wrap.appendChild(sp);
    } else if (icon) {
      const ic = document.createElement('div');
      ic.className = 'state-icon';
      ic.appendChild(svgNode(icon));
      wrap.appendChild(ic);
    }
    if (title) {
      const h = document.createElement('p');
      h.className = 'state-title';
      h.textContent = title;
      wrap.appendChild(h);
    }
    if (detail) {
      const p = document.createElement('div');
      p.textContent = detail;
      wrap.appendChild(p);
    }
    feed.appendChild(wrap);
  }

  // --- Post rendering -------------------------------------------------------
  function buildPost(story, i, likedSet) {
    const card = document.createElement('article');
    card.className = 'story';
    card.style.animationDelay = `${Math.min(i, 8) * 55}ms`;

    const post = document.createElement('div');
    post.className = 'post';

    // Optional title
    if (story.title) {
      const title = document.createElement('h2');
      title.className = 'story-title';
      title.textContent = story.title;
      post.appendChild(title);
    }

    // Body
    const body = document.createElement('p');
    body.className = 'story-body';
    body.textContent = story.content || '';
    post.appendChild(body);

    // Action bar
    const actions = document.createElement('div');
    actions.className = 'story-actions';

    // Like — instant optimistic UI, but the write is debounced so rapid
    // clicks collapse into a single API call (or none if you end where you began).
    let serverLiked = likedSet.has(story.id);
    let serverLikes = Number(story.likes) || 0;   // server total (already includes this device if it liked before)
    let uiLiked = serverLiked;
    let syncTimer = null;
    let syncing = false;

    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'act act-like';
    likeBtn.appendChild(svgNode(ICON_HEART));
    const likeCount = document.createElement('span');
    likeBtn.appendChild(likeCount);

    function renderLike() {
      const shown = uiLiked === serverLiked
        ? serverLikes
        : Math.max(0, serverLikes + (uiLiked ? 1 : -1));
      likeBtn.classList.toggle('liked', uiLiked);
      likeBtn.setAttribute('aria-pressed', String(uiLiked));
      likeCount.textContent = String(shown);
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

    // Share (copy story text)
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'act act-share';
    shareBtn.appendChild(svgNode(ICON_SHARE));
    const shareLabel = document.createElement('span');
    shareLabel.textContent = 'Share';
    shareBtn.appendChild(shareLabel);
    shareBtn.addEventListener('click', async () => {
      const text = (story.title ? story.title + '\n\n' : '') + (story.content || '');
      try {
        await navigator.clipboard.writeText(text);
        shareLabel.textContent = 'Copied!';
      } catch (_) {
        shareLabel.textContent = 'Copy failed';
      }
      setTimeout(() => { shareLabel.textContent = 'Share'; }, 1500);
    });
    actions.appendChild(shareBtn);

    post.appendChild(actions);
    card.appendChild(post);
    return card;
  }

  const PAGE_SIZE = 10;
  let likedSet = new Set();
  let loaded = 0;          // stories currently shown
  let total = 0;           // total approved stories
  let loadingMore = false;

  function appendStories(stories) {
    const frag = document.createDocumentFragment();
    stories.forEach((story, idx) => frag.appendChild(buildPost(story, loaded + idx, likedSet)));
    feed.appendChild(frag);
    loaded += stories.length;
  }

  function renderFooter() {
    footer.replaceChildren();
    if (loaded < total) {
      const btn = document.createElement('button');
      btn.className = 'load-more';
      btn.type = 'button';
      btn.textContent = 'Load more stories';
      btn.addEventListener('click', loadMore);
      footer.appendChild(btn);
    } else if (total > 0) {
      const end = document.createElement('p');
      end.className = 'feed-end';
      end.textContent = "You've reached the end.";
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
      showState({
        className: 'empty',
        icon: ICON_CHAT,
        title: 'No stories yet',
        detail: 'Be the first to share your story and encourage others.',
      });
      return;
    }
    appendStories(stories);
    updateCount(total);
    renderFooter();
  }

  async function loadInitial({ force = false } = {}) {
    refreshBtn.disabled = true;

    // Liked set is always local — cheap.
    try { likedSet = await getLikedSet(); } catch (_) { likedSet = new Set(); }

    // Fresh cache and not forced → render it and make NO network request.
    if (!force) {
      const cached = await readFeedCache();
      if (cached) {
        renderFirstPage(cached.stories, cached.total);
        refreshBtn.disabled = false;
        return;
      }
    }

    // Cache miss or forced refresh → fetch from the function.
    showState({ icon: 'spinner', detail: 'Loading stories…' });
    footer.replaceChildren();
    try {
      if (typeof PBlockerStories === 'undefined') {
        throw new Error('Story system not loaded.');
      }
      const page = await PBlockerStories.fetchStories({ offset: 0, limit: PAGE_SIZE });
      renderFirstPage(page.stories, page.total);
      writeFeedCache(page.stories, page.total);
    } catch (err) {
      updateCount(0);
      showState({
        className: 'error',
        icon: ICON_ALERT,
        title: "Couldn't load stories",
        detail: err.message || 'Please try again in a moment.',
      });
    } finally {
      refreshBtn.disabled = false;
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const btn = footer.querySelector('.load-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

    try {
      const page = await PBlockerStories.fetchStories({ offset: loaded, limit: PAGE_SIZE });
      total = page.total;
      appendStories(page.stories);
      updateCount(total);
      renderFooter();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    } finally {
      loadingMore = false;
    }
  }

  const REFRESH_COOLDOWN_MS = 5000;
  let refreshLockUntil = 0;

  refreshBtn.addEventListener('click', async () => {
    if (Date.now() < refreshLockUntil) return;          // throttle manual refreshes
    refreshLockUntil = Date.now() + REFRESH_COOLDOWN_MS;
    refreshBtn.classList.add('spinning');
    try {
      await loadInitial({ force: true });
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = true;                       // hold disabled for the rest of the cooldown
      const remaining = Math.max(0, refreshLockUntil - Date.now());
      setTimeout(() => { refreshBtn.disabled = false; }, remaining);
    }
  });

  // --- Share modal (inline composer) ----------------------------------------
  function setupShareModal() {
    const openers = document.querySelectorAll('[data-open-share]');
    const modal = document.getElementById('share-modal');
    const closeBtn = document.getElementById('share-close');
    const titleInput = document.getElementById('share-title-input');
    const contentInput = document.getElementById('share-content');
    const counter = document.getElementById('share-counter');
    const statusEl = document.getElementById('share-status');
    const submitBtn = document.getElementById('share-submit');
    if (!openers.length || !modal || !submitBtn) return;

    function setStatus(msg, kind) {
      statusEl.textContent = msg || '';
      statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
    }

    async function open() {
      modal.hidden = false;
      setStatus('');
      // Respect the per-device cooldown / weekly limit.
      try {
        const remaining = await PBlockerStories.getCooldownRemaining();
        if (remaining > 0) {
          submitBtn.disabled = true;
          setStatus(`You can share again in ${PBlockerStories.formatWait(remaining)}.`);
        } else {
          submitBtn.disabled = false;
        }
      } catch (_) {
        submitBtn.disabled = false;
      }
      setTimeout(() => contentInput.focus(), 50);
    }

    function close() {
      modal.hidden = true;
    }

    openers.forEach((el) => el.addEventListener('click', open));
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });

    contentInput.addEventListener('input', () => {
      const len = contentInput.value.length;
      counter.textContent = `${len} / 2000`;
      counter.style.color = len >= 1800 ? 'var(--warning, #f59e0b)' : 'var(--foreground-dim)';
    });

    submitBtn.addEventListener('click', async () => {
      const content = (contentInput.value || '').trim();
      if (content.length < 20) {
        setStatus('Story must be at least 20 characters.', 'error');
        contentInput.focus();
        return;
      }

      submitBtn.disabled = true;
      const label = submitBtn.textContent;
      submitBtn.textContent = 'Posting…';
      setStatus('Submitting your story…');

      try {
        await PBlockerStories.submitStory({ title: (titleInput && titleInput.value) || '', content });
        setStatus('Story submitted for review! You can share again in a week.', 'success');
        titleInput.value = '';
        contentInput.value = '';
        counter.textContent = '0 / 2000';
        counter.style.color = 'var(--foreground-dim)';
        setTimeout(close, 1800);              // stays disabled — now on cooldown
      } catch (err) {
        setStatus(err.message || 'Failed to submit story.', 'error');
        submitBtn.disabled = false;
      } finally {
        submitBtn.textContent = label;
      }
    });
  }

  setupShareModal();

  // Scripts are at the end of <body>, so the feed elements already exist.
  loadInitial();
})();
