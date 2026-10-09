// shared/pact.js
// The Pact: a promise made in a clear moment, kept by time and, optionally,
// by a friend.
//
// While a Pact is active, any change that weakens protection (turning it off,
// whitelisting a site, switching off a layer, removing a list, clearing the
// PIN...) does not happen when it is asked for. It is queued, and the
// background applies it once the delay the user chose has passed. Changes
// that strengthen protection apply at once. A queued change can be cancelled
// at any time, and a code from the witness (shared/totp.js) lets it through
// immediately.
//
// The reasoning: a PIN you set yourself stops nobody, because you know it,
// and typing a long sentence takes a few minutes while a craving lasts
// longer. A wait longer than the urge works even when you know every PIN.
//
// Time has to be honest for this to mean anything, so the delay is measured
// two ways (see `tick` and `isReady`):
//   - the server clock, from the Date header of a request the extension
//     already makes to GitHub, which moving the computer's clock can't change;
//   - when offline, only time the browser was actually running, credited in
//     steps of at most three minutes, so a jump in the system clock counts
//     for nothing.
//
// This file is pure logic plus thin storage and messaging helpers. The
// background is the only writer of the queue (background.js, "The Pact");
// pages ask it by message.
//
// Loaded with importScripts in the service worker, as a classic <script> in
// pages, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var PACT_KEY = 'pblocker_pact';
  var QUEUE_KEY = 'pblocker_pact_queue';
  var CLOCK_KEY = 'pblocker_pact_clock';
  var CODE_LOCK_KEY = 'pblocker_pact_code_lock';

  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;
  // Pluckeye's docs warn against starting at days rather than minutes; the
  // shortest step is there so people start small and lengthen it.
  var DELAYS = [15 * MINUTE, HOUR, DAY, 3 * DAY];
  var DEFAULT_DELAY = HOUR;
  // A tick further apart than this is a gap (the browser was closed or asleep,
  // or the clock moved), and a gap is credited only once the server clock
  // confirms it.
  var MAX_STEP = 3 * MINUTE;
  var TICK_MINUTES = 1;
  // How stale the server-clock offset may get before it is measured again
  // while something is waiting.
  var OFFSET_STALE = 30 * MINUTE;
  // The extension already reads this file every 12 hours to check for
  // updates, so asking it for the time adds no new destination.
  var SERVER_TIME_URL = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/main/data/version.json';

  var KINDS = [
    'disable',          // turn protection off
    'settings',         // { set, removeFrom, addTo } on pblocker_settings
    'settings-replace', // { settings }: reset to defaults
    'whitelist-add',    // { domain, path, type, durationMs }
    'pin-clear',        // remove the PIN
    'access-code',      // { config }: turn off, narrow or shorten the code
    'subscription',     // { id, action: 'off' | 'remove' }
    'model-clear',      // { model }: delete downloaded model weights
    'audit-clear',      // empty the audit log
    'risk-hours',       // { risk }: turn Risk Hours off or shorten them (shared/boost.js)
    'pact'              // { action: 'delay', delayMs } | { action: 'end' } | { action: 'remove-witness' }
  ];

  // --- The pact itself -------------------------------------------------------

  function normalizeDelay(ms) {
    var value = Number(ms);
    return DELAYS.indexOf(value) >= 0 ? value : DEFAULT_DELAY;
  }

  function normalizeWitness(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.secret !== 'string' || !raw.secret) return null;
    return {
      secret: raw.secret,
      pairedAt: Number(raw.pairedAt) || 0,
      lastCounter: typeof raw.lastCounter === 'number' ? raw.lastCounter : -1,
      recovery: Array.isArray(raw.recovery)
        ? raw.recovery
          .filter(function (r) { return r && typeof r.hash === 'string'; })
          .map(function (r) { return { hash: r.hash, used: r.used === true }; })
        : []
    };
  }

  function normalizePact(raw) {
    if (!raw || typeof raw !== 'object' || raw.active !== true) return null;
    var witness = normalizeWitness(raw.witness);
    return {
      active: true,
      delayMs: normalizeDelay(raw.delayMs),
      createdAt: Number(raw.createdAt) || 0,
      witness: witness,
      // Only meaningful with a witness to hold it.
      pinSealed: raw.pinSealed === true && !!witness
    };
  }

  function createPact(delayMs, now) {
    return { active: true, delayMs: normalizeDelay(delayMs), createdAt: now, witness: null, pinSealed: false };
  }

  function isActive(pact) {
    return !!(pact && pact.active === true);
  }

  function recoveryLeft(pact) {
    if (!pact || !pact.witness) return 0;
    return pact.witness.recovery.filter(function (r) { return !r.used; }).length;
  }

  // --- The queue ---------------------------------------------------------------

  function randomId() {
    var c = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    var bytes = new Uint8Array(8);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var hex = '';
    for (var j = 0; j < bytes.length; j++) hex += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    return hex;
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || KINDS.indexOf(raw.kind) < 0 || typeof raw.id !== 'string') return null;
    return {
      id: raw.id,
      kind: raw.kind,
      label: String(raw.label || '').slice(0, 160),
      payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
      delayMs: Number(raw.delayMs) > 0 ? Number(raw.delayMs) : DEFAULT_DELAY,
      requestedAt: Number(raw.requestedAt) || 0,
      requestedAtServer: typeof raw.requestedAtServer === 'number' ? raw.requestedAtServer : null,
      runMs: Number(raw.runMs) > 0 ? Number(raw.runMs) : 0
    };
  }

  function normalizeQueue(raw) {
    return Array.isArray(raw) ? raw.map(normalizeEntry).filter(Boolean) : [];
  }

  // `change` is { kind, label, payload } from the page. The delay is the one in
  // force when it is asked for: lengthening the Pact later does not move a
  // change that is already waiting, and shortening it never can.
  function makeEntry(change, delayMs, now, serverNow) {
    return normalizeEntry({
      id: randomId(),
      kind: change && change.kind,
      label: change && change.label,
      payload: change && change.payload,
      delayMs: delayMs,
      requestedAt: now,
      requestedAtServer: typeof serverNow === 'number' ? serverNow : null,
      runMs: 0
    });
  }

  // --- Honest time ---------------------------------------------------------------

  function normalizeClock(raw) {
    var clock = raw && typeof raw === 'object' ? raw : {};
    return {
      lastTick: typeof clock.lastTick === 'number' ? clock.lastTick : null,
      offset: typeof clock.offset === 'number' ? clock.offset : null,
      offsetAt: typeof clock.offsetAt === 'number' ? clock.offsetAt : 0
    };
  }

  // Credits running time to everything waiting. A step longer than MAX_STEP,
  // or backwards, earns nothing here; the server clock settles it later.
  function tick(rawClock, queue, now) {
    var clock = normalizeClock(rawClock);
    var credit = 0;
    if (clock.lastTick !== null) {
      var delta = now - clock.lastTick;
      if (delta > 0 && delta <= MAX_STEP) credit = delta;
    }
    clock.lastTick = now;
    return {
      clock: clock,
      credit: credit,
      queue: queue.map(function (entry) {
        var next = Object.assign({}, entry);
        next.runMs = entry.runMs + credit;
        return next;
      })
    };
  }

  // A change asked for while offline has no server start time. The first time
  // the server answers, it gets one: now, less the running time it has
  // already served, which never overstates the wait.
  function backfill(queue, serverNow) {
    if (typeof serverNow !== 'number') return queue;
    return queue.map(function (entry) {
      if (entry.requestedAtServer !== null) return entry;
      var next = Object.assign({}, entry);
      next.requestedAtServer = serverNow - entry.runMs;
      return next;
    });
  }

  function elapsedMs(entry, serverNow) {
    if (typeof serverNow === 'number' && entry.requestedAtServer !== null) {
      return Math.max(0, serverNow - entry.requestedAtServer);
    }
    return entry.runMs;
  }

  // With the server clock: wall time since the change was asked for, so a
  // night with the laptop closed counts. Without it: running time only.
  function isReady(entry, serverNow) {
    return elapsedMs(entry, serverNow) >= entry.delayMs;
  }

  function estimateServerNow(rawClock, now) {
    var clock = normalizeClock(rawClock);
    return clock.offset !== null ? now + clock.offset : null;
  }

  function remainingMs(entry, rawClock, now) {
    return Math.max(0, entry.delayMs - elapsedMs(entry, estimateServerNow(rawClock, now)));
  }

  // Worth asking the server: something may be due, something has no server
  // start time yet, or the offset used for the countdown has gone stale.
  function needsServerCheck(queue, rawClock, now) {
    if (!queue.length) return false;
    var clock = normalizeClock(rawClock);
    if (clock.offset === null || now - clock.offsetAt > OFFSET_STALE) return true;
    return queue.some(function (entry) {
      return entry.requestedAtServer === null || remainingMs(entry, clock, now) <= MAX_STEP || entry.runMs >= entry.delayMs;
    });
  }

  // --- Applying changes (pure parts) ---------------------------------------------

  function lower(value) {
    return String(value).toLowerCase();
  }

  // `ops.set` overwrites keys; `removeFrom` and `addTo` edit lists by value,
  // case-insensitively, so anything added to the same list while the change
  // waited is kept.
  function applySettingsOps(settings, ops) {
    var next = Object.assign({}, settings || {});
    var o = ops || {};
    if (o.set && typeof o.set === 'object') {
      Object.keys(o.set).forEach(function (key) { next[key] = o.set[key]; });
    }
    if (o.removeFrom && typeof o.removeFrom === 'object') {
      Object.keys(o.removeFrom).forEach(function (key) {
        var drop = {};
        (o.removeFrom[key] || []).forEach(function (item) { drop[lower(item)] = true; });
        next[key] = (Array.isArray(next[key]) ? next[key] : []).filter(function (item) { return !drop[lower(item)]; });
      });
    }
    if (o.addTo && typeof o.addTo === 'object') {
      Object.keys(o.addTo).forEach(function (key) {
        var list = Array.isArray(next[key]) ? next[key].slice() : [];
        var have = {};
        list.forEach(function (item) { have[lower(item)] = true; });
        (o.addTo[key] || []).forEach(function (item) {
          if (have[lower(item)]) return;
          list.push(item);
          have[lower(item)] = true;
        });
        next[key] = list;
      });
    }
    return next;
  }

  // Mirrors popup.js addToWhitelist. A temporary entry's clock starts when it
  // is applied, not when it was asked for, or a 15-minute allowance queued
  // behind an hour's wait would expire before it began.
  function addWhitelistEntry(list, payload, now) {
    var whitelist = Array.isArray(list) ? list.slice() : [];
    var domain = String(payload && payload.domain || '');
    if (!domain) return whitelist;
    var path = payload.path || null;
    var temporary = payload.type === 'temporary';
    var entry = {
      domain: domain,
      path: path,
      type: temporary ? 'temporary' : 'permanent',
      addedAt: now,
      expiresAt: temporary ? now + (Number(payload.durationMs) || HOUR) : null
    };
    var index = whitelist.findIndex(function (item) {
      return item.domain === domain && (item.path || null) === path;
    });
    if (index >= 0) whitelist[index] = entry;
    else whitelist.push(entry);
    return whitelist;
  }

  // --- Witness codes -------------------------------------------------------------

  var CODE_FREE_TRIES = 5;
  var CODE_FIRST_WAIT = 5 * MINUTE;
  var CODE_LONGEST_WAIT = HOUR;

  function codeLockState(raw, now) {
    var fails = raw && Number(raw.fails) > 0 ? Number(raw.fails) : 0;
    var until = raw && Number(raw.until) > 0 ? Number(raw.until) : 0;
    return { fails: fails, until: until, locked: until > now, waitMs: Math.max(0, until - now) };
  }

  function afterCodeFailure(raw, now) {
    var fails = codeLockState(raw, now).fails + 1;
    var until = 0;
    if (fails >= CODE_FREE_TRIES) {
      until = now + Math.min(CODE_LONGEST_WAIT, CODE_FIRST_WAIT * Math.pow(2, fails - CODE_FREE_TRIES));
    }
    return { fails: fails, until: until };
  }

  // Whether typed text could be a witness code: six digits from their app, or
  // one of their recovery codes (XXXX-XXXX). Used to try a code typed into a
  // PIN box, since both come from the witness and both are short.
  function looksLikeWitnessCode(text) {
    var value = String(text == null ? '' : text).trim();
    if (/^\d{3}\s?\d{3}$/.test(value)) return true;
    return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(value);
  }

  // Resolves { ok, witness, via } where `witness` is the witness record to
  // save back (it remembers the last code used, and which recovery codes are
  // spent). `times` are the clocks to check the code against.
  function checkWitnessCode(pact, code, times, Totp) {
    var witness = pact && pact.witness;
    if (!witness || !Totp) return Promise.resolve({ ok: false });
    if (Totp.looksLikeRecoveryCode(code)) {
      return Totp.hashRecoveryCode(code).then(function (hash) {
        var index = witness.recovery.findIndex(function (r) { return !r.used && r.hash === hash; });
        if (index < 0) return { ok: false };
        var next = Object.assign({}, witness, { recovery: witness.recovery.slice() });
        next.recovery[index] = { hash: hash, used: true };
        return { ok: true, witness: next, via: 'recovery' };
      });
    }
    return Totp.verify(witness.secret, code, { times: times, lastCounter: witness.lastCounter })
      .then(function (result) {
        if (!result.ok) return { ok: false };
        return { ok: true, witness: Object.assign({}, witness, { lastCounter: result.counter }), via: 'code' };
      });
  }

  // --- Words -------------------------------------------------------------------------

  function formatDelay(ms) {
    var value = normalizeDelay(ms);
    if (value === 15 * MINUTE) return '15 minutes';
    if (value === HOUR) return '1 hour';
    if (value === DAY) return '24 hours';
    return '3 days';
  }

  function formatRemaining(ms) {
    if (ms <= MINUTE) return 'under a minute';
    var minutes = Math.ceil(ms / MINUTE);
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    if (hours < 24) return mins ? hours + ' h ' + mins + ' min' : hours + ' h';
    var days = Math.floor(hours / 24);
    var h = hours % 24;
    return h ? days + ' d ' + h + ' h' : days + ' d';
  }

  // "21:40" today, "Tue 21:40" on another day, in the user's own format.
  function formatWhen(ms, now) {
    try {
      var when = new Date(ms);
      var today = new Date(now);
      var time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (when.toDateString() === today.toDateString()) return time;
      return when.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    } catch (_) {
      return '';
    }
  }

  function sentenceCase(text) {
    var value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  // --- Page helpers ----------------------------------------------------------------

  function readAll(storage) {
    return Promise.resolve(storage.get([PACT_KEY, QUEUE_KEY, CLOCK_KEY])).then(function (store) {
      var data = store || {};
      return {
        pact: normalizePact(data[PACT_KEY]),
        queue: normalizeQueue(data[QUEUE_KEY]),
        clock: normalizeClock(data[CLOCK_KEY])
      };
    }, function () {
      return { pact: null, queue: [], clock: normalizeClock(null) };
    });
  }

  function readPact(storage) {
    return readAll(storage).then(function (all) { return all.pact; });
  }

  // Resolves the background's reply, or null if it could not be reached.
  function ask(message) {
    var api = (root && root.chrome && root.chrome.runtime) ? root.chrome
      : (typeof chrome !== 'undefined' ? chrome : null);
    return new Promise(function (resolve) {
      try {
        api.runtime.sendMessage(message, function (reply) {
          if (api.runtime.lastError) return resolve(null);
          resolve(reply || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  var exported = {
    PACT_KEY: PACT_KEY,
    QUEUE_KEY: QUEUE_KEY,
    CLOCK_KEY: CLOCK_KEY,
    CODE_LOCK_KEY: CODE_LOCK_KEY,
    DELAYS: DELAYS,
    DEFAULT_DELAY: DEFAULT_DELAY,
    MAX_STEP: MAX_STEP,
    TICK_MINUTES: TICK_MINUTES,
    SERVER_TIME_URL: SERVER_TIME_URL,
    KINDS: KINDS,
    normalizeDelay: normalizeDelay,
    normalizePact: normalizePact,
    createPact: createPact,
    isActive: isActive,
    recoveryLeft: recoveryLeft,
    normalizeQueue: normalizeQueue,
    makeEntry: makeEntry,
    normalizeClock: normalizeClock,
    tick: tick,
    backfill: backfill,
    elapsedMs: elapsedMs,
    isReady: isReady,
    estimateServerNow: estimateServerNow,
    remainingMs: remainingMs,
    needsServerCheck: needsServerCheck,
    applySettingsOps: applySettingsOps,
    addWhitelistEntry: addWhitelistEntry,
    codeLockState: codeLockState,
    afterCodeFailure: afterCodeFailure,
    looksLikeWitnessCode: looksLikeWitnessCode,
    checkWitnessCode: checkWitnessCode,
    formatDelay: formatDelay,
    formatRemaining: formatRemaining,
    formatWhen: formatWhen,
    sentenceCase: sentenceCase,
    readAll: readAll,
    readPact: readPact,
    ask: ask
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Pact = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
