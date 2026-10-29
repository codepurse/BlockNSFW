// shared/unsafe-search.js
// Image and video search on engines SafeSearch can't reach.
//
// SafeSearch is forced on the engines BlockNSFW knows how to force it on
// (background.js, buildSafeSearchRules; content.js for the cookie-backed ones).
// Everywhere else an image search shows thumbnails the engine serves itself, so
// neither the blocklist nor DNS ever sees the adult site behind them. There are
// hundreds of engines and no list can name them all, so this holds what the
// danger is in, image and video search, rather than whole engines: a web
// search's results are only links, and the blocklist holds a bad one when it's
// opened. It is part of SafeSearch and goes off with it.
//
// A rule names an engine and how to know its image or video search:
//   hosts      the engine's sites; each covers its subdomains
//   paths      address paths that are image or video search ("/images" also
//              covers "/images/..."), and/or
//   params     address parameters that make it one ({ cat: ['images'] })
//   generator  instead of hosts, for engines anyone can run on any host
//              (SearXNG): what the page's <meta name="generator"> starts with
//   page       CSS selectors that mark an image or video results page, for an
//              engine whose address doesn't say (Startpage posts its search)
// A rule with paths or params is checked against the address before the page
// loads; one with page selectors is checked against the page once it has.
//
// The engines that ship are below. data/UNSAFE_SEARCH.json in the project's
// repository carries any added since; background.js downloads it and keeps the
// rules in storage under STORAGE_KEY. Downloaded rules can only add engines,
// and carry no patterns of any kind beyond plain paths and CSS selectors.
//
// Loaded as a classic script by the content script and with importScripts by
// the background, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var STORAGE_KEY = 'pblocker_unsafe_search_v1';

  // Checked live on 2026-10-29 unless marked otherwise.
  var ENGINES = [
    {
      // Images and Videos are forms that POST cat=images / cat=video to
      // /sp/search, so the address says nothing; links with ?cat= do say.
      // Its own family filter (qadf) can be switched off.
      name: 'Startpage',
      hosts: ['startpage.com'],
      paths: ['/sp/search', '/do/search', '/do/dsearch', '/do/asearch'],
      params: { cat: ['images', 'pics', 'video', 'videos'] },
      page: [
        'form#search input[name="cat"][value="images"]',
        'form#search input[name="cat"][value="video"]'
      ]
    },
    {
      name: 'Mojeek',
      hosts: ['mojeek.com'],
      paths: ['/images']
    },
    {
      // Needs an account, so not checked live: kagi.com/images?q=… and
      // kagi.com/videos?q=… are its documented addresses.
      name: 'Kagi',
      hosts: ['kagi.com'],
      paths: ['/images', '/videos']
    },
    {
      // Thousands of public instances, on any host. Every page carries
      // <meta name="generator" content="searxng/…">, image and video results
      // are article.category-images / .category-videos, and the search form
      // keeps the chosen category as a hidden category_images / category_videos
      // field, which holds a page whose results haven't arrived yet too.
      name: 'SearXNG',
      generator: 'searx',
      page: [
        'article.category-images',
        'article.category-videos',
        'input[type="hidden"][name="category_images"]',
        'input[type="hidden"][name="category_videos"]'
      ]
    }
  ];

  var MAX_RULES = 200;
  var MAX_LIST = 20;
  var MAX_TEXT = 200;
  var HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  var NAME_RE = /^[a-z0-9_-]+$/;

  function strings(value, test) {
    if (!Array.isArray(value)) return null;
    var out = [];
    for (var i = 0; i < value.length && out.length < MAX_LIST; i++) {
      var item = typeof value[i] === 'string' ? value[i].trim() : '';
      if (item && item.length <= MAX_TEXT && test(item)) out.push(item);
    }
    return out.length ? out : null;
  }

  /**
   * A rule as it may be used, or null. Anything unexpected in a downloaded
   * rule makes it no rule at all rather than a broader one.
   */
  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '';
    if (!name) return null;
    var rule = { name: name };

    var hosts = strings(raw.hosts, function (h) { return HOST_RE.test(h.toLowerCase()); });
    if (hosts) rule.hosts = hosts.map(function (h) { return h.toLowerCase().replace(/^www\./, ''); });
    if (typeof raw.generator === 'string' && NAME_RE.test(raw.generator.trim().toLowerCase())) {
      rule.generator = raw.generator.trim().toLowerCase();
    }

    var paths = strings(raw.paths, function (p) { return p.charAt(0) === '/' && !/[?#\s]/.test(p); });
    if (paths) rule.paths = paths.map(function (p) { return p.toLowerCase(); });

    if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
      var params = {};
      var keys = Object.keys(raw.params).slice(0, MAX_LIST);
      for (var i = 0; i < keys.length; i++) {
        if (!NAME_RE.test(keys[i].toLowerCase())) continue;
        var values = strings(raw.params[keys[i]], function () { return true; });
        if (values) params[keys[i]] = values.map(function (v) { return v.toLowerCase(); });
      }
      if (Object.keys(params).length) rule.params = params;
    }

    var page = strings(raw.page, function () { return true; });
    if (page) rule.page = page;

    // An address rule needs a host; a page rule needs a host or a generator.
    // Without them a rule would apply to every site there is.
    var byAddress = !!(rule.hosts && (rule.paths || rule.params));
    var byPage = !!(rule.page && (rule.hosts || rule.generator));
    return byAddress || byPage ? rule : null;
  }

  /**
   * The engines that ship, then any downloaded ones whose names they don't
   * already use. `stored` is what background.js keeps under STORAGE_KEY.
   */
  function rulesFrom(stored) {
    var rules = ENGINES.slice();
    var extra = stored && Array.isArray(stored.rules) ? stored.rules : [];
    var names = {};
    for (var i = 0; i < rules.length; i++) names[rules[i].name.toLowerCase()] = true;
    for (var j = 0; j < extra.length && rules.length < MAX_RULES; j++) {
      var rule = normalizeRule(extra[j]);
      if (!rule || names[rule.name.toLowerCase()]) continue;
      names[rule.name.toLowerCase()] = true;
      rules.push(rule);
    }
    return rules;
  }

  /** The rules in a downloaded data/UNSAFE_SEARCH.json, or null if it isn't one. */
  function parseRemote(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (!data || !Array.isArray(data.rules)) return null;
    var rules = [];
    for (var i = 0; i < data.rules.length && rules.length < MAX_RULES; i++) {
      var rule = normalizeRule(data.rules[i]);
      if (rule) rules.push(rule);
    }
    return rules;
  }

  function hostMatches(host, hosts) {
    if (!hosts) return false;
    for (var i = 0; i < hosts.length; i++) {
      if (host === hosts[i] || host.slice(-(hosts[i].length + 1)) === '.' + hosts[i]) return true;
    }
    return false;
  }

  function pathMatches(path, paths) {
    if (!paths) return true;
    for (var i = 0; i < paths.length; i++) {
      var base = paths[i].replace(/\/+$/, '');
      if (path === base || path.indexOf(base + '/') === 0) return true;
    }
    return false;
  }

  function paramsMatch(search, params) {
    if (!params) return true;
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      var value = search.get(keys[i]);
      if (value === null || params[keys[i]].indexOf(value.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function parseAddress(address) {
    try {
      var url = new URL(address);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function siteHost(url) {
    return url.hostname.toLowerCase().replace(/\.$/, '');
  }

  /** The rule whose image or video search this address is, or null. */
  function matchAddress(address, rules) {
    var url = parseAddress(address);
    if (!url) return null;
    var host = siteHost(url);
    var path = url.pathname.toLowerCase();
    var list = Array.isArray(rules) ? rules : ENGINES;
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule.hosts || !(rule.paths || rule.params)) continue;
      if (hostMatches(host, rule.hosts) && pathMatches(path, rule.paths) && paramsMatch(url.searchParams, rule.params)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * The rule whose image or video results this page shows, or null. `doc` is
   * the page's document; only querySelector is used.
   */
  function matchPage(doc, address, rules) {
    var url = parseAddress(address);
    if (!url || !doc || typeof doc.querySelector !== 'function') return null;
    var host = siteHost(url);
    var list = Array.isArray(rules) ? rules : ENGINES;
    var generator;
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule.page) continue;
      if (rule.hosts) {
        if (!hostMatches(host, rule.hosts)) continue;
      } else if (rule.generator) {
        if (generator === undefined) {
          var meta = query(doc, 'meta[name="generator"]');
          generator = meta && typeof meta.content === 'string' ? meta.content.trim().toLowerCase() : '';
        }
        if (generator.indexOf(rule.generator) !== 0) continue;
      } else {
        continue;
      }
      for (var j = 0; j < rule.page.length; j++) {
        if (query(doc, rule.page[j])) return rule;
      }
    }
    return null;
  }

  // A selector from a downloaded rule may not parse; that one simply matches
  // nothing.
  function query(doc, selector) {
    try {
      return doc.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  var exported = {
    STORAGE_KEY: STORAGE_KEY,
    ENGINES: ENGINES,
    normalizeRule: normalizeRule,
    rulesFrom: rulesFrom,
    parseRemote: parseRemote,
    matchAddress: matchAddress,
    matchPage: matchPage
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.UnsafeSearch = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
