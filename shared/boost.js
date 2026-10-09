// shared/boost.js
// Storm Mode and Risk Hours: two ways to raise protection for a while.
//
//   Storm Mode: "I'm struggling", pressed in a clear-enough moment. For 1, 4
//   or 12 hours everything goes to its strongest, and nothing that loosens
//   protection can be done, not even with a Pact's wait. It cannot be
//   cancelled; that is the point of it.
//
//   Risk Hours: the hours someone knows are hard (late at night, usually).
//   The same idea, lighter, on a schedule: strictness up, image search
//   blurred, and nothing loosened until the window ends.
//
// A boost works by writing the stronger settings and remembering what they
// were (`overlay`), so every part of the extension that reads the settings
// sees the boost without knowing it exists. When it ends, `restore` puts back
// each value the boost changed, unless the user changed it since. Protection
// itself is never switched back off: a boost that turned it on leaves it on.
//
// The background owns all of this (background.js, "Storm Mode and Risk
// Hours"); pages read STATE_KEY to know whether a boost is on.
//
// Loaded with importScripts in the service worker, as a classic <script> in
// pages, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var STORM_KEY = 'pblocker_storm';
  var RISK_KEY = 'pblocker_risk_hours';
  var STATE_KEY = 'pblocker_boost_state';

  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;
  var STORM_HOURS = [1, 4, 12];
  // Offline, a storm's end can't be checked against the server clock. It then
  // runs this much longer than planned, so moving the computer's clock while
  // offline buys little; and it still ends, so nobody is locked in for good.
  var OFFLINE_GRACE = 6 * HOUR;

  var STORM_SETTINGS = {
    enabled: true,
    useSmartBlocking: true,
    imageFilterLevel: 'strict',
    aiImageBlocker: true,
    aiImageScanAllSites: true,
    aiStrictness: 'strict',
    aiTextBlocker: true,
    aiTextStrictness: 'strict',
    safeSearchEnabled: true,
    facebookReelsEnabled: true,
    instagramReelsEnabled: true,
    searchImagesBlurred: true
  };

  // Lighter: no models switched on that the user had chosen to leave off.
  var RISK_SETTINGS = {
    enabled: true,
    useSmartBlocking: true,
    imageFilterLevel: 'strict',
    aiStrictness: 'strict',
    aiTextStrictness: 'strict',
    safeSearchEnabled: true,
    searchImagesBlurred: true
  };

  // --- Storm Mode ------------------------------------------------------------

  function normalizeStorm(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var duration = Number(raw.durationMs);
    var started = Number(raw.startedAt);
    if (!(duration > 0) || !(started > 0)) return null;
    return {
      startedAt: started,
      startedAtServer: typeof raw.startedAtServer === 'number' ? raw.startedAtServer : null,
      durationMs: duration
    };
  }

  // A new storm, or a longer one: pressing it again can only extend it.
  function startStorm(existing, hours, now, serverNow) {
    var h = STORM_HOURS.indexOf(Number(hours)) >= 0 ? Number(hours) : 1;
    var next = { startedAt: now, startedAtServer: typeof serverNow === 'number' ? serverNow : null, durationMs: h * HOUR };
    var current = normalizeStorm(existing);
    if (current && current.startedAt + current.durationMs > next.startedAt + next.durationMs) return current;
    return next;
  }

  function stormEndsAt(storm) {
    var s = normalizeStorm(storm);
    return s ? s.startedAt + s.durationMs : 0;
  }

  // With the server clock: wall time since it began. Without it: the device
  // clock, plus the offline grace when the storm began with a server time.
  function stormOver(storm, now, serverNow) {
    var s = normalizeStorm(storm);
    if (!s) return true;
    if (typeof serverNow === 'number' && s.startedAtServer !== null) {
      return serverNow >= s.startedAtServer + s.durationMs;
    }
    if (s.startedAtServer === null) return now >= s.startedAt + s.durationMs;
    return now >= s.startedAt + s.durationMs + OFFLINE_GRACE;
  }

  // --- Risk Hours ------------------------------------------------------------

  function clampMinutes(value, fallback) {
    var n = Math.round(Number(value));
    return n >= 0 && n < 1440 ? n : fallback;
  }

  function normalizeRisk(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var start = clampMinutes(r.start, 23 * 60);
    var end = clampMinutes(r.end, 2 * 60);
    return { enabled: r.enabled === true && start !== end, start: start, end: end };
  }

  function minutesOf(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // The window may run past midnight (23:00 to 02:00).
  function inRiskHours(risk, date) {
    var r = normalizeRisk(risk);
    if (!r.enabled) return false;
    var m = minutesOf(date);
    return r.start < r.end ? (m >= r.start && m < r.end) : (m >= r.start || m < r.end);
  }

  // The next moment, after `date`, at which the clock reads `minutes`.
  function nextAt(minutes, date) {
    var next = new Date(date.getTime());
    next.setSeconds(0, 0);
    next.setHours(Math.floor(minutes / 60), minutes % 60);
    if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  function riskEndsAt(risk, date) {
    return nextAt(normalizeRisk(risk).end, date);
  }

  // When the window next opens or closes, so the background can wake then.
  function nextRiskChange(risk, date) {
    var r = normalizeRisk(risk);
    if (!r.enabled) return null;
    return inRiskHours(r, date) ? nextAt(r.end, date) : nextAt(r.start, date);
  }

  function formatMinutes(minutes) {
    var d = new Date(2026, 0, 1, Math.floor(minutes / 60), minutes % 60);
    try {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
    }
  }

  // --- Which boost, if any ---------------------------------------------------

  // Storm wins over Risk Hours: it is the stronger of the two.
  function desired(storm, risk, now, serverNow) {
    if (normalizeStorm(storm) && !stormOver(storm, now, serverNow)) {
      return { kind: 'storm', until: stormEndsAt(storm) };
    }
    var date = new Date(now);
    if (inRiskHours(risk, date)) return { kind: 'risk', until: riskEndsAt(risk, date) };
    return null;
  }

  function targetFor(kind) {
    return kind === 'storm' ? STORM_SETTINGS : (kind === 'risk' ? RISK_SETTINGS : null);
  }

  // Writes the boost's values over `settings`. `snapshot` holds what each
  // changed key was before, so restore can put it back.
  function overlay(settings, kind) {
    var target = targetFor(kind) || {};
    var next = Object.assign({}, settings || {});
    var snapshot = {};
    Object.keys(target).forEach(function (key) {
      if (next[key] !== target[key]) {
        snapshot[key] = Object.prototype.hasOwnProperty.call(next, key) ? next[key] : null;
        next[key] = target[key];
      }
    });
    return { settings: next, snapshot: snapshot };
  }

  // Puts back what the boost changed. A key the user has changed since is
  // left as they set it. `enabled` is never put back to off.
  function restore(settings, snapshot, kind) {
    var target = targetFor(kind) || {};
    var next = Object.assign({}, settings || {});
    Object.keys(snapshot || {}).forEach(function (key) {
      if (key === 'enabled') return;
      if (next[key] !== target[key]) return;
      if (snapshot[key] === null) delete next[key];
      else next[key] = snapshot[key];
    });
    return next;
  }

  // --- Pages -----------------------------------------------------------------

  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || (raw.active !== 'storm' && raw.active !== 'risk')) return null;
    return {
      active: raw.active,
      until: Number(raw.until) || 0,
      snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : {}
    };
  }

  function readState(storage) {
    return Promise.resolve(storage.get(STATE_KEY)).then(function (data) {
      return normalizeState(data && data[STATE_KEY]);
    }, function () { return null; });
  }

  function formatUntil(until, now) {
    try {
      var when = new Date(until);
      var time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (when.toDateString() === new Date(now).toDateString()) return time;
      return when.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    } catch (_) {
      return '';
    }
  }

  // The sentence every page shows when a loosening change is refused.
  function refusal(state, now) {
    if (!state) return '';
    var until = formatUntil(state.until, now);
    return state.active === 'storm'
      ? 'Storm Mode is on until ' + until + '. Nothing that loosens protection can be changed until then.'
      : 'Your risk hours run until ' + until + '. Nothing that loosens protection can be changed until then.';
  }

  var exported = {
    STORM_KEY: STORM_KEY,
    RISK_KEY: RISK_KEY,
    STATE_KEY: STATE_KEY,
    STORM_HOURS: STORM_HOURS,
    STORM_SETTINGS: STORM_SETTINGS,
    RISK_SETTINGS: RISK_SETTINGS,
    OFFLINE_GRACE: OFFLINE_GRACE,
    normalizeStorm: normalizeStorm,
    startStorm: startStorm,
    stormEndsAt: stormEndsAt,
    stormOver: stormOver,
    normalizeRisk: normalizeRisk,
    inRiskHours: inRiskHours,
    riskEndsAt: riskEndsAt,
    nextRiskChange: nextRiskChange,
    formatMinutes: formatMinutes,
    desired: desired,
    overlay: overlay,
    restore: restore,
    normalizeState: normalizeState,
    readState: readState,
    formatUntil: formatUntil,
    refusal: refusal
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Boost = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
