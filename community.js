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

  // --- A voice from the community -------------------------------------------
  //
  // A few words from one story, set large at the top of the page. Most
  // stories are too long to quote whole, so the voice is the story's last
  // sentence or two: where people tend to say what keeps them going. It is
  // picked at random on every visit, and Read another steps through the rest
  // in a shuffled order, so none comes round twice before all have. Until
  // stories load, or when none has a passage short enough, the sentence in
  // the markup stands.
  const VOICE_MIN = 40;
  const VOICE_MAX = 200;
  const voiceQuote = document.getElementById('voice-quote');
  const voiceCite = document.getElementById('voice-cite');
  const voiceNext = document.getElementById('voice-next');
  let voices = [];
  let voiceAt = 0;

  function flatten(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // The story whole if it is short enough, else its closing sentences, as
  // many as fit. Null when even the last sentence is too long, or what fits
  // is too short to stand alone.
  function voicePassage(story) {
    const whole = flatten(story && story.content);
    if (whole.length <= VOICE_MAX) {
      return whole.length >= VOICE_MIN ? { text: whole, excerpt: false } : null;
    }
    // A closing "PS" is an afterthought, not what the story came to say.
    const sentences = whole.split(/(?<=[.!?])\s+/);
    while (sentences.length > 1 && /^p\.?\s?s\b/i.test(sentences[sentences.length - 1])) sentences.pop();
    let text = '';
    for (let i = sentences.length - 1; i >= 0; i--) {
      const next = text ? `${sentences[i]} ${text}` : sentences[i];
      if (next.length > VOICE_MAX) break;
      text = next;
    }
    return text.length >= VOICE_MIN ? { text, excerpt: true } : null;
  }

  function showVoice() {
    const voice = voices[voiceAt];
    if (!voice || !voiceQuote) return;
    voiceQuote.textContent = voice.excerpt ? `…${voice.text}` : voice.text;
    if (!voiceCite) return;
    voiceCite.replaceChildren(voice.story.title ? `From “${voice.story.title}” · Anonymous` : 'Anonymous');
    if (voice.excerpt && voice.post) {
      const read = document.createElement('button');
      read.type = 'button';
      read.className = 'link voice-read';
      read.textContent = 'Read it all';
      read.addEventListener('click', () => {
        const body = voice.post.querySelector('.story-body');
        const more = voice.post.querySelector('.story-more');
        if (body && body.classList.contains('is-folded') && more) more.click();
        voice.post.tabIndex = -1;
        voice.post.scrollIntoView({ block: 'start' });
        voice.post.focus({ preventScroll: true });
      });
      voiceCite.append(' · ', read);
    }
    voiceCite.hidden = false;
  }

  function setVoices(stories, posts) {
    voices = stories
      .map((story, i) => {
        const passage = voicePassage(story);
        return passage ? Object.assign({ story, post: posts[i] }, passage) : null;
      })
      .filter(Boolean);
    if (!voices.length) return;
    // Fisher–Yates: every order equally likely.
    for (let i = voices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [voices[i], voices[j]] = [voices[j], voices[i]];
    }
    voiceAt = 0;
    showVoice();
    if (voiceNext) voiceNext.hidden = voices.length < 2;
  }

  if (voiceNext) {
    voiceNext.addEventListener('click', () => {
      if (voices.length < 2) return;
      voiceAt = (voiceAt + 1) % voices.length;
      showVoice();
      announce(voiceQuote.textContent);
    });
  }

  // --- Post rendering -------------------------------------------------------
  let storySeq = 0;
  // Stories longer than this may run past four lines and are folded; the
  // fold comes off again where the whole story fits after all.
  const FOLD_FROM = 220;

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

    // Body, with the author's line breaks kept. A long one is folded after
    // four lines; appendStories keeps the fold only where it hides something.
    const body = document.createElement('p');
    body.className = 'story-body';
    body.id = `story-body-${++storySeq}`;
    body.textContent = story.content || '';
    card.appendChild(body);

    if ((story.content || '').length > FOLD_FROM) {
      body.classList.add('is-folded');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'link story-more';
      more.textContent = 'Read the whole story';
      more.setAttribute('aria-expanded', 'false');
      more.setAttribute('aria-controls', body.id);
      more.addEventListener('click', () => {
        const open = !body.classList.toggle('is-folded');
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show less' : 'Read the whole story';
      });
      card.appendChild(more);
    }

    // Every story is anonymous; the sign-off says so in the author's place.
    const sign = document.createElement('p');
    sign.className = 'story-sign';
    sign.textContent = '— Anonymous';
    card.appendChild(sign);

    const actions = document.createElement('div');
    actions.className = 'story-actions';

    // Like — instant optimistic UI, but the write is debounced so rapid
    // clicks collapse into a single API call (or none if you end where you began).
    let serverLiked = likedSet.has(story.id);
    let serverLikes = Number(story.likes) || 0;   // server total (already includes this device if it liked before)
    let uiLiked = serverLiked;
    let syncTimer = null;
    let syncing = false;

    // "This helped me 12": what the count means, on a page that exists to
    // help. The check shows only while pressed; the label never changes, and
    // the count only shows once someone has been helped.
    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'btn btn-ghost btn-sm story-like';
    const check = icon('check');
    if (check) likeBtn.appendChild(check);
    const likeLabel = document.createElement('span');
    likeLabel.textContent = 'This helped me';
    const likeCount = document.createElement('span');
    likeCount.className = 'mono tnum story-like-count';
    likeBtn.append(likeLabel, likeCount);

    function renderLike() {
      const shown = uiLiked === serverLiked
        ? serverLikes
        : Math.max(0, serverLikes + (uiLiked ? 1 : -1));
      likeBtn.setAttribute('aria-pressed', String(uiLiked));
      likeCount.textContent = shown > 0 ? formatCount(shown) : '';
      likeCount.hidden = shown <= 0;
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

  // Appends a page of stories and returns the new posts, in order.
  function appendStories(stories) {
    const frag = document.createDocumentFragment();
    const posts = [];
    for (const story of stories) {
      const post = buildPost(story, likedSet);
      posts.push(post);
      frag.appendChild(post);
    }
    feed.appendChild(frag);
    loaded += stories.length;
    unfoldWhatFits();
    return posts;
  }

  // A folded story whose words all fit in four lines needs no fold and no
  // "Read the whole story".
  function unfoldWhatFits() {
    requestAnimationFrame(() => {
      feed.querySelectorAll('.story-body.is-folded:not([data-fold-checked])').forEach((body) => {
        body.dataset.foldChecked = '1';
        if (body.scrollHeight <= body.clientHeight + 1) {
          body.classList.remove('is-folded');
          const more = body.parentElement && body.parentElement.querySelector('.story-more');
          if (more) more.remove();
        }
      });
    });
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
    const posts = appendStories(stories);
    updateCount(total);
    renderFooter();
    setVoices(stories, posts);
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
      const first = appendStories(page.stories)[0] || null;
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
