// shared/path.js
// The path: thirty short pages, one a day, each with one small thing to do.
// The words are in shared/path-days.js; this is which day is open, what has
// been done, and the lines kept.
//
// A new page opens each morning, at most one a day, and a missed day waits:
// the next page opens on a later day than the one before it was first read,
// however many days that takes. Mornings start at 4 am, so reading past
// midnight still counts as the night before.
//
// The first seven days are free; the rest come with Supporter
// (shared/supporter.js). The page still says what a locked day is called.
//
// Everything stays in storage.local on the device.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var KEY = 'pblocker_path';   // { opened: { n: day }, done: { n: ms }, lines: { n: text }, edited: { n: ms }, rounds }
  var DAYS = 30;
  var FREE_DAYS = 7;
  var LINE_MAX = 200;
  var MORNING_HOUR = 4;

  // The day as a person lives it: until 4 am it is still the night before.
  function dayOf(ms) {
    var d = new Date(ms);
    if (d.getHours() < MORNING_HOUR) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function validDay(n) {
    n = Number(n);
    return n >= 1 && n <= DAYS && Math.floor(n) === n ? n : null;
  }

  function normalize(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var out = { opened: {}, done: {}, lines: {}, edited: {}, rounds: Math.max(0, Math.floor(Number(s.rounds) || 0)) };
    ['opened', 'done', 'lines', 'edited'].forEach(function (field) {
      var src = s[field] && typeof s[field] === 'object' ? s[field] : {};
      Object.keys(src).forEach(function (k) {
        var n = validDay(k);
        if (n === null) return;
        var v = src[k];
        if (field === 'opened' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.opened[n] = v;
        else if (field === 'done' && Number(v) > 0) out.done[n] = Number(v);
        else if (field === 'lines' && typeof v === 'string' && v.trim()) out.lines[n] = v.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
        else if (field === 'edited' && Number(v) > 0) out.edited[n] = Number(v);
      });
    });
    return out;
  }

  function lastOpened(state) {
    var last = 0;
    Object.keys(state.opened).forEach(function (k) { if (Number(k) > last) last = Number(k); });
    return last;
  }

  // The newest day that can be read now: day 1 to begin with, then one more
  // on any later day than the newest was first opened.
  function available(raw, now) {
    var state = normalize(raw);
    var last = lastOpened(state);
    if (!last) return 1;
    if (last >= DAYS) return DAYS;
    return state.opened[last] < dayOf(now) ? last + 1 : last;
  }

  function locked(n, supporter) {
    return n > FREE_DAYS && !supporter;
  }

  // Whether day n can be read now: already opened, or the newest available,
  // and not behind Supporter.
  function canOpen(raw, n, now, supporter) {
    n = validDay(n);
    if (n === null || locked(n, supporter)) return false;
    return n <= available(raw, now);
  }

  // Records that day n was read today, the first time only. Returns the new
  // state, or the old one unchanged when it can't be opened.
  function open(raw, n, now, supporter) {
    var state = normalize(raw);
    n = validDay(n);
    if (n === null || !canOpen(state, n, now, supporter) || state.opened[n]) return state;
    state.opened[n] = dayOf(now);
    return state;
  }

  function markDone(raw, n, now) {
    var state = normalize(raw);
    n = validDay(n);
    if (n !== null && state.opened[n] && !state.done[n]) state.done[n] = now;
    return state;
  }

  // A line kept for day n also marks it done. An empty line clears it.
  function setLine(raw, n, text, now) {
    var state = normalize(raw);
    n = validDay(n);
    if (n === null || !state.opened[n]) return state;
    var line = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
    if (line) {
      state.lines[n] = line;
      if (!state.done[n]) state.done[n] = now;
    } else {
      delete state.lines[n];
    }
    // When, so a copy on another computer can tell which line is newer.
    state.edited[n] = now;
    return state;
  }

  // Back to day 1. The lines stay, so a second time through adds to the book
  // rather than wiping it; a line written again replaces its day's.
  function restart(raw) {
    var state = normalize(raw);
    return { opened: {}, done: {}, lines: state.lines, edited: state.edited, rounds: state.rounds + 1 };
  }

  // Two copies of the path (from two computers, or a backup) as one. The
  // later round decides what's opened and done, since starting again is a
  // choice to keep; in the same round a day counts from the first time
  // either copy opened or finished it. Each line is the one written last (a
  // line cleared last stays cleared); two never edited are settled the same
  // way on both computers, so the copies agree.
  function merge(a, b) {
    var x = normalize(a);
    var y = normalize(b);
    var out = { opened: {}, done: {}, lines: {}, edited: {}, rounds: Math.max(x.rounds, y.rounds) };
    var deciding = x.rounds === y.rounds ? [x, y] : [x.rounds > y.rounds ? x : y];
    deciding.forEach(function (s) {
      Object.keys(s.opened).forEach(function (n) {
        if (!out.opened[n] || s.opened[n] < out.opened[n]) out.opened[n] = s.opened[n];
      });
      Object.keys(s.done).forEach(function (n) {
        if (!out.done[n] || s.done[n] < out.done[n]) out.done[n] = s.done[n];
      });
    });
    for (var n = 1; n <= DAYS; n++) {
      var ex = x.edited[n] || 0;
      var ey = y.edited[n] || 0;
      var lx = x.lines[n] || '';
      var ly = y.lines[n] || '';
      var line = ex !== ey ? (ex > ey ? lx : ly)
        : lx.length !== ly.length ? (lx.length > ly.length ? lx : ly)
        : (lx > ly ? lx : ly);
      if (line) out.lines[n] = line;
      if (ex || ey) out.edited[n] = Math.max(ex, ey);
    }
    return out;
  }

  // What the popup and the pages need in one go.
  //   { day, title, locked, done, finished, doneCount }
  // `day` is the page to show: the newest available. `finished` once day 30
  // has been opened and done.
  function summary(raw, now, supporter, days) {
    var state = normalize(raw);
    var day = available(state, now);
    var entry = days && days[day - 1];
    var doneCount = Object.keys(state.done).length;
    return {
      day: day,
      title: entry ? entry.title : '',
      locked: locked(day, supporter),
      opened: !!state.opened[day],
      done: !!state.done[day],
      finished: !!(state.opened[DAYS] && state.done[DAYS]),
      doneCount: doneCount
    };
  }

  // The lines, in day order, for the book.
  function book(raw) {
    var state = normalize(raw);
    return Object.keys(state.lines).map(Number).sort(function (a, b) { return a - b; })
      .map(function (n) { return { n: n, line: state.lines[n] }; });
  }

  var exported = {
    KEY: KEY,
    DAYS: DAYS,
    FREE_DAYS: FREE_DAYS,
    LINE_MAX: LINE_MAX,
    dayOf: dayOf,
    normalize: normalize,
    available: available,
    locked: locked,
    canOpen: canOpen,
    open: open,
    markDone: markDone,
    setLine: setLine,
    restart: restart,
    merge: merge,
    summary: summary,
    book: book
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Path = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
