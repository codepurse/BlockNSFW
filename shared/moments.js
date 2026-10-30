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
//   Waits: the same moments, each with how long it took to pass, and how
//   strong it was before and after when the person said. Proof it passes
//   (a Supporter extra, extras/proof.js) draws them as a dial: urges pass,
//   and this is how long yours take.
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
  // A message in the person's own voice for the hard moment, recorded in
  // Settings (a Supporter extra, up to a minute) or a sound file they chose
  // (up to ten minutes and 15 MB). The sound itself is a file in IndexedDB
  // (shared/sound-store.js); this key holds a note about it:
  //   { store: 'idb', type, size, at, ms, auto }
  // (One kept before that, or carried in a backup, holds the sound itself as
  // a data: URL instead: { src, at, ms, auto }.) It plays when they tap it, or
  // by itself on the blocked page when `auto` is set and the browser allows
  // it. It stays on the device.
  var VOICE_KEY = 'pblocker_moment_voice';
  var VOICE_FILE_MAX = 15 * 1024 * 1024;
  var VOICE_MAX = Math.ceil(VOICE_FILE_MAX / 3) * 4 + 64;
  var VOICE_MS_MAX = 600000;
  var VOICE_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
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

  // The voice message's src, or '' when there is none or it isn't plain
  // audio (WebM, Ogg or MP4 as browsers record it; MP3 or WAV as files come).
  function voiceSrc(raw) {
    var src = raw && typeof raw === 'object' && typeof raw.src === 'string' ? raw.src : '';
    return src.length <= VOICE_MAX && /^data:audio\/(webm|ogg|mp4|mpeg|wav);base64,[A-Za-z0-9+\/]+=*$/.test(src) ? src : '';
  }

  // Whether the note points to a sound kept in IndexedDB, of a plain kind
  // and a size it may be.
  function voiceStored(raw) {
    return !!(raw && typeof raw === 'object' && raw.store === 'idb' && VOICE_TYPES.indexOf(raw.type) !== -1 &&
      Number(raw.size) > 0 && Number(raw.size) <= VOICE_FILE_MAX);
  }

  // Whether there is a sound to hear, either way it's kept.
  function hasVoice(raw) {
    return !!voiceSrc(raw) || voiceStored(raw);
  }

  // Whether it plays by itself when a page is blocked.
  function voiceAuto(raw) {
    return !!(raw && typeof raw === 'object' && raw.auto === true && hasVoice(raw));
  }

  // How long it runs, in milliseconds (0 when unknown).
  function voiceMs(raw) {
    var ms = raw && typeof raw === 'object' ? Math.floor(Number(raw.ms)) : 0;
    return ms > 0 ? Math.min(ms, VOICE_MS_MAX) : 0;
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

  // --- Waits -------------------------------------------------------------------

  // [{ at, ms, before, after }]: when the wait started, how long until "I'm OK
  // now" (never past the wait's own length, so a tab left open overnight
  // still says ten minutes), and how strong it was from 1 (barely) to 5
  // (overwhelming), or null when not said. The last WAITS_MAX are kept.
  var WAITS_KEY = 'pblocker_waits';
  var WAITS_MAX = 200;
  var WAIT_MS_MAX = 20 * 60 * 1000;
  var STRENGTHS = ['Barely', 'Some', 'Strong', 'Very strong', 'Overwhelming'];

  function strength(value) {
    var n = Number(value);
    return n >= 1 && n <= STRENGTHS.length && Math.floor(n) === n ? n : null;
  }

  function normalizeWaits(raw) {
    var byAt = {};
    (Array.isArray(raw) ? raw : []).forEach(function (w) {
      if (!w || typeof w !== 'object') return;
      var at = Math.floor(Number(w.at));
      var ms = Math.floor(Number(w.ms));
      if (!(at > 0) || !(ms >= 0)) return;
      byAt[at] = { at: at, ms: Math.min(ms, WAIT_MS_MAX), before: strength(w.before), after: strength(w.after) };
    });
    return Object.keys(byAt).map(function (k) { return byAt[k]; })
      .sort(function (a, b) { return a.at - b.at; })
      .slice(-WAITS_MAX);
  }

  // One more, or the same one again (the same `at`) told more.
  function addWait(raw, wait) {
    return normalizeWaits(normalizeWaits(raw).concat([wait]));
  }

  // How strong it was after, said once the wait was over.
  function rateWait(raw, at, after) {
    return normalizeWaits(raw).map(function (w) {
      return w.at === at ? { at: w.at, ms: w.ms, before: w.before, after: strength(after) } : w;
    });
  }

  // Two records of waits as one (a backup restored here): every wait once,
  // and what either knows about how strong it was.
  function mergeWaits(a, b) {
    var mine = normalizeWaits(a);
    var byAt = {};
    mine.forEach(function (w) { byAt[w.at] = w; });
    normalizeWaits(b).forEach(function (w) {
      var here = byAt[w.at];
      byAt[w.at] = here
        ? { at: here.at, ms: here.ms, before: here.before || w.before, after: here.after || w.after }
        : w;
    });
    return normalizeWaits(Object.keys(byAt).map(function (k) { return byAt[k]; }));
  }

  // --- Proof it passes ---------------------------------------------------------

  // { on, ended, at }: whether the blocked page draws the dial. The switch is
  // a Supporter extra in Settings; the plan turns it on (the first time, and
  // again after a plan that ended) and off when it ends. The blocked page
  // reads only this, never the plan.
  var PROOF_KEY = 'pblocker_proof';

  function proofOn(raw) {
    return !!(raw && typeof raw === 'object' && raw.on === true);
  }

  // What the plan does to the switch, or null to leave it: a supporter gets
  // it unless they turned it off themselves; a plan that ends turns it off.
  function proofForPlan(raw, supporter, now) {
    var p = raw && typeof raw === 'object' ? raw : null;
    if (supporter) return !p || p.ended === true ? { on: true, at: now } : null;
    return p && p.on === true ? { on: false, ended: true, at: now } : null;
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

  // { kept, counted, days }: of the last `counted` days (up to 30, fewer for a
  // new install, today included), how many had no slip and no time
  // unprotected; `days` is each of them, oldest first, true when kept.
  // `others` (shared/progress.js others()) adds your other computers: a day
  // is kept only if it was kept on every one.
  function daysKept(opts) {
    var now = opts.now;
    var o = opts.others || null;
    var windowDays = opts.windowDays || WINDOW_DAYS;
    var today = startOfDay(now);
    var firstSeen = typeof opts.firstSeen === 'number' && opts.firstSeen > 0 ? opts.firstSeen : 0;
    if (o && o.firstSeen > 0 && (!firstSeen || o.firstSeen < firstSeen)) firstSeen = o.firstSeen;
    var first = firstSeen ? startOfDay(firstSeen) : today;
    var sinceFirst = Math.floor((today - first) / DAY) + 1;
    var counted = Math.max(1, Math.min(windowDays, sinceFirst));
    var slipDays = {};
    normalizeSlips(opts.slips).concat(o ? o.slips : []).forEach(function (s) { slipDays[s.day] = true; });
    var off = offIntervals(opts.disabledLog, now, opts.currentlyEnabled).concat(o ? o.off : []);

    var kept = 0;
    var days = [];
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
      days.unshift(!broken);
    }
    return { kept: kept, counted: counted, days: days };
  }

  var exported = {
    WORDS_KEY: WORDS_KEY,
    PHOTO_KEY: PHOTO_KEY,
    PHOTO_MAX: PHOTO_MAX,
    photoSrc: photoSrc,
    VOICE_KEY: VOICE_KEY,
    VOICE_MAX: VOICE_MAX,
    voiceSrc: voiceSrc,
    voiceMs: voiceMs,
    voiceAuto: voiceAuto,
    voiceStored: voiceStored,
    hasVoice: hasVoice,
    VOICE_FILE_MAX: VOICE_FILE_MAX,
    VOICE_MS_MAX: VOICE_MS_MAX,
    VOICE_TYPES: VOICE_TYPES,
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
    WAITS_KEY: WAITS_KEY,
    WAITS_MAX: WAITS_MAX,
    WAIT_MS_MAX: WAIT_MS_MAX,
    STRENGTHS: STRENGTHS,
    strength: strength,
    normalizeWaits: normalizeWaits,
    addWait: addWait,
    rateWait: rateWait,
    mergeWaits: mergeWaits,
    PROOF_KEY: PROOF_KEY,
    proofOn: proofOn,
    proofForPlan: proofForPlan,
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
