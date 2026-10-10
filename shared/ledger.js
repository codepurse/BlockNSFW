// shared/ledger.js
// The long record: one line per day, for Your month, Your year and When it's
// hardest.
//
// The hard moments are kept in detail for about a month (shared/moments.js,
// shared/gateways.js, the audit log of switches, the daily block counts in
// background.js), which is as long as Your week and Statistics need. A month
// told after it ends, or a year, needs more, so once a day the days whose
// detail is still all there are written down here as plain counts: whether
// the day was kept, how many times you turned back at a gateway, waited a
// moment out or slipped, how many pages were held, and the hours the hard
// moments came. Nothing about sites or pages. 400 days are kept.
//
// Plain data in, plain data out. background.js rolls it up once a day; a page
// that reads it rolls the newest days up in memory first, so today is there.
// Everything stays in storage.local on the device.
//
// Loaded as a classic <script> in pages and the background, and as a CommonJS
// module in tests.

(function (root) {
  'use strict';

  var KEY = 'pblocker_ledger';   // { days: { 'YYYY-MM-DD': { st, g, w, x, b, h } } }
  var KEEP_DAYS = 400;
  // The detail behind a day is all there for 28 days: the shortest store,
  // the audit log of switches, keeps 30. Older days are left as written.
  var SETTLE_DAYS = 28;
  var HOURS_MAX = 48;

  // --- Calendar ----------------------------------------------------------------

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Calendar days, not 24-hour steps, so a clock change never shifts a day.
  function addDays(ms, n) {
    var d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function parseKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
  }

  // --- The record ------------------------------------------------------------------

  function count(v) {
    var n = Math.floor(Number(v));
    return n > 0 ? n : 0;
  }

  // st: 'kept', or 'broken' (a slip, or protection off for part of the day).
  // g: times turned back at a gateway; w: moments waited out; x: slips;
  // b: pages held; h: the hours (0-23) the hard moments came.
  function normalizeEntry(e) {
    if (!e || typeof e !== 'object' || (e.st !== 'kept' && e.st !== 'broken')) return null;
    var hours = (Array.isArray(e.h) ? e.h : []).map(Number).filter(function (h) {
      return h >= 0 && h < 24 && Math.floor(h) === h;
    }).slice(0, HOURS_MAX);
    return { st: e.st, g: count(e.g), w: count(e.w), x: count(e.x), b: count(e.b), h: hours };
  }

  function normalize(raw) {
    var src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
    var days = {};
    Object.keys(src).sort().forEach(function (key) {
      if (parseKey(key) === null) return;
      var e = normalizeEntry(src[key]);
      if (e) days[key] = e;
    });
    return { days: days };
  }

  // --- One day, from the detail --------------------------------------------------

  // sources: { firstSeen, slips (Moments.normalizeSlips), off ([[from, to]],
  //   Moments.offIntervals), stops ([{ at }]), kept ([ms]), blocks ({ day: n }) }
  // null for a day before the extension was here.
  function summarize(sources, dayStart) {
    var s = sources || {};
    var dayEnd = addDays(dayStart, 1);
    var key = dayKey(dayStart);
    var first = s.firstSeen > 0 ? startOfDay(s.firstSeen) : null;
    if (first !== null && dayEnd <= first) return null;
    var hours = [];
    var inDay = function (at) { return at >= dayStart && at < dayEnd; };

    var g = 0;
    (s.stops || []).forEach(function (e) {
      if (e && inDay(Number(e.at))) { g++; hours.push(new Date(Number(e.at)).getHours()); }
    });
    var w = 0;
    (s.kept || []).forEach(function (at) {
      if (inDay(Number(at))) { w++; hours.push(new Date(Number(at)).getHours()); }
    });
    var x = 0;
    (s.slips || []).forEach(function (slip) {
      if (!slip || slip.day !== key) return;
      x++;
      if (slip.hour !== null && slip.hour !== undefined) hours.push(slip.hour);
    });
    var off = (s.off || []).some(function (iv) { return iv[0] < dayEnd && iv[1] > dayStart; });
    hours.sort(function (a, b) { return a - b; });
    return normalizeEntry({
      st: x > 0 || off ? 'broken' : 'kept',
      g: g,
      w: w,
      x: x,
      b: s.blocks ? s.blocks[key] : 0,
      h: hours
    });
  }

  // Writes down the settled days (yesterday back to SETTLE_DAYS ago) from the
  // detail, and lets go of anything older than KEEP_DAYS. Today isn't written:
  // it isn't over. { ledger, changed }
  function rollup(raw, sources, now) {
    var ledger = normalize(raw);
    var before = JSON.stringify(ledger.days);
    var today = startOfDay(now);
    for (var i = 1; i <= SETTLE_DAYS; i++) {
      var start = addDays(today, -i);
      var entry = summarize(sources, start);
      if (entry) ledger.days[dayKey(start)] = entry;
    }
    var oldest = dayKey(addDays(today, -KEEP_DAYS));
    var kept = {};
    Object.keys(ledger.days).sort().forEach(function (key) {
      if (key >= oldest) kept[key] = ledger.days[key];
    });
    ledger.days = kept;
    return { ledger: ledger, changed: JSON.stringify(ledger.days) !== before };
  }

  // The days from `from` to `to` (inclusive, midnights), each as
  //   { key, start, status, entry }
  // status: 'kept' | 'broken' (from the record, or today and the settled days
  // from the detail), 'ahead' (not yet), 'before' (before the extension was
  // here) or 'unknown' (before the long record began).
  function days(raw, sources, now, from, to) {
    var ledger = normalize(raw);
    var today = startOfDay(now);
    var fresh = addDays(today, -SETTLE_DAYS);
    var first = sources && sources.firstSeen > 0 ? startOfDay(sources.firstSeen) : null;
    var out = [];
    for (var start = startOfDay(from); start <= to; start = addDays(start, 1)) {
      var key = dayKey(start);
      var entry = null;
      var status;
      if (start > today) status = 'ahead';
      else if (first !== null && addDays(start, 1) <= first) status = 'before';
      else {
        entry = start >= fresh ? summarize(sources, start) : ledger.days[key] || null;
        status = entry ? entry.st : 'unknown';
      }
      out.push({ key: key, start: start, status: status, entry: entry });
    }
    return out;
  }

  // --- Months ----------------------------------------------------------------------

  // A month's letter (Your month, a Supporter extra) is ready on the morning
  // after it ends; the popup marks it new until it's opened.
  var MONTH_SEEN_KEY = 'pblocker_month_seen';   // 'YYYY-MM' of the newest month opened
  var MONTH_READY_HOUR = 6;

  function monthKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function monthStart(ms) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  function parseMonth(key) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
  }

  function addMonths(ms, n) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
  }

  // The newest month whose letter is ready (its start).
  function latestMonth(now) {
    var current = monthStart(now);
    var ready = new Date(current);
    ready.setHours(MONTH_READY_HOUR, 0, 0, 0);
    return addMonths(current, now >= ready.getTime() ? -1 : -2);
  }

  // Whether a ready month hasn't been opened yet, and the extension saw at
  // least its last week (a month seen for two days isn't worth a letter).
  function hasNewMonth(now, firstSeen, seenKey) {
    var start = latestMonth(now);
    if (!(firstSeen > 0) || firstSeen > addDays(addMonths(start, 1), -7)) return false;
    var seen = parseMonth(seenKey);
    return seen === null || seen < start;
  }

  // Reads every source the record is made from, in the shape summarize wants.
  // get: a storage.local get; Moments and Gateways: the shared modules.
  function readSources(get, Moments, Gateways, now) {
    var keys = [Moments.SLIPS_KEY, Moments.KEPT_KEY, Moments.FIRST_SEEN_KEY,
      Gateways.STOPS_KEY, 'pblocker_audit_disabled', 'pblocker_settings', 'pblocker_daily_history'];
    return Promise.resolve(get(keys)).then(function (store) {
      var settings = store.pblocker_settings || {};
      return {
        firstSeen: Number(store[Moments.FIRST_SEEN_KEY]) || 0,
        slips: Moments.normalizeSlips(store[Moments.SLIPS_KEY]),
        off: Moments.offIntervals(store.pblocker_audit_disabled, now, settings.enabled !== false),
        stops: Gateways.normalizeStops(store[Gateways.STOPS_KEY]).recent,
        kept: Moments.normalizeKept(store[Moments.KEPT_KEY]).times,
        blocks: store.pblocker_daily_history && typeof store.pblocker_daily_history === 'object' ? store.pblocker_daily_history : {}
      };
    });
  }

  var exported = {
    KEY: KEY,
    KEEP_DAYS: KEEP_DAYS,
    SETTLE_DAYS: SETTLE_DAYS,
    startOfDay: startOfDay,
    addDays: addDays,
    dayKey: dayKey,
    parseKey: parseKey,
    normalize: normalize,
    summarize: summarize,
    rollup: rollup,
    days: days,
    MONTH_SEEN_KEY: MONTH_SEEN_KEY,
    monthKey: monthKey,
    monthStart: monthStart,
    parseMonth: parseMonth,
    addMonths: addMonths,
    latestMonth: latestMonth,
    hasNewMonth: hasNewMonth,
    readSources: readSources
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Ledger = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
