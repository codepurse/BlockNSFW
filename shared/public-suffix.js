// shared/public-suffix.js
// Answers one question: is this name a public suffix — a namespace anyone can
// register under — rather than a site?
//
// WHY THIS EXISTS
//
// isUrlInDefaultBlocklist() decides a host is blocked if the host itself, or
// any parent of it, is on the list. That is right for `cdn.pornhub.com`
// matching `pornhub.com`. It is catastrophic when the "parent" is a namespace:
//
//   data/HOSTS.txt carried `www.blogspot.com`. normalizeDomainForCache()
//   strips `www.`, leaving `blogspot.com` — a public suffix — so the parent
//   walk matched EVERY Blogger blog on the internet, including Google's own.
//   `gob.mx`, listed bare, blocked every Mexican government site the same way.
//   Both were live in a shipped release.
//
// A hand-maintained list of CDN parents (SHARED_CDN_PARENT_DOMAINS) was the
// previous defence. It held 30 entries and neither of those two, which is the
// problem with hand-maintained lists of an open-ended set. This is the
// authoritative version of that set, and it also matters for the static
// declarativeNetRequest rules, where `requestDomains` matches sub-domains and
// one bad entry blocks a namespace at the network layer.
//
// Implements the matching rules from https://publicsuffix.org/list/:
//   - a rule matches if it equals the candidate, label for label
//   - `*.ck` matches any single label under `ck`
//   - `!www.ck` is an exception: that name is NOT a public suffix
//   - the longest matching rule wins, and an exception beats a wildcard

(function (root) {
  'use strict';

  /**
   * Parse the committed data/public-suffixes.txt into a lookup structure.
   * @param {string} text
   */
  function parseList(text) {
    var exact = new Set();
    var wildcard = new Set();   // parent of a `*.parent` rule
    var exception = new Set();  // name from a `!name` rule
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var rule = lines[i].trim();
      if (!rule || rule.charAt(0) === '#' || rule.slice(0, 2) === '//') continue;
      if (rule.charAt(0) === '!') {
        exception.add(rule.slice(1).toLowerCase());
      } else if (rule.slice(0, 2) === '*.') {
        wildcard.add(rule.slice(2).toLowerCase());
      } else {
        exact.add(rule.toLowerCase());
      }
    }
    return { exact: exact, wildcard: wildcard, exception: exception };
  }

  function normalize(name) {
    return String(name == null ? '' : name)
      .trim().toLowerCase().replace(/\.+$/, '');
  }

  /**
   * Is `name` itself a public suffix?
   *
   * Note this asks about the name as given — `blogspot.com` is a public
   * suffix, `foo.blogspot.com` is not (it is a registrable domain under one).
   *
   * @param {string} name
   * @param {{exact:Set,wildcard:Set,exception:Set}} list
   * @returns {boolean}
   */
  function isPublicSuffix(name, list, options) {
    var host = normalize(name);
    if (!host || !list) return false;
    // An exception rule names something that would otherwise be a suffix.
    if (list.exception.has(host)) return false;
    if (list.exact.has(host)) return true;
    // `*.parent` makes any single label under `parent` a suffix.
    //
    // Callers guarding parent-domain matching pass wildcards:false, because a
    // wildcard rule cannot distinguish a namespace from a site. `*.mm` covers
    // Myanmar, so the PSL calls `milffuck.mm` a public suffix — it is an adult
    // site, and treating it as a namespace would stop it being blocked at all.
    // The registries with wildcard rules are small, so the cost of ignoring
    // them here is far lower than the cost of failing to block their sites.
    // Named rules like `blogspot.com` and `gob.mx`, which are the ones that
    // actually caused damage, are all exact.
    var allowWildcards = !options || options.wildcards !== false;
    if (!allowWildcards) return false;
    var dot = host.indexOf('.');
    if (dot !== -1 && list.wildcard.has(host.slice(dot + 1))) return true;
    return false;
  }

  /**
   * The subset of `domains` that are public suffixes.
   *
   * This is how the runtime uses the list: the blocklist is intersected with
   * it once per load, giving a small set (a couple of hundred entries against
   * a 200k list) that the per-request parent walk can consult cheaply. Doing
   * it this way means a bad entry arriving in a remote list refresh is caught
   * within the refresh interval, without waiting for a release.
   *
   * @param {Iterable<string>} domains
   * @param {{exact:Set,wildcard:Set,exception:Set}} list
   * @returns {Set<string>}
   */
  function publicSuffixesAmong(domains, list, options) {
    var found = new Set();
    if (!domains || !list) return found;
    // Wildcard-derived suffixes are excluded by default here: this feeds the
    // parent-match guard, where treating an adult site under a wildcard TLD as
    // a namespace would stop it being blocked. See isPublicSuffix.
    var opts = options || { wildcards: false };
    var iterator = domains[Symbol.iterator] ? domains : [];
    for (var domain of iterator) {
      var host = normalize(domain);
      if (host && isPublicSuffix(host, list, opts)) found.add(host);
    }
    return found;
  }

  var exported = {
    parseList: parseList,
    isPublicSuffix: isPublicSuffix,
    publicSuffixesAmong: publicSuffixesAmong
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.PublicSuffix = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
