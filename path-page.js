// path-page.js
// The path page: one day as a letter (#day-N, or today's by default), a day
// that comes with Supporter, or all thirty (#all). shared/path.js decides
// which day is open; shared/path-days.js holds the words, and
// extras/path-days.js adds days 8 to 30 in store builds.

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const DAYS = PathDays.DAYS;
  const WEEKS = PathDays.WEEKS;

  let state = Path.normalize(null);
  let supporter = false;
  // The author's own lines aren't all written yet. A development install
  // shows the brackets where they go; a store build leaves them out.
  let showPlaceholders = false;
  let editing = false;
  let shown = null;

  async function load() {
    try {
      const store = await browserAPI.storage.local.get(Path.KEY);
      state = Path.normalize(store[Path.KEY]);
    } catch (_) {}
    try {
      supporter = (await Supporter.status(browserAPI.storage.local)).supporter;
    } catch (_) {
      supporter = false;
    }
    try {
      showPlaceholders = (await browserAPI.management.getSelf()).installType === 'development';
    } catch (_) {
      showPlaceholders = false;
    }
  }

  const unwritten = (text) => /\[[^\]]*\]/.test(text);

  async function save() {
    try { await browserAPI.storage.local.set({ [Path.KEY]: state }); } catch (_) {}
  }

  function route() {
    if (location.hash === '#all') return { view: 'all' };
    const m = /^#day-(\d{1,2})$/.exec(location.hash);
    return { view: 'day', n: m ? Number(m[1]) : null };
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function show(view) {
    $('path').dataset.view = view;
    $('day-view').hidden = view !== 'day';
    $('locked-view').hidden = view !== 'locked';
    $('all-view').hidden = view !== 'all';
    const back = $('back-link');
    if (view === 'all') {
      back.href = '#';
      $('back-text').textContent = 'Today’s page';
    } else {
      back.href = '#all';
      $('back-text').textContent = 'All 30 days';
    }
  }

  // --- One day ---------------------------------------------------------------

  function renderSquares(n) {
    const box = $('squares');
    box.textContent = '';
    for (let i = 1; i <= Path.DAYS; i++) {
      const sq = el('span', 'path-square');
      if (i === 8 || i === 15 || i === 22) sq.classList.add('is-week');
      if (state.done[i]) sq.classList.add('is-done');
      else if (i === n) sq.classList.add('is-today');
      box.appendChild(sq);
    }
    const done = Object.keys(state.done).length;
    box.setAttribute('aria-label', `${done} of 30 days done. This is day ${n}.`);
  }

  function renderBody(day) {
    const body = $('day-body');
    body.textContent = '';
    const paragraphs = day.body.slice();
    const last = paragraphs.pop();
    paragraphs.forEach((p) => body.appendChild(el('p', '', p)));
    // The author's own lines, or where they will go.
    if (Array.isArray(day.mine) && day.mine.length) {
      day.mine.forEach((p) => body.appendChild(el('p', '', p)));
    } else if (day.story && showPlaceholders) {
      body.appendChild(el('p', 'path-story', `[${day.story}]`));
    }
    if (last) body.appendChild(el('p', '', last));
    const sign = PathDays.SIGNATURE;
    if (sign && (showPlaceholders || !unwritten(sign))) body.appendChild(el('p', 'path-sign', sign));
  }

  function renderOne(n, day) {
    const one = day.one || { kind: 'do', text: '' };
    const done = !!state.done[n];
    const line = state.lines[n] || '';
    $('one-text').textContent = one.text;

    const isLine = one.kind === 'line';
    const open = isLine ? (!line || editing) : !done;
    $('one-line').hidden = !(isLine && open);
    $('one-actions').hidden = !open;
    $('one-finished').hidden = open;

    const link = $('one-link');
    link.hidden = one.kind !== 'link';
    if (one.kind === 'link') {
      link.href = one.href;
      link.textContent = one.label;
    }
    $('one-keep').hidden = !isLine;
    const doneBtn = $('one-done');
    doneBtn.hidden = isLine;
    doneBtn.classList.toggle('btn-primary', one.kind !== 'link');
    doneBtn.classList.toggle('btn-ghost', one.kind === 'link');

    if (isLine) {
      $('line-label').textContent = one.prompt || 'Your line for today';
      const input = $('line-input');
      if (document.activeElement !== input) input.value = line;
    }
    $('one-kept-line').hidden = !(isLine && line);
    $('one-kept-line').textContent = line ? `“${line}”` : '';
    $('one-done-text').textContent = isLine ? 'Kept in your book.' : `Done. Day ${n} is on the path.`;
    $('one-change').hidden = !isLine;
  }

  function renderBookList(list, items) {
    list.textContent = '';
    items.forEach((b) => {
      const li = el('li');
      li.appendChild(el('span', 'path-book-n', String(b.n)));
      li.appendChild(el('span', 'path-book-line', b.line));
      list.appendChild(li);
    });
  }

  function renderNext(n, available) {
    const line = $('next-line');
    line.textContent = '';
    const note = $('next-note');
    if (n < available) {
      line.append('Today’s page · ');
      const a = el('a', 'link', `Day ${available}`);
      a.href = `#day-${available}`;
      line.appendChild(a);
      note.textContent = 'You’re reading an earlier day.';
      return;
    }
    if (n >= Path.DAYS) {
      note.textContent = 'Your week, Days kept and Own Words carry on from here.';
      return;
    }
    const next = DAYS[n];
    line.append('Tomorrow · ');
    line.appendChild(el('span', 'path-next-title', next.title));
    note.textContent = Path.locked(n + 1, supporter)
      ? 'Days 8 to 30 come with Supporter.'
      : 'A new page opens each morning.';
  }

  function renderDay(n) {
    const day = DAYS[n - 1];
    show('day');
    document.title = `${day.title} · The path · BlockNSFW`;
    $('day-of').textContent = `Day ${n} of 30`;
    renderSquares(n);
    $('day-title').textContent = day.title;
    renderBody(day);
    renderOne(n, day);
    const book = Path.book(state);
    $('book').hidden = n !== Path.DAYS;
    if (n === Path.DAYS) renderBookList($('book-list'), book);
    renderNext(n, Path.available(state, Date.now()));
  }

  const LOCKED_TEXT = 'Days 8 to 30 come with Supporter. The first week is free for everyone, and blocking is the same whether you support or not.';
  // A supporter on the open-source build: the day is theirs, but its words
  // are a Supporter extra this build doesn't carry.
  const NOT_HERE_TEXT = 'Days 8 to 30 are a Supporter extra. They come with BlockNSFW from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons; this open-source build has the first week.';

  function renderLocked(n) {
    show('locked');
    document.title = `Day ${n} · The path · BlockNSFW`;
    $('locked-of').textContent = `Day ${n} of 30`;
    $('locked-title').textContent = DAYS[n - 1].title;
    const notHere = !Path.locked(n, supporter);
    $('locked-text').textContent = notHere ? NOT_HERE_TEXT : LOCKED_TEXT;
    $('locked-see').hidden = notHere;
  }

  // --- All thirty ---------------------------------------------------------------

  function renderAll() {
    show('all');
    document.title = 'The path · BlockNSFW';
    const now = Date.now();
    const available = Path.available(state, now);
    $('all-lede').textContent = supporter
      ? 'One short page a day from someone who has been where you are, and one small thing to do. Thank you for supporting it.'
      : 'One short page a day from someone who has been where you are, and one small thing to do. Days 1 to 7 are free. Days 8 to 30 come with Supporter.';

    const box = $('weeks');
    box.textContent = '';
    WEEKS.forEach((w) => {
      const section = el('section', 'path-week');
      const meta = el('p', 'meta path-week-meta');
      meta.appendChild(el('span', '', `Week ${w.n}`));
      if (!supporter) {
        const tag = el('span', 'path-week-tag', w.from > Path.FREE_DAYS ? 'Supporter' : 'Free');
        if (w.from <= Path.FREE_DAYS) tag.classList.add('is-free');
        meta.appendChild(tag);
      }
      section.appendChild(meta);
      section.appendChild(el('h2', 'path-week-name', w.name));
      const list = el('ol', 'path-days');
      for (let n = w.from; n <= w.to; n++) {
        const li = el('li');
        if (state.done[n]) li.classList.add('is-done');
        else if (n === available && !Path.locked(n, supporter)) li.classList.add('is-today');
        li.appendChild(el('span', 'path-day-n', String(n)));
        const reachable = Path.canOpen(state, n, now, supporter);
        const title = el(reachable ? 'a' : 'span', 'path-day-title', DAYS[n - 1].title);
        if (reachable) title.href = `#day-${n}`;
        li.appendChild(title);
        li.appendChild(el('span', 'path-day-mark'));
        list.appendChild(li);
      }
      section.appendChild(list);
      box.appendChild(section);
    });

    const book = Path.book(state);
    $('all-book').hidden = !book.length;
    renderBookList($('all-book-list'), book);
  }

  // --- Routing --------------------------------------------------------------------

  async function render() {
    const r = route();
    const key = r.view === 'all' ? 'all' : `day-${r.n}`;
    if (key !== shown) editing = false;
    if (r.view === 'all') {
      renderAll();
    } else {
      const now = Date.now();
      const available = Path.available(state, now);
      let n = r.n && r.n >= 1 && r.n <= Path.DAYS ? r.n : available;
      if (n > available) n = available;
      if (Path.locked(n, supporter) || !PathDays.has(n)) {
        renderLocked(n);
      } else {
        const before = state.opened[n];
        state = Path.open(state, n, now, supporter);
        if (!before && state.opened[n]) await save();
        renderDay(n);
      }
    }
    if (key !== shown && shown !== null) {
      const head = document.querySelector('main > :not([hidden]) h1');
      if (head) head.focus({ preventScroll: false });
      window.scrollTo(0, 0);
    }
    shown = key;
  }

  function currentDay() {
    const r = route();
    const available = Path.available(state, Date.now());
    return r.n && r.n <= available ? r.n : available;
  }

  async function markDone() {
    state = Path.markDone(state, currentDay(), Date.now());
    await save();
    render();
  }

  async function keepLine() {
    const text = $('line-input').value;
    if (!text.trim()) {
      $('line-input').focus();
      return;
    }
    state = Path.setLine(state, currentDay(), text, Date.now());
    editing = false;
    await save();
    render();
  }

  async function startAgain() {
    state = Path.restart(state);
    await save();
    location.hash = '';
    render();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('one-done').addEventListener('click', markDone);
    $('one-keep').addEventListener('click', keepLine);
    $('one-change').addEventListener('click', () => {
      editing = true;
      render().then(() => $('line-input').focus());
    });
    $('again').addEventListener('click', startAgain);
    $('one-link').addEventListener('click', () => {
      // Going to Settings counts as having started it; done stays a choice.
    });
    window.addEventListener('hashchange', render);
    browserAPI.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local' || !(changes[Path.KEY] || changes[Supporter.KEY])) return;
      if (document.activeElement === $('line-input')) return;
      await load();
      render();
    });
    await load();
    render();
  });
})();
