// shared/unsafe-search.js
// Search engines SafeSearch can't reach.
//
// SafeSearch is forced on the engines BlockNSFW knows how to force it on
// (background.js, buildSafeSearchRules; content.js for the cookie-backed ones),
// and their results are filtered on the page. There are hundreds of others, and
// forcing SafeSearch on each one isn't possible. On those, an image search
// shows thumbnails the engine serves itself, the results aren't filtered, and
// some open the sites they list on their own servers (Startpage's "Visit in
// Anonymous View" goes through *-browse.startpage.com/av/proxy, the real
// address encrypted), so neither the blocklist nor DNS ever sees the site. So
// these engines are blocked outright, and searching goes through one
// SafeSearch covers. The setting is unsafeSearchEnabled, on unless turned off,
// next to SafeSearch's in Settings.
//
// No list has every search engine. This one has the known ones, and finds
// SearXNG, which anyone can run on their own site, from its pages wherever it
// runs. Engines that are family-safe by design, such as Kiddle, KidzSearch and
// Swisscows, are left open.
//
// A rule names an engine and how to know it:
//   hosts      the engine's sites; each covers its subdomains. Alone, they
//              block the whole engine, before the page loads.
//   paths      optional: only these address paths ("/images" also covers
//              "/images/..."), for an engine that shares its site with
//              something else
//   params     optional: only addresses with these parameters
//              ({ cat: ['images'] })
//   generator  instead of hosts, for engines anyone can run on any host: what
//              the page's <meta name="generator"> starts with. Checked once the
//              page has loaded.
//   page       optional CSS selectors, one of which must be on the page, for a
//              rule known by its page
//
// The engines that ship are below. data/UNSAFE_SEARCH.json in the project's
// repository carries any added since; background.js downloads it and keeps the
// rules in storage under STORAGE_KEY. Downloaded rules can only add engines,
// carry nothing beyond plain hosts, paths, parameters and CSS selectors, and
// can never name an engine SafeSearch covers (PROTECTED), so a slip in that
// file can't block Google for everyone.
//
// Loaded as a classic script by the content script and with importScripts by
// the background, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var STORAGE_KEY = 'pblocker_unsafe_search_v1';

  // Startpage, Mojeek and SearXNG were checked live on 2026-10-29; the rest
  // are named by their published addresses.
  var ENGINES = [
    { name: 'Startpage', hosts: ['startpage.com', 'ixquick.com'] },
    { name: 'Mojeek', hosts: ['mojeek.com'] },
    { name: 'Kagi', hosts: ['kagi.com'] },
    { name: 'Dogpile', hosts: ['dogpile.com'] },
    { name: 'MetaGer', hosts: ['metager.org', 'metager.de'] },
    { name: 'Gibiru', hosts: ['gibiru.com'] },
    { name: 'Yep', hosts: ['yep.com'] },
    { name: 'Petal Search', hosts: ['petalsearch.com'] },
    { name: 'Ghostery Private Search', hosts: ['ghosterysearch.com'] },
    { name: 'Ask', hosts: ['ask.com'] },
    { name: 'Lycos Search', hosts: ['search.lycos.com'] },
    {
      // Thousands of public instances, on any host. Every page carries
      // <meta name="generator" content="searxng/…"> (the older searx too).
      name: 'SearXNG',
      generator: 'searx'
    }
  ];

  // The engines SafeSearch covers. A downloaded rule naming one of them, or a
  // parent of one ("co.uk" is a parent of google.co.uk), is no rule at all.
  var PROTECTED_LABELS = ['google', 'bing', 'duckduckgo', 'yahoo', 'aol', 'brave', 'ecosia', 'qwant', 'presearch', 'yandex', 'youtube'];
  var PROTECTED_DOMAINS = [
    'google.com', 'google.co.uk', 'google.ca', 'google.com.au', 'google.co.in', 'google.co.jp',
    'bing.com', 'duckduckgo.com', 'search.brave.com', 'yahoo.com', 'aol.com', 'ecosia.org',
    'qwant.com', 'presearch.com', 'yandex.com', 'yandex.ru', 'youtube.com'
  ];

  function isProtectedHost(host) {
    var h = String(host || '').toLowerCase();
    var labels = h.split('.');
    for (var i = 0; i < labels.length; i++) {
      if (PROTECTED_LABELS.indexOf(labels[i]) !== -1) return true;
    }
    for (var j = 0; j < PROTECTED_DOMAINS.length; j++) {
      if (PROTECTED_DOMAINS[j].slice(-(h.length + 1)) === '.' + h) return true;
    }
    return false;
  }

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
   * rule makes it no rule at all rather than a broader one, and a rule naming
   * an engine SafeSearch covers is refused whole.
   */
  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '';
    if (!name) return null;
    var rule = { name: name };

    if (Array.isArray(raw.hosts)) {
      var protectedHost = raw.hosts.some(function (h) { return typeof h === 'string' && isProtectedHost(h.trim().replace(/^www\./i, '')); });
      if (protectedHost) return null;
    }
    var hosts = strings(raw.hosts, function (h) { return HOST_RE.test(h.toLowerCase()); });
    if (hosts) rule.hosts = hosts.map(function (h) { return h.toLowerCase().replace(/^www\./, ''); });
    if (typeof raw.generator === 'string' && NAME_RE.test(raw.generator.trim().toLowerCase())) {
      rule.generator = raw.generator.trim().toLowerCase();
    }

    var paths = strings(raw.paths, function (p) { return p.charAt(0) === '/' && !/[?#\s]/.test(p); });
    if (paths) rule.paths = paths.map(function (p) { return p.toLowerCase(); });

    // Every parameter has to match, so one that can't be read can't be
    // dropped: that would widen the rule.
    if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
      var params = {};
      var keys = Object.keys(raw.params);
      if (keys.length > MAX_LIST) return null;
      for (var i = 0; i < keys.length; i++) {
        var values = NAME_RE.test(keys[i].toLowerCase()) ? strings(raw.params[keys[i]], function () { return true; }) : null;
        if (!values) return null;
        params[keys[i]] = values.map(function (v) { return v.toLowerCase(); });
      }
      if (keys.length) rule.params = params;
    }

    var page = strings(raw.page, function () { return true; });
    if (page) rule.page = page;

    // Paths, parameters or selectors that were given but didn't survive would
    // leave a rule broader than it was written: the whole host. Drop it.
    var given = function (value) { return Array.isArray(value) ? value.length > 0 : !!(value && typeof value === 'object' && Object.keys(value).length); };
    if ((given(raw.paths) && !rule.paths) || (given(raw.params) && !rule.params) || (given(raw.page) && !rule.page)) return null;

    // A rule needs hosts, or a generator to know its pages by. Without them it
    // would apply to every site.
    return rule.hosts || rule.generator ? rule : null;
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

  /** The engine this address belongs to, known before the page loads, or null. */
  function matchAddress(address, rules) {
    var url = parseAddress(address);
    if (!url) return null;
    var host = siteHost(url);
    var path = url.pathname.toLowerCase();
    var list = Array.isArray(rules) ? rules : ENGINES;
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule.hosts || rule.page) continue;
      if (hostMatches(host, rule.hosts) && pathMatches(path, rule.paths) && paramsMatch(url.searchParams, rule.params)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * The engine this page belongs to, known only from the page, or null. `doc`
   * is the page's document; only querySelector is used.
   */
  function matchPage(doc, address, rules) {
    var url = parseAddress(address);
    if (!url || !doc || typeof doc.querySelector !== 'function') return null;
    var host = siteHost(url);
    var list = Array.isArray(rules) ? rules : ENGINES;
    var generator;
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (rule.hosts) {
        if (!rule.page || !hostMatches(host, rule.hosts)) continue;
      } else if (rule.generator) {
        if (generator === undefined) {
          var meta = query(doc, 'meta[name="generator"]');
          generator = meta && typeof meta.content === 'string' ? meta.content.trim().toLowerCase() : '';
        }
        if (generator.indexOf(rule.generator) !== 0) continue;
        if (!rule.page) return rule;
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
    isProtectedHost: isProtectedHost,
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
