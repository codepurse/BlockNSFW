// shared/weekly.js
// Your week: once a week, what the week looked like, in plain words.
//
// Everything 2.0.0 records about the hard moments (stops at a gateway's door,
// moments waited out, slips, days kept) is scattered across Statistics as
// separate totals. Once a week this reads them back as one story: the week
// drawn day by day, three numbers beside the week before, and one thing to
// try next, taken from the week itself (usually the hour it gets hard).
//
// A week runs Monday to Sunday, and its letter is ready on Sunday from 6 pm.
// The popup marks it new until it's opened; nothing opens a tab by itself.
// All of it is read from storage.local on the device; nothing is sent
// anywhere.
//
// Plain data in, plain data out: week.js draws it, popup.js asks only whether
// there's a new one, and node tests pin the wording.

(function (root) {
  'use strict';

  var SEEN_KEY = 'pblocker_week_seen';   // start (YYYY-MM-DD) of the newest week opened
  // Weeks run Monday to Sunday everywhere, so the letter is a Sunday-evening
  // thing whatever the locale's calendar starts on.
  var MONDAY = 1;
  var READY_HOUR = 18;
  // Stops and kept moments keep five weeks of times, so four weeks back is as
  // far as a week can be told together with the one before it.
  var WEEKS_BACK = 4;
  var DAY = 24 * 60 * 60 * 1000;
  var WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  function word(n) {
    return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // --- Calendar ----------------------------------------------------------------

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Calendar days, not 24-hour steps, so a clock change never shifts a week.
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

  // Midnight on the first day of the week holding `ms`. firstDay: 0 Sunday,
  // 1 Monday, as the reader's locale counts weeks.
  function weekStart(ms, firstDay) {
    var day = startOfDay(ms);
    var back = (new Date(day).getDay() - (firstDay || 0) + 7) % 7;
    return addDays(day, -back);
  }

  function readyAt(start) {
    var d = new Date(addDays(start, 6));
    d.setHours(READY_HOUR, 0, 0, 0);
    return d.getTime();
  }

  // The newest week whose letter is ready: this one from its last evening,
  // otherwise the one before.
  function latestReady(now, firstDay) {
    var current = weekStart(now, firstDay);
    return now >= readyAt(current) ? current : addDays(current, -7);
  }

  // The weeks the page can show, oldest to newest start: not before the week
  // the extension was first seen, nor further back than the times are kept;
  // the newest is the week in progress.
  function range(now, firstDay, firstSeen) {
    var current = weekStart(now, firstDay);
    var oldest = addDays(current, -7 * WEEKS_BACK);
    if (firstSeen > 0) oldest = Math.max(oldest, weekStart(firstSeen, firstDay));
    return { oldest: Math.min(oldest, current), newest: current };
  }

  // Whether the popup should say a new week is waiting: a ready week not yet
  // opened, with at least a couple of days of it seen by the extension.
  function hasNew(now, firstDay, seenKey, firstSeen) {
    var start = latestReady(now, firstDay);
    if (!(firstSeen > 0) || firstSeen > readyAt(start) - 2 * DAY) return false;
    var seen = parseKey(seenKey);
    return seen === null || seen < start;
  }

  // --- One week's events ---------------------------------------------------------

  // input: { now, firstSeen, stops: [{ key, at }], kept: [ms], slips (normalized,
  //   shared/moments.js), off: [[from, to]] (Moments.offIntervals) }
  // Days are 'kept', 'broken' (a slip, or protection off for part of it),
  // 'ahead' (not yet) or 'before' (before the extension was here).
  function collect(input, start) {
    var now = input.now;
    var end = addDays(start, 7);
    var firstDayStart = input.firstSeen > 0 ? startOfDay(input.firstSeen) : startOfDay(now);
    var slipDays = {};
    var events = [];

    (input.stops || []).forEach(function (s) {
      if (s && s.at >= start && s.at < end) events.push({ type: 'stop', at: s.at, key: s.key });
    });
    (input.kept || []).forEach(function (at) {
      if (at >= start && at < end) events.push({ type: 'kept', at: at });
    });
    (input.slips || []).forEach(function (s) {
      var at = s.at > 0 ? s.at : null;
      if (!at) {
        var day = parseKey(s.day);
        if (day === null) return;
        var d = new Date(day);
        d.setHours(s.hour === null || s.hour === undefined ? 12 : s.hour, 30, 0, 0);
        at = d.getTime();
      }
      slipDays[s.day || dayKey(at)] = true;
      if (at >= start && at < end) events.push({ type: 'slip', at: at, start: s.start || null, tags: s.tags || [] });
    });
    events.sort(function (a, b) { return a.at - b.at; });

    var days = [];
    for (var i = 0; i < 7; i++) {
      var dayStart = addDays(start, i);
      var dayEnd = addDays(start, i + 1);
      var status;
      if (dayStart > now) status = 'ahead';
      else if (dayEnd <= firstDayStart) status = 'before';
      else {
        var broken = !!slipDays[dayKey(dayStart)] || (input.off || []).some(function (iv) {
          return iv[0] < dayEnd && iv[1] > dayStart;
        });
        status = broken ? 'broken' : 'kept';
      }
      days.push({ start: dayStart, status: status, events: [] });
    }
    events.forEach(function (e) {
      var index = Math.floor((startOfDay(e.at) - start) / DAY + 0.5);
      e.day = Math.max(0, Math.min(6, index));
      days[e.day].events.push(e);
    });

    var count = function (type) { return events.filter(function (e) { return e.type === type; }).length; };
    var counted = days.filter(function (d) { return d.status === 'kept' || d.status === 'broken'; }).length;
    return {
      start: start,
      days: days,
      events: events,
      stops: count('stop'),
      kept: count('kept'),
      slips: count('slip'),
      daysKept: days.filter(function (d) { return d.status === 'kept'; }).length,
      daysCounted: counted
    };
  }

  // --- Risk hours as minutes ---------------------------------------------------

  function riskMinutes(risk) {
    var set = {};
    if (!risk || !risk.enabled) return set;
    for (var m = risk.start; m !== risk.end; m = (m + 1) % 1440) set[m] = true;
    return set;
  }

  function covers(next, prev) {
    var after = riskMinutes(next);
    return Object.keys(riskMinutes(prev)).every(function (m) { return after[m]; });
  }

  function windowLength(risk) {
    return (risk.end - risk.start + 1440) % 1440;
  }

  function defaultFormat(minutes) {
    var d = new Date(2026, 0, 1, Math.floor(minutes / 60), minutes % 60);
    try {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: minutes % 60 ? '2-digit' : undefined });
    } catch (_) {
      return String(Math.floor(minutes / 60)) + ':' + String(minutes % 60).padStart(2, '0');
    }
  }

  // --- The words ------------------------------------------------------------------

  // opts: { partial, risk (normalized), gatewaysOn: [ids], names: { id: name },
  //   format: minutes -> '10:30 PM' }
  function tell(week, opts) {
    var o = opts || {};
    var fmt = o.format || defaultFormat;
    var weekday = function (ms) {
      return new Date(ms).toLocaleDateString([], { weekday: 'long' });
    };
    var S = week.stops;
    var K = week.kept;
    var L = week.slips;
    var so = o.partial ? ' so far' : '';

    var headline;
    if (S >= 2) headline = cap(word(S)) + ' times at the door. ' + cap(word(S)) + ' times you turned back.';
    else if (S === 1) headline = 'Once at the door, and you turned back.';
    else if (K >= 2) headline = cap(word(K)) + ' hard moments, and you waited out every one.';
    else if (K === 1) headline = 'One hard moment, and you waited it out.';
    else if (L === 0) headline = 'A quiet week' + so + '.';
    else headline = 'A hard week' + so + '.';

    var lede;
    var slips = week.events.filter(function (e) { return e.type === 'slip'; });
    var allKept = week.daysKept === week.daysCounted;
    if (L === 1) {
      var slip = slips[0];
      var after = week.events.filter(function (e) { return e.at > slip.at && e.type !== 'slip'; })[0];
      if (after) {
        var before = week.events.some(function (e) { return e.at < slip.at && e.type === after.type; });
        var verb = (after.type === 'stop' ? 'stopped at the door' : 'waited it out') + (before ? ' again.' : '.');
        lede = dayKey(after.at) === dayKey(slip.at)
          ? cap(weekday(slip.at)) + ' was hard. Later that day you ' + verb
          : cap(weekday(slip.at)) + ' was hard. You came back, and on ' + weekday(after.at) + ' you ' + verb;
      } else {
        lede = cap(weekday(slip.at)) + ' was hard. A slip costs a day, not the count.';
      }
    } else if (L > 1) {
      lede = cap(word(L)) + ' hard days. A slip costs a day, not the count, and you’re still here.';
    } else if (S + K > 0) {
      lede = allKept
        ? 'No slips. Every time it got hard, you turned back.'
        : 'No slips. ' + week.daysKept + ' of ' + week.daysCounted + ' days kept; protection was off for part of the rest.';
    } else {
      lede = allKept
        ? 'Protection was on every day' + so + ', and nothing pulled hard enough to count.'
        : week.daysKept + ' of ' + week.daysCounted + ' days kept; protection was off for part of the rest.';
    }

    var good = L === 0 || (S + K > 0 && week.daysKept >= week.daysCounted - 1);
    var closing;
    if (o.partial) closing = good ? 'So far, so good. Thank you for showing up.' : 'Thank you for still being here.';
    else if (L === 0 && S + K === 0) closing = 'A quiet week. Thank you for keeping it that way.';
    else closing = good ? 'A good week. Thank you for showing up for it.' : 'Not an easy week. Thank you for still being here.';

    return { headline: headline, lede: lede, closing: closing, suggestion: suggest(week, o, fmt) };
  }

  // One thing to try, from the week itself. First the hour it gets hard, as
  // risk hours (only ever widening them); then a slip's starting place, as a
  // gateway. Nothing when the week gives no reason.
  function suggest(week, o, fmt) {
    var times = week.events;
    if (times.length >= 3) {
      var byHour = [];
      for (var h = 0; h < 24; h++) byHour.push(0);
      times.forEach(function (e) { byHour[new Date(e.at).getHours()] += 1; });
      // Scan from noon, so an evening hour wins a tie over the small hours.
      var hard = 12;
      for (var i = 1; i < 24; i++) {
        var hr = (12 + i) % 24;
        if (byHour[hr] > byHour[hard]) hard = hr;
      }
      var inWindow = byHour[hard] + byHour[(hard + 1) % 24];
      if (inWindow >= 3 && inWindow * 2 >= times.length) {
        var startAt = (hard * 60 - 30 + 1440) % 1440;
        var risk = o.risk || { enabled: false, start: 23 * 60, end: 2 * 60 };
        var next = risk.enabled
          ? { enabled: true, start: startAt, end: risk.end }
          : { enabled: true, start: startAt, end: ((hard + 3) % 24) * 60 };
        var already = risk.enabled && riskMinutes(risk)[startAt] && riskMinutes(risk)[(hard * 60 + 119) % 1440];
        if (!already && covers(next, risk) && windowLength(next) <= 8 * 60) {
          var between = 'between ' + fmt(hard * 60) + ' and ' + fmt(((hard + 2) % 24) * 60);
          return {
            kind: 'risk',
            risk: next,
            text: cap(word(inWindow)) + ' of your ' + word(times.length) + ' hard moments came ' + between + '. ' +
              (risk.enabled
                ? 'Start your risk hours at ' + fmt(startAt) + ', before it begins.'
                : 'Make ' + fmt(startAt) + ' to ' + fmt(next.end) + ' your risk hours: stronger protection every day around then.'),
            label: risk.enabled ? 'Start risk hours at ' + fmt(startAt) : 'Set risk hours'
          };
        }
      }
    }
    var on = o.gatewaysOn || [];
    var names = o.names || {};
    var slip = week.events.filter(function (e) {
      return e.type === 'slip' && e.start && e.start !== 'other' && names[e.start] && on.indexOf(e.start) < 0;
    })[0];
    if (slip) {
      return {
        kind: 'gateway',
        id: slip.start,
        text: 'A slip this week started at ' + names[slip.start] + '. Make it a gateway: a pause before it opens, and closed in your hard hours.',
        label: 'Add gateway'
      };
    }
    return null;
  }

  var exported = {
    SEEN_KEY: SEEN_KEY,
    READY_HOUR: READY_HOUR,
    WEEKS_BACK: WEEKS_BACK,
    word: word,
    MONDAY: MONDAY,
    dayKey: dayKey,
    parseKey: parseKey,
    addDays: addDays,
    weekStart: weekStart,
    readyAt: readyAt,
    latestReady: latestReady,
    range: range,
    hasNew: hasNew,
    collect: collect,
    covers: covers,
    tell: tell
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Weekly = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
