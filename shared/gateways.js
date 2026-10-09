// Gateways: the sites where it tends to start.
//
// Most slips don't begin at a porn site. They begin somewhere ordinary: an
// Explore page, a subreddit, image search, late at night. The user names those
// sites. Opening one shows a pause first (gateway.html): ten seconds, their own
// words, and a choice, Not tonight or Go on. During Risk Hours and Storm Mode a
// gateway is closed outright.
//
// This module is the shared part: the built-in gateways (all off until chosen),
// matching an address against what the user turned on, the short pass Go on
// grants, and the count of times someone chose Not tonight. Plain data in,
// plain data out, so it runs in the content script, the extension pages and
// node tests alike.

(function (root) {
  'use strict';

  var PASS_KEY = 'pblocker_gateway_pass';     // storage.local: { [key]: expiresAt }
  var STOPS_KEY = 'pblocker_gateway_stops';   // storage.local: see normalizeStops
  var PAUSES = [5, 10, 30, 60];               // seconds
  var DEFAULT_PAUSE = 10;
  // After Go on, the site stays open this long before the pause comes back.
  // Long enough to use it, short enough that a slide later in the evening
  // meets the pause again.
  var PASS_MS = 15 * 60 * 1000;
  var MAX_CUSTOM = 50;
  // Recent stops are kept with their time: the page after Not tonight draws
  // the last few, and Your week (shared/weekly.js) draws this week's and
  // compares them with the week before. Five weeks covers both.
  var RECENT_MAX = 200;
  var RECENT_MS = 35 * 24 * 60 * 60 * 1000;

  // Built-in gateways. Every one is off until the user turns it on.
  var BUILT_IN = [
    { id: 'instagram-explore', name: 'Instagram Explore', where: 'instagram.com/explore' },
    { id: 'reddit', name: 'Reddit', where: 'reddit.com' },
    { id: 'image-search', name: 'Image search', where: 'Google, Bing and DuckDuckGo images' },
    { id: 'x-search', name: 'X search and Explore', where: 'x.com/search and x.com/explore' },
    { id: 'tiktok', name: 'TikTok', where: 'tiktok.com' },
    { id: 'youtube-shorts', name: 'YouTube Shorts', where: 'youtube.com/shorts' }
  ];
  var IDS = BUILT_IN.map(function (g) { return g.id; });

  function parse(href) {
    try { return new URL(href); } catch (_) { return null; }
  }

  // "www.reddit.com" and "old.reddit.com" are reddit.com; "notreddit.com" isn't.
  function hostIs(host, domain) {
    return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
  }

  function pathStarts(path, prefix) {
    var p = String(path || '/').toLowerCase();
    return p === prefix || p.indexOf(prefix + '/') === 0 || p.indexOf(prefix + '?') === 0;
  }

  // The image tabs of the search engines. Videos are left out: a video tab is
  // rarely where it starts, and someone may need one.
  function isImageSearch(url) {
    var host = url.hostname.toLowerCase();
    var path = url.pathname;
    var params = url.searchParams;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && path.indexOf('/search') === 0) {
      return params.get('tbm') === 'isch' || params.get('udm') === '2';
    }
    if (hostIs(host, 'bing.com')) return path.indexOf('/images') === 0;
    if (hostIs(host, 'duckduckgo.com')) return params.get('ia') === 'images' || params.get('iax') === 'images';
    if (/(^|\.)yandex\.[a-z.]+$/.test(host)) return path.indexOf('/images') === 0;
    if (host === 'search.brave.com' || host === 'safe.search.brave.com') return path.indexOf('/images') === 0;
    return host.indexOf('images.search.yahoo.') === 0;
  }

  var MATCHERS = {
    'instagram-explore': function (u, host) { return hostIs(host, 'instagram.com') && pathStarts(u.pathname, '/explore'); },
    'reddit': function (u, host) { return hostIs(host, 'reddit.com'); },
    'image-search': function (u) { return isImageSearch(u); },
    'x-search': function (u, host) {
      return (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) &&
        (pathStarts(u.pathname, '/search') || pathStarts(u.pathname, '/explore'));
    },
    'tiktok': function (u, host) { return hostIs(host, 'tiktok.com'); },
    'youtube-shorts': function (u, host) { return hostIs(host, 'youtube.com') && pathStarts(u.pathname, '/shorts'); }
  };

  // The site each gateway lives on, whatever the path. A page on one of these
  // can move into the gateway without loading a new page (Instagram reaches
  // Explore with pushState), so the content script keeps watching its address.
  function isSearchHost(host) {
    return /(^|\.)google\.[a-z.]+$/.test(host) || hostIs(host, 'bing.com') || hostIs(host, 'duckduckgo.com') ||
      /(^|\.)yandex\.[a-z.]+$/.test(host) || host === 'search.brave.com' || host === 'safe.search.brave.com' ||
      host.indexOf('images.search.yahoo.') === 0;
  }
  var SITES = {
    'instagram-explore': function (host) { return hostIs(host, 'instagram.com'); },
    'reddit': function (host) { return hostIs(host, 'reddit.com'); },
    'image-search': isSearchHost,
    'x-search': function (host) { return hostIs(host, 'x.com') || hostIs(host, 'twitter.com'); },
    'tiktok': function (host) { return hostIs(host, 'tiktok.com'); },
    'youtube-shorts': function (host) { return hostIs(host, 'youtube.com'); }
  };

  // A site the user typed: "site.com" for the whole site, "site.com/path" for
  // one part of it. Returns the stored form, lower case, without scheme or
  // "www.", or null when it isn't a site.
  function normalizeCustom(input) {
    var s = String(input == null ? '' : input).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[?#].*$/, '');
    var slash = s.indexOf('/');
    var host = slash < 0 ? s : s.slice(0, slash);
    var path = slash < 0 ? '' : s.slice(slash).replace(/\/+$/, '');
    host = host.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host)) return null;
    if (path && !/^\/[^\s]*$/.test(path)) return null;
    return host + path;
  }

  function matchCustom(url, entry) {
    var slash = entry.indexOf('/');
    var host = slash < 0 ? entry : entry.slice(0, slash);
    var path = slash < 0 ? '' : entry.slice(slash);
    if (!hostIs(url.hostname.toLowerCase(), host)) return false;
    return !path || pathStarts(url.pathname, path);
  }

  function normalizePause(seconds) {
    var n = Number(seconds);
    return PAUSES.indexOf(n) >= 0 ? n : DEFAULT_PAUSE;
  }

  // What the user turned on, from the settings object.
  function normalizeSettings(settings) {
    var s = settings && typeof settings === 'object' ? settings : {};
    var on = (Array.isArray(s.gateways) ? s.gateways : []).filter(function (id, i, all) {
      return IDS.indexOf(id) >= 0 && all.indexOf(id) === i;
    });
    var custom = [];
    (Array.isArray(s.gatewaysCustom) ? s.gatewaysCustom : []).forEach(function (raw) {
      var entry = normalizeCustom(raw);
      if (entry && custom.indexOf(entry) < 0 && custom.length < MAX_CUSTOM) custom.push(entry);
    });
    return { on: on, custom: custom, pause: normalizePause(s.gatewayPauseSeconds) };
  }

  function count(settings) {
    var g = normalizeSettings(settings);
    return g.on.length + g.custom.length;
  }

  // The gateway an address belongs to, or null. The key is a built-in id, or
  // "custom:" and the entry, and is what passes and stops are counted under.
  function match(href, settings) {
    var url = parse(href);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    var g = normalizeSettings(settings);
    var host = url.hostname.toLowerCase();
    for (var i = 0; i < g.on.length; i++) {
      if (MATCHERS[g.on[i]](url, host)) return { key: g.on[i], name: nameFor(g.on[i]) };
    }
    for (var j = 0; j < g.custom.length; j++) {
      if (matchCustom(url, g.custom[j])) return { key: 'custom:' + g.custom[j], name: g.custom[j] };
    }
    return null;
  }

  // Whether an address is on a site where one of the user's gateways lives.
  function onGatewaySite(href, settings) {
    var url = parse(href);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
    var g = normalizeSettings(settings);
    var host = url.hostname.toLowerCase();
    return g.on.some(function (id) { return SITES[id](host); }) ||
      g.custom.some(function (entry) { return hostIs(host, entry.split('/')[0]); });
  }

  function nameFor(key) {
    var k = String(key || '');
    if (k.indexOf('custom:') === 0) return normalizeCustom(k.slice(7)) || 'this site';
    for (var i = 0; i < BUILT_IN.length; i++) if (BUILT_IN[i].id === k) return BUILT_IN[i].name;
    return 'this site';
  }

  // --- Go on: a short pass ------------------------------------------------------

  function normalizePasses(raw, now) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (key) {
      var until = Number(raw[key]);
      if (until > now && until <= now + PASS_MS) out[key] = until;
    });
    return out;
  }

  function passValid(raw, key, now) {
    return !!normalizePasses(raw, now)[key];
  }

  function addPass(raw, key, now) {
    var passes = normalizePasses(raw, now);
    passes[key] = now + PASS_MS;
    return passes;
  }

  // --- Not tonight: the count ----------------------------------------------------

  function normalizeStops(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var byKey = {};
    if (s.byKey && typeof s.byKey === 'object') {
      Object.keys(s.byKey).forEach(function (key) {
        var n = Math.floor(Number(s.byKey[key]));
        if (n > 0) byKey[key] = n;
      });
    }
    var byHour = [];
    for (var h = 0; h < 24; h++) {
      var v = Array.isArray(s.byHour) ? Math.floor(Number(s.byHour[h])) : 0;
      byHour.push(v > 0 ? v : 0);
    }
    var recent = (Array.isArray(s.recent) ? s.recent : []).filter(function (e) {
      return e && typeof e.key === 'string' && Number(e.at) > 0;
    }).map(function (e) {
      return { key: e.key.slice(0, 300), at: Number(e.at) };
    }).sort(function (a, b) { return a.at - b.at; }).slice(-RECENT_MAX);
    var total = Math.floor(Number(s.total));
    return { total: total > 0 ? total : 0, byKey: byKey, byHour: byHour, recent: recent };
  }

  function addStop(raw, key, at) {
    var s = normalizeStops(raw);
    s.total += 1;
    s.byKey[key] = (s.byKey[key] || 0) + 1;
    s.byHour[new Date(at).getHours()] += 1;
    s.recent = s.recent.concat([{ key: key, at: at }]).filter(function (e) {
      return e.at > at - RECENT_MS;
    }).slice(-RECENT_MAX);
    return s;
  }

  // The gateway stopped at most, and the hour it happens most, once there are
  // enough stops for that to mean something.
  function pattern(raw) {
    var s = normalizeStops(raw);
    if (s.total < 3) return null;
    var key = null;
    Object.keys(s.byKey).forEach(function (k) { if (key === null || s.byKey[k] > s.byKey[key]) key = k; });
    var hour = 0;
    for (var h = 1; h < 24; h++) if (s.byHour[h] > s.byHour[hour]) hour = h;
    return { key: key, name: nameFor(key), hour: hour };
  }

  var exported = {
    PASS_KEY: PASS_KEY,
    STOPS_KEY: STOPS_KEY,
    PAUSES: PAUSES,
    DEFAULT_PAUSE: DEFAULT_PAUSE,
    PASS_MS: PASS_MS,
    MAX_CUSTOM: MAX_CUSTOM,
    RECENT_MAX: RECENT_MAX,
    BUILT_IN: BUILT_IN,
    normalizeCustom: normalizeCustom,
    normalizePause: normalizePause,
    normalizeSettings: normalizeSettings,
    count: count,
    match: match,
    onGatewaySite: onGatewaySite,
    nameFor: nameFor,
    isImageSearch: function (href) { var u = parse(href); return !!u && isImageSearch(u); },
    passValid: passValid,
    addPass: addPass,
    normalizeStops: normalizeStops,
    addStop: addStop,
    pattern: pattern
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Gateways = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
