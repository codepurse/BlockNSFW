// shared/progress.js
// Your progress across computers: this computer's history as a snapshot, the
// snapshots of your other computers (from a backup, or for supporters the
// browser's own sync), and the merges.
//
// History stays per computer. Protection on one computer says nothing about
// another, and an "off" logged on one can't be paired with an "on" logged on
// another, so this computer's own records are never mixed with another's.
// Other computers are kept beside them (ELSEWHERE_KEY) and only combined when
// shown: a day is kept only if it was kept on every computer, and the counts
// add up. A merge never makes the record look better than it was.
//
// What belongs to the person rather than to a computer is merged into one:
// the path (Path.merge), the evening check-ins, and your own words.
//
// Snapshots come from outside (a backup file, the browser's sync), so every
// one is checked and clamped before it's kept or shown.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var DEVICE_KEY = 'pblocker_device';        // { id, created }
  var ELSEWHERE_KEY = 'pblocker_elsewhere';  // { [id]: snapshot }
  var DAY = 24 * 60 * 60 * 1000;
  var DETAIL_DAYS = 35;      // the detail Your week and the last 28 days read
  var MAX_ELSEWHERE = 6;     // other computers kept, the newest first
  var LIST_MAX = 500;
  var LABEL_MAX = 60;
  var CHECKIN_IDS = ['sleep', 'stress', 'alone', 'mood', 'moved'];
  var CHECKINS_KEEP = 400;

  function mod(name, deps) {
    return (deps && deps[name]) || root[name] || null;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function int(v) {
    return Math.floor(num(v));
  }

  // --- This computer ---------------------------------------------------------------

  function validId(id) {
    return typeof id === 'string' && /^d[0-9a-f]{12}$/.test(id);
  }

  function newId(random) {
    var bytes = new Uint8Array(6);
    var c = typeof crypto !== 'undefined' ? crypto : root.crypto;
    if (!random && c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor((random || Math.random)() * 256);
    var hex = '';
    for (var j = 0; j < bytes.length; j++) hex += bytes[j].toString(16).padStart(2, '0');
    return 'd' + hex;
  }

  // This computer's id, made once and kept. `storage` is storage.local.
  function deviceId(storage, now) {
    return Promise.resolve(storage.get(DEVICE_KEY)).then(function (got) {
      var rec = got && got[DEVICE_KEY];
      if (rec && validId(rec.id)) return rec.id;
      var id = newId();
      var write = {};
      write[DEVICE_KEY] = { id: id, created: now || Date.now() };
      return Promise.resolve(storage.set(write)).then(function () { return id; });
    });
  }

  // "BlockNSFW · Chrome on Windows": how this computer is named to the others.
  function label() {
    var Supporter = mod('Supporter');
    if (Supporter && typeof Supporter.deviceLabel === 'function') return Supporter.deviceLabel().replace(/^BlockNSFW · /, '');
    var ua = typeof navigator !== 'undefined' && navigator && navigator.userAgent ? navigator.userAgent : '';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : 'Chrome';
    var os = /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return browser + (os ? ' on ' + os : '');
  }

  // The keys a snapshot is made from.
  function snapshotKeys(deps) {
    var Moments = mod('Moments', deps);
    var Gateways = mod('Gateways', deps);
    var Ledger = mod('Ledger', deps);
    return [Ledger.KEY, Moments.FIRST_SEEN_KEY, Moments.SLIPS_KEY, Moments.KEPT_KEY, Gateways.STOPS_KEY,
      'pblocker_audit_disabled', 'pblocker_settings', 'pblocker_daily_history'];
  }

  // This computer's history, as another computer (or a backup) keeps it:
  // the long record, and the last DETAIL_DAYS of detail.
  function snapshot(store, id, now, deps) {
    var Moments = mod('Moments', deps);
    var Gateways = mod('Gateways', deps);
    var Ledger = mod('Ledger', deps);
    var s = store || {};
    var since = now - DETAIL_DAYS * DAY;
    var settings = s.pblocker_settings || {};
    var stops = Gateways.normalizeStops(s[Gateways.STOPS_KEY]);
    var kept = Moments.normalizeKept(s[Moments.KEPT_KEY]);
    var blocks = {};
    var history = s.pblocker_daily_history && typeof s.pblocker_daily_history === 'object' ? s.pblocker_daily_history : {};
    var oldestDay = Ledger.dayKey(since);
    Object.keys(history).forEach(function (day) {
      if (Ledger.parseKey(day) !== null && day >= oldestDay && int(history[day])) blocks[day] = int(history[day]);
    });
    return normalizeSnapshot({
      id: id,
      label: label(),
      at: now,
      firstSeen: num(s[Moments.FIRST_SEEN_KEY]),
      ledger: Ledger.normalize(s[Ledger.KEY]).days,
      off: Moments.offIntervals(s.pblocker_audit_disabled, now, settings.enabled !== false)
        .filter(function (iv) { return iv[1] > since; }),
      stops: stops.recent.map(function (e) { return e.at; }).filter(function (t) { return t > since; }),
      kept: kept.times.filter(function (t) { return t > since; }),
      slips: Moments.normalizeSlips(s[Moments.SLIPS_KEY]),
      blocks: blocks,
      counts: { kept: kept.count, stops: stops.total }
    }, deps);
  }

  // A snapshot from outside, checked and clamped, or null.
  function normalizeSnapshot(raw, deps) {
    var Moments = mod('Moments', deps);
    var Ledger = mod('Ledger', deps);
    if (!raw || typeof raw !== 'object' || !validId(raw.id) || !num(raw.at)) return null;
    var times = function (list) {
      return (Array.isArray(list) ? list : []).map(Number).filter(function (t) { return isFinite(t) && t > 0; })
        .sort(function (a, b) { return a - b; }).slice(-LIST_MAX);
    };
    var off = (Array.isArray(raw.off) ? raw.off : []).filter(function (iv) {
      return Array.isArray(iv) && num(iv[0]) && num(iv[1]) && Number(iv[1]) >= Number(iv[0]);
    }).map(function (iv) { return [Number(iv[0]), Number(iv[1])]; }).slice(-LIST_MAX);
    var blocks = {};
    if (raw.blocks && typeof raw.blocks === 'object') {
      Object.keys(raw.blocks).slice(0, 400).forEach(function (day) {
        if (Ledger.parseKey(day) !== null && int(raw.blocks[day])) blocks[day] = int(raw.blocks[day]);
      });
    }
    var counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
    return {
      id: raw.id,
      label: typeof raw.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) : '',
      at: Number(raw.at),
      firstSeen: num(raw.firstSeen),
      ledger: Ledger.normalize({ days: raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {} }).days,
      off: off,
      stops: times(raw.stops),
      kept: times(raw.kept),
      slips: Moments.normalizeSlips(raw.slips),
      blocks: blocks,
      counts: { kept: int(counts.kept), stops: int(counts.stops) }
    };
  }

  // --- Other computers ------------------------------------------------------------

  // The other computers as kept on this one, checked.
  function normalizeElsewhere(raw, selfId, deps) {
    var out = {};
    var list = raw && typeof raw === 'object' ? Object.keys(raw).map(function (k) { return raw[k]; }) : [];
    list.forEach(function (snap) {
      var s = normalizeSnapshot(snap, deps);
      if (s && s.id !== selfId) out[s.id] = s;
    });
    return out;
  }

  // Adds snapshots (from a backup, or the browser's sync): for each computer
  // the newest wins; this computer's own is never kept here; the
  // MAX_ELSEWHERE newest are kept. { elsewhere, changed }
  function mergeElsewhere(current, incoming, selfId, deps) {
    var out = normalizeElsewhere(current, selfId, deps);
    var before = JSON.stringify(out);
    var list = Array.isArray(incoming) ? incoming : incoming && typeof incoming === 'object'
      ? Object.keys(incoming).map(function (k) { return incoming[k]; }) : [];
    list.forEach(function (snap) {
      var s = normalizeSnapshot(snap, deps);
      if (!s || s.id === selfId) return;
      if (!out[s.id] || s.at > out[s.id].at) out[s.id] = s;
    });
    var ids = Object.keys(out).sort(function (a, b) { return out[b].at - out[a].at; }).slice(0, MAX_ELSEWHERE);
    var kept = {};
    ids.forEach(function (id) { kept[id] = out[id]; });
    return { elsewhere: kept, changed: JSON.stringify(kept) !== before };
  }

  // The other computers added up: the earliest first day, every interval
  // without protection, every turn back, wait and slip, and each day's
  // record at its worst. null when there are none.
  function others(elsewhere, deps) {
    var snaps = Object.keys(elsewhere || {}).map(function (k) { return elsewhere[k]; }).filter(Boolean);
    if (!snaps.length) return null;
    var out = { firstSeen: 0, off: [], stops: [], kept: [], slips: [], blocks: {}, ledger: {}, counts: { kept: 0, stops: 0 }, computers: snaps.length };
    snaps.forEach(function (s) {
      if (s.firstSeen && (!out.firstSeen || s.firstSeen < out.firstSeen)) out.firstSeen = s.firstSeen;
      out.off = out.off.concat(s.off);
      out.stops = out.stops.concat(s.stops);
      out.kept = out.kept.concat(s.kept);
      out.slips = out.slips.concat(s.slips);
      Object.keys(s.blocks).forEach(function (d) { out.blocks[d] = (out.blocks[d] || 0) + s.blocks[d]; });
      out.ledger = combineDays(out.ledger, s.ledger, deps);
      out.counts.kept += s.counts.kept;
      out.counts.stops += s.counts.stops;
    });
    out.stops.sort(function (a, b) { return a - b; });
    out.kept.sort(function (a, b) { return a - b; });
    return out;
  }

  // Two long records as one: a day is broken if it was broken on either,
  // and its counts and hours add up.
  function combineDays(a, b, deps) {
    var Ledger = mod('Ledger', deps);
    var out = {};
    var keys = Object.keys(a || {}).concat(Object.keys(b || {}));
    keys.forEach(function (key) {
      if (out[key]) return;
      var x = a && a[key];
      var y = b && b[key];
      if (!x || !y) { out[key] = x || y; return; }
      out[key] = {
        st: x.st === 'broken' || y.st === 'broken' ? 'broken' : 'kept',
        g: x.g + y.g,
        w: x.w + y.w,
        x: x.x + y.x,
        b: x.b + y.b,
        h: x.h.concat(y.h).sort(function (p, q) { return p - q; })
      };
    });
    return Ledger.normalize({ days: out }).days;
  }

  // Ledger.readSources' sources with the other computers added, for showing
  // only: never written back, so this computer's own record stays its own.
  function combineSources(sources, o) {
    if (!o) return sources;
    var s = sources || {};
    var blocks = {};
    Object.keys(s.blocks || {}).forEach(function (d) { blocks[d] = Number(s.blocks[d]) || 0; });
    Object.keys(o.blocks).forEach(function (d) { blocks[d] = (blocks[d] || 0) + o.blocks[d]; });
    return {
      firstSeen: s.firstSeen && o.firstSeen ? Math.min(s.firstSeen, o.firstSeen) : (s.firstSeen || o.firstSeen),
      slips: (s.slips || []).concat(o.slips),
      off: (s.off || []).concat(o.off),
      stops: (s.stops || []).concat(o.stops.map(function (at) { return { key: 'elsewhere', at: at }; })),
      kept: (s.kept || []).concat(o.kept),
      blocks: blocks
    };
  }

  // A long record ({ days }) with the other computers added, for showing.
  function combineLedger(ledger, o, deps) {
    var Ledger = mod('Ledger', deps);
    var own = Ledger.normalize(ledger);
    return o ? { days: combineDays(own.days, o.ledger, deps) } : own;
  }

  // --- What belongs to the person ------------------------------------------------------

  function answer(v) {
    var n = Number(v);
    return v !== null && v !== undefined && v !== '' && (n === 0 || n === 1 || n === 2) ? n : null;
  }

  // Evening check-ins from two places as one: one a day, the one answered
  // last; a day either place counted as hard stays hard.
  function mergeCheckins(a, b) {
    var byDay = {};
    var add = function (list) {
      (Array.isArray(list) ? list : []).forEach(function (e) {
        if (!e || typeof e.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.day)) return;
        var answers = {};
        var any = false;
        CHECKIN_IDS.forEach(function (id) {
          answers[id] = answer(e.a && e.a[id]);
          if (answers[id] !== null) any = true;
        });
        if (!any) return;
        var entry = { day: e.day, a: answers, at: num(e.at) };
        if (typeof e.hard === 'boolean') entry.hard = e.hard;
        var had = byDay[e.day];
        if (!had) { byDay[e.day] = entry; return; }
        var winner = entry.at > had.at ? entry : had;
        var other = winner === entry ? had : entry;
        var merged = { day: winner.day, a: winner.a, at: winner.at };
        if (winner.hard === true || other.hard === true) merged.hard = true;
        else if (typeof winner.hard === 'boolean') merged.hard = winner.hard;
        else if (typeof other.hard === 'boolean') merged.hard = other.hard;
        byDay[e.day] = merged;
      });
    };
    add(a);
    add(b);
    return Object.keys(byDay).sort().map(function (d) { return byDay[d]; }).slice(-CHECKINS_KEEP);
  }

  // Your own words: the ones here, unless there are none here yet.
  function mergeWords(here, there, deps) {
    var Moments = mod('Moments', deps);
    return Moments.hasWords(here) ? Moments.normalizeWords(here) : Moments.normalizeWords(there);
  }

  var exported = {
    DEVICE_KEY: DEVICE_KEY,
    ELSEWHERE_KEY: ELSEWHERE_KEY,
    DETAIL_DAYS: DETAIL_DAYS,
    MAX_ELSEWHERE: MAX_ELSEWHERE,
    validId: validId,
    newId: newId,
    deviceId: deviceId,
    label: label,
    snapshotKeys: snapshotKeys,
    snapshot: snapshot,
    normalizeSnapshot: normalizeSnapshot,
    normalizeElsewhere: normalizeElsewhere,
    mergeElsewhere: mergeElsewhere,
    others: others,
    combineDays: combineDays,
    combineSources: combineSources,
    combineLedger: combineLedger,
    mergeCheckins: mergeCheckins,
    mergeWords: mergeWords
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Progress = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
