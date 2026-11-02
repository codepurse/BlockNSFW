// BlockNSFW — Christmas: when it shows, and whether the person wants it.
//
// It shows from 1 December to 1 January, by the computer's own clock, and is
// gone from 2 January without anyone touching it. Settings › Customization can
// turn it off; nothing kept means on. ui/christmas.js draws it; this file only
// decides, so the tests can ask it about any date.

(function (root) {
  'use strict';

  const KEY = 'pblocker_christmas';   // false: turned off in Settings

  function asDate(date) {
    return date && typeof date.getMonth === 'function' ? date : new Date();
  }

  /** 1 December to 1 January, both days included, in local time. */
  function inSeason(date) {
    const d = asDate(date);
    const month = d.getMonth();
    return month === 11 || (month === 0 && d.getDate() === 1);
  }

  /** What was kept for the switch: only false turns it off. */
  function wanted(value) {
    return value !== false;
  }

  function isOn(value, date) {
    return wanted(value) && inSeason(date);
  }

  /** The few words beside the wordmark in the popup. */
  function line(date) {
    const d = asDate(date);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    if (m === 0 && day === 1) return 'Happy New Year';
    if (m === 11 && day === 24) return 'Christmas Eve';
    if (m === 11 && day === 31) return 'New Year’s Eve';
    if (m === 11 && day > 24) return 'Merry Christmas';
    // Counted in calendar days, so a clock change in between can't make it 23.
    const days = Math.round((new Date(y, 11, 25) - new Date(y, m, day)) / 86400000);
    if (days > 1) return days + ' days to Christmas';
    return 'Merry Christmas';
  }

  root.Season = { KEY: KEY, inSeason: inSeason, wanted: wanted, isOn: isOn, line: line };
})(typeof window !== 'undefined' ? window : this);
