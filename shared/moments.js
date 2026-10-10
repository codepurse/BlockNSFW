// shared/moments.js
// The hard moment, and the morning after.
//
//   Own Words: an if-then plan, a note to yourself, and someone to reach,
//   written in a calm moment and shown first on the blocked page. If-then
//   plans are one of the most reliable findings in behaviour change, and
//   your own voice is the one most likely to be heard at the worst moment.
//
//   Kept moments: each time someone waits out an urge on the blocked page
//   and presses "I'm OK now".
//
//   Slips, and Days Kept: a slip is recorded as one day with what was going
//   on, never as a reset. "Days kept" counts the days in the last 30 with no
//   slip and protection on all day, so one bad night costs one day, not
//   months. (All-or-nothing counters feed the spiral relapse research calls
//   the abstinence violation effect.)
//
// Everything here stays in storage.local on the device.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var WORDS_KEY = 'pblocker_own_words';
  var SLIPS_KEY = 'pblocker_slips';
  var KEPT_KEY = 'pblocker_kept_moments';
  var FIRST_SEEN_KEY = 'pblocker_first_seen';
  // A photo for the hard moment, shown above the words on the blocked page.
  // Chosen in Settings (a Supporter extra), shrunk there, and kept here as a
  // data: URL: { src, at }. It stays on the device.
  var PHOTO_KEY = 'pblocker_moment_photo';
  var PHOTO_MAX = 1500000;
  var DAY = 24 * 60 * 60 * 1000;
  var WINDOW_DAYS = 30;
  var LIMITS = { plan: 400, note: 600, name: 60, phone: 32 };

  // What was going on, and what would have helped: chips on the slip page.
  var SLIP_TAGS = [
    { id: 'tired', label: 'Tired' },
    { id: 'lonely', label: 'Lonely' },
    { id: 'bored', label: 'Bored' },
    { id: 'stressed', label: 'Stressed' },
    { id: 'late', label: 'Up late' },
    { id: 'low', label: 'Low' },
    { id: 'other', label: 'Something else' }
  ];
  var SLIP_HELPS = [
    { id: 'wait', label: 'A longer wait' },
    { id: 'person', label: 'Someone to talk to' },
    { id: 'away', label: 'Being away from the screen' },
    { id: 'stronger', label: 'Stronger protection at that hour' }
  ];
  // Where it started: one choice, or none. The ids are the built-in gateways'
  // (shared/gateways.js), so the slip page can offer to make it one.
  var SLIP_STARTS = [
    { id: 'instagram-explore', label: 'Instagram' },
    { id: 'reddit', label: 'Reddit' },
    { id: 'x-search', label: 'X' },
    { id: 'tiktok', label: 'TikTok' },
    { id: 'youtube-shorts', label: 'YouTube' },
    { id: 'image-search', label: 'Image search' },
    { id: 'other', label: 'Somewhere else' }
  ];

  function pickStart(id) {
    for (var i = 0; i < SLIP_STARTS.length; i++) if (SLIP_STARTS[i].id === id) return id;
    return null;
  }

  function text(value, limit) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, limit);
  }

  // --- Own Words ---------------------------------------------------------------

  function normalizeWords(raw) {
    var w = raw && typeof raw === 'object' ? raw : {};
    var person = w.person && typeof w.person === 'object' ? w.person : {};
    return {
      plan: text(w.plan, LIMITS.plan),
      note: text(w.note, LIMITS.note),
      person: { name: text(person.name, LIMITS.name), phone: text(person.phone, LIMITS.phone) }
    };
  }

  function hasWords(words) {
    var w = normalizeWords(words);
    return !!(w.plan || w.note || w.person.name || w.person.phone);
  }

  // The photo's src, or '' when there is none or it isn't a plain image.
  function photoSrc(raw) {
    var src = raw && typeof raw === 'object' && typeof raw.src === 'string' ? raw.src : '';
    return src.length <= PHOTO_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(src) ? src : '';
  }

  // A tel: link only for something that is plainly a phone number.
  function telHref(phone) {
    var raw = String(phone || '').trim();
    if (!/^\+?[\d\s().-]{7,24}$/.test(raw)) return '';
    var digits = raw.replace(/[^\d+]/g, '');
    var count = digits.replace(/\D/g, '').length;
    return count >= 7 && count <= 15 ? 'tel:' + digits : '';
  }

  // --- Kept moments ------------------------------------------------------------

  // `times` holds when each recent one happened (the last five weeks), for
  // Your week (shared/weekly.js); `count` is every one since the start.
  var KEPT_TIMES_MAX = 200;
  var KEPT_TIMES_MS = 35 * DAY;

  function normalizeKept(raw) {
    var k = raw && typeof raw === 'object' ? raw : {};
    var times = (Array.isArray(k.times) ? k.times : []).map(Number).filter(function (t) { return t > 0; })
      .sort(function (a, b) { return a - b; }).slice(-KEPT_TIMES_MAX);
    return { count: Number(k.count) > 0 ? Math.floor(Number(k.count)) : 0, last: Number(k.last) || 0, times: times };
  }

  function addKept(raw, now) {
    var k = normalizeKept(raw);
    var times = k.times.concat([now]).filter(function (t) { return t > now - KEPT_TIMES_MS; }).slice(-KEPT_TIMES_MAX);
    return { count: k.count + 1, last: now, times: times };
  }

  // --- Slips -------------------------------------------------------------------

  // A day as the user's own calendar sees it.
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function pick(list, allowed) {
    var ids = allowed.map(function (a) { return a.id; });
    return (Array.isArray(list) ? list : []).filter(function (id, i, all) {
      return ids.indexOf(id) >= 0 && all.indexOf(id) === i;
    });
  }

  function normalizeSlips(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter(function (s) { return s && typeof s.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.day); })
      .map(function (s) {
        var hour = Number(s.hour);
        return {
          day: s.day,
          hour: hour >= 0 && hour < 24 ? Math.floor(hour) : null,
          tags: pick(s.tags, SLIP_TAGS),
          helped: pick(s.helped, SLIP_HELPS),
          start: pickStart(s.start),
          at: Number(s.at) || 0
        };
      })
      .slice(-365);
  }

  function addSlip(raw, slip, now) {
    var list = normalizeSlips(raw);
    var at = typeof slip.at === 'number' ? slip.at : now;
    list.push({
      day: dayKey(at),
      hour: typeof slip.hour === 'number' ? slip.hour : new Date(at).getHours(),
      tags: pick(slip.tags, SLIP_TAGS),
      helped: pick(slip.helped, SLIP_HELPS),
      start: pickStart(slip.start),
      at: at
    });
    return normalizeSlips(list);
  }

  // A Risk Hours window around the hour of a slip: from an hour before to two
  // after, which is the offer the slip page makes.
  function suggestedRiskHours(hour) {
    var h = Number(hour) >= 0 && Number(hour) < 24 ? Math.floor(Number(hour)) : 23;
    var start = ((h - 1 + 24) % 24) * 60;
    var end = ((h + 2) % 24) * 60;
    return { enabled: true, start: start, end: end };
  }

  // --- Days kept ---------------------------------------------------------------

  // Intervals [start, end) when protection was off, from the audit log of
  // switches ({ enabled, timestamp }). A log that opens with "turned on" had
  // protection off before it; only that day is counted against it, since the
  // log does not say for how long.
  function offIntervals(log, now, currentlyEnabled) {
    var events = (Array.isArray(log) ? log : [])
      .filter(function (e) { return e && typeof e.timestamp === 'number'; })
      .slice()
      .sort(function (a, b) { return a.timestamp - b.timestamp; });
    var intervals = [];
    var offSince = null;
    events.forEach(function (e, i) {
      if (e.enabled === false) {
        if (offSince === null) offSince = e.timestamp;
      } else if (e.enabled === true) {
        if (offSince !== null) {
          intervals.push([offSince, e.timestamp]);
          offSince = null;
        } else if (i === 0) {
          intervals.push([startOfDay(e.timestamp), e.timestamp]);
        }
      }
    });
    if (offSince !== null) intervals.push([offSince, now]);
    else if (currentlyEnabled === false && !events.length) intervals.push([startOfDay(now), now]);
    return intervals;
  }

  // { kept, counted }: of the last `counted` days (up to 30, fewer for a new
  // install, today included), how many had no slip and no time unprotected.
  function daysKept(opts) {
    var now = opts.now;
    var windowDays = opts.windowDays || WINDOW_DAYS;
    var today = startOfDay(now);
    var first = typeof opts.firstSeen === 'number' && opts.firstSeen > 0 ? startOfDay(opts.firstSeen) : today;
    var sinceFirst = Math.floor((today - first) / DAY) + 1;
    var counted = Math.max(1, Math.min(windowDays, sinceFirst));
    var slipDays = {};
    normalizeSlips(opts.slips).forEach(function (s) { slipDays[s.day] = true; });
    var off = offIntervals(opts.disabledLog, now, opts.currentlyEnabled);

    var kept = 0;
    for (var i = 0; i < counted; i++) {
      var start = new Date(today);
      start.setDate(start.getDate() - i);
      var dayStart = start.getTime();
      var end = new Date(dayStart);
      end.setDate(end.getDate() + 1);
      var dayEnd = end.getTime();
      var broken = !!slipDays[dayKey(dayStart)] || off.some(function (iv) {
        return iv[0] < dayEnd && iv[1] > dayStart;
      });
      if (!broken) kept++;
    }
    return { kept: kept, counted: counted };
  }

  var exported = {
    WORDS_KEY: WORDS_KEY,
    PHOTO_KEY: PHOTO_KEY,
    PHOTO_MAX: PHOTO_MAX,
    photoSrc: photoSrc,
    SLIPS_KEY: SLIPS_KEY,
    KEPT_KEY: KEPT_KEY,
    FIRST_SEEN_KEY: FIRST_SEEN_KEY,
    LIMITS: LIMITS,
    SLIP_TAGS: SLIP_TAGS,
    SLIP_HELPS: SLIP_HELPS,
    SLIP_STARTS: SLIP_STARTS,
    normalizeWords: normalizeWords,
    hasWords: hasWords,
    telHref: telHref,
    normalizeKept: normalizeKept,
    addKept: addKept,
    dayKey: dayKey,
    normalizeSlips: normalizeSlips,
    addSlip: addSlip,
    suggestedRiskHours: suggestedRiskHours,
    offIntervals: offIntervals,
    daysKept: daysKept
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Moments = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
