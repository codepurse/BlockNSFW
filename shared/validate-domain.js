// shared/validate-domain.js
// Single source of truth for validating + normalizing a domain typed into the
// whitelist inputs (popup + options page). Previously both pages carried their
// own copy of this regex, and that regex only accepted a single "label.tld"
// form — so any domain with a subdomain or a multi-part TLD was rejected:
//
//   example.com              -> accepted
//   bintv-nett.blogspot.com  -> REJECTED (subdomain)   <-- bug report #5
//   example.co.uk            -> REJECTED (multi-part TLD)
//   sub.domain.example.org   -> REJECTED (subdomain)
//
// Users hit "Please enter a valid domain" no matter what they typed, so they
// could never whitelist a false-positive page that lived on a subdomain.
//
// Loaded as a classic <script> in popup.html / options.html before their main
// script, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  // A domain is one or more DNS labels joined by dots, ending in a letters-only
  // TLD. Each label: 1-63 chars, alphanumeric, hyphens allowed only in the
  // middle (no leading/trailing hyphen). The leading lookahead caps the whole
  // name at the 253-char DNS limit.
  var DOMAIN_REGEX =
    /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

  // Loopback and private addresses are whitelistable too. `localhost` and a
  // bare IP are the two shapes DOMAIN_REGEX cannot express -- it requires a dot
  // and a letters-only TLD -- so someone trying to allow their own dev server
  // got "Please enter a valid domain" whatever they typed, with no accepted
  // spelling at all. That mattered because the page-level heuristics did block
  // localhost, leaving no way out of it.
  //
  // Only these two shapes are added, NOT bare labels in general: a whitelist
  // entry covers its subdomains, so accepting "com" would quietly allow every
  // .com domain there is. `localhost` carries no such risk (RFC 6761 reserves
  // the whole subtree) and an IP literal has no subdomains.
  var LOCALHOST_REGEX =
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/;
  var IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  function isIpv4Address(value) {
    var m = String(value).match(IPV4_REGEX);
    if (!m) return false;
    for (var i = 1; i <= 4; i++) {
      // A leading zero means someone typed an octal-looking octet; refuse it
      // rather than guess which of the two readings they meant.
      if (m[i].length > 1 && m[i].charAt(0) === '0') return false;
      if (+m[i] > 255) return false;
    }
    return true;
  }

  // Normalize a user-entered string to a bare hostname, then validate it.
  // Returns the cleaned domain (lowercased, no scheme / www. / path / trailing
  // dot) on success, or null if it is not a well-formed domain.
  function validateDomain(domain) {
    if (typeof domain !== 'string') return null;
    domain = domain.trim().toLowerCase();
    domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    domain = domain.split('/')[0];   // drop any path
    domain = domain.split(':')[0];   // drop any port
    domain = domain.replace(/\.$/, ''); // drop trailing dot (FQDN form)
    if (LOCALHOST_REGEX.test(domain) || isIpv4Address(domain)) return domain;
    return DOMAIN_REGEX.test(domain) ? domain : null;
  }

  // --- Blocklist host entries -------------------------------------------------
  // A blocklist host may be written with a leading dot — ".xyz", ".example.com".
  // That is how a whole TLD reads naturally, how hosts files and uBlock write an
  // "and its subdomains" rule, and what anyone typing a TLD reaches for first.
  //
  // It means exactly what the bare form already means here, because a bare host
  // entry covers its subdomains: "example.com" matches sub.example.com, and by
  // the same rule "xyz" matches spam.xyz. Written with the dot, though, the
  // entry used to match *nothing*, silently, on both the navigation and the
  // in-page path — and reached the image-blocking rule as the literal domain
  // ".xyz", which is not a domain at all.
  //
  // The three layers that read these entries — the content script, the
  // navigation matcher and the image rule — have to agree, so the rule lives
  // here rather than three times over.
  function normalizeBlockHost(value) {
    if (typeof value !== 'string') return '';
    var host = value.trim().toLowerCase();
    host = host.replace(/^\.+/, '');  // ".xyz" and "xyz" are the same entry
    host = host.replace(/\.+$/, '');  // trailing dot: the FQDN form
    return host;
  }

  /**
   * True when an entry names a whole top-level domain rather than a site — one
   * label, no dot, e.g. "xyz" or ".tk". These are deliberately broad, so the
   * places that need to treat them differently (the image rule, and any wording
   * shown to the user) can ask.
   */
  function isTldEntry(value) {
    var host = normalizeBlockHost(value);
    return !!host && !host.includes('.') && /^[a-z0-9-]+$/.test(host);
  }

  // --- Blocklist site entries -------------------------------------------------
  // What a site entry on the blocklist covers. The navigation matcher
  // (background.js), the in-page check (content.js), the image rule and the
  // popup all read entries through parseSiteEntry, so a site can't block on
  // one and not the other. They used to carry a copy each, and the copies had
  // drifted: the in-page check ignored a path, so "google.com/search" held
  // Gmail and Classroom once they loaded, while the navigation matcher missed
  // "/search?q=…" and so held no search at all.
  //
  //   - The host covers its subdomains, written bare, as "*.example.com" or as
  //     ".example.com".
  //   - "www." makes no difference: "www.example.com" is example.com. It's
  //     typed out of habit, and reading it narrowly would open example.com to
  //     everyone who did.
  //   - A path blocks only that part of the site and what's below it:
  //     "google.com/search" holds searches, "reddit.com/r/example" one
  //     subreddit. A path of "/" or "/*" is the whole site.
  //   - A scheme is ignored, so an address pasted from the address bar works.

  // A /regex/ or title/…/ entry. Those are KeywordPattern's, not sites.
  var PATTERN_ENTRY_RE = /^\s*(title\s*)?\/.*\/[a-z]*\s*$/i;

  /**
   * The site a blocklist entry names: { host, path, wholeSite }, or null for
   * anything that is not a site entry (a note, a /regex/, a title/…/ rule, or
   * a line with no host).
   */
  function parseSiteEntry(entry) {
    if (typeof entry !== 'string') return null;
    var text = entry.trim();
    if (!text || text.charAt(0) === '#' || text.charAt(0) === '!') return null;
    if (PATTERN_ENTRY_RE.test(text)) return null;
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    var slash = text.indexOf('/');
    var host = normalizeBlockHost(slash >= 0 ? text.slice(0, slash) : text);
    if (host.indexOf('*.') === 0) host = host.slice(2);
    host = host.replace(/^\.+/, '').replace(/^www\.(?=.)/, '');
    if (!host) return null;
    var path = slash >= 0 ? text.slice(slash) : '';
    return { host: host, path: path, wholeSite: path === '' || path === '/' || path === '/*' };
  }

  // A user's glob as regex source: metacharacters become literals, and `*`
  // and `?` stand for any run of / any one of `any`.
  function globSource(text, any) {
    return String(text)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/[*?]/g, function (c) { return c === '*' ? any + '*' : any; });
  }

  /**
   * The matcher for a site entry, tested against a whole http(s) address, or
   * null for anything that is not a site entry.
   */
  function siteEntryRegex(entry) {
    var site = parseSiteEntry(entry);
    if (!site) return null;
    // A wildcard in the host stops at the end of the host. It used to run on
    // into the path, so "*.xxx" held any page whose path ended in "a.xxx".
    var source = '^https?://(?:[^/?#@]*@)?(?:[^/?#@]*\\.)?' + globSource(site.host, '[^/?#]') + '(?::\\d+)?';
    if (site.wholeSite) {
      source += '(?:[/?#].*)?$';
    } else {
      // What's below the path is covered, but only from a boundary: "/adult"
      // holds "/adult/x" and "/adult?page=2", not "/adulting".
      var last = site.path.charAt(site.path.length - 1);
      source += globSource(site.path, '.') + (last === '/' || last === '*' ? '.*$' : '(?:[/?#].*)?$');
    }
    try {
      return new RegExp(source, 'i');
    } catch (_) {
      return null;
    }
  }

  /**
   * Whether an entry in the list blocks this host's whole site: the host
   * itself, a parent, or either written with "www.". An entry with a path
   * covers only part of it, so it doesn't count.
   */
  function blocksWholeSite(list, host) {
    var home = 'https://' + String(host || '').toLowerCase() + '/';
    var entries = Array.isArray(list) ? list : [];
    for (var i = 0; i < entries.length; i++) {
      var site = parseSiteEntry(entries[i]);
      if (!site || !site.wholeSite) continue;
      var regex = siteEntryRegex(entries[i]);
      if (regex && regex.test(home)) return true;
    }
    return false;
  }

  /** Whether a site entry in the list holds this address. */
  function blocksAddress(list, address) {
    var entries = Array.isArray(list) ? list : [];
    for (var i = 0; i < entries.length; i++) {
      var regex = siteEntryRegex(entries[i]);
      if (regex && regex.test(address)) return true;
    }
    return false;
  }

  // --- Sites that hold other things people need -------------------------------
  // A few sites keep things nobody means to block under the same name as the
  // part they want gone. A student blocked google.com to stop searching and
  // lost Gmail and Google Classroom with it. The popup's Block button and the
  // Block box beside search results say so before adding one of these, and
  // name the entry that blocks only its searches.
  var SHARED_SITES = [
    {
      host: 'google.com',
      name: 'Google',
      also: 'Gmail, Google Classroom, Docs, Drive and Meet',
      search: 'google.com/search',
      searchExample: 'https://www.google.com/search?q=example'
    },
    {
      host: 'yahoo.com',
      name: 'Yahoo',
      also: 'Yahoo Mail',
      search: 'search.yahoo.com',
      searchExample: 'https://search.yahoo.com/search?p=example'
    }
  ];

  /** The shared site this host is (itself or "www.", not a subdomain), or null. */
  function sharedSite(host) {
    var h = normalizeBlockHost(String(host || '')).replace(/^www\./, '');
    for (var i = 0; i < SHARED_SITES.length; i++) {
      if (SHARED_SITES[i].host === h) return SHARED_SITES[i];
    }
    return null;
  }

  /**
   * The entries in a list that block only part of a site, as written, leaving
   * out any whose whole site another entry in the list already blocks.
   */
  function partialSiteEntries(list) {
    var entries = Array.isArray(list) ? list : [];
    var partial = [];
    for (var i = 0; i < entries.length; i++) {
      var site = parseSiteEntry(entries[i]);
      if (site && !site.wholeSite && !blocksWholeSite(entries, site.host)) partial.push(entries[i].trim());
    }
    return partial;
  }

  // --- Path-scoped whitelist support ------------------------------------------
  // A whitelist entry may carry an optional `path` so the user can allow just a
  // section of an otherwise-blocked site (e.g. reddit.com/r/NoFap without
  // unblocking all of reddit.com). Paths are stored lowercased, with a leading
  // AND trailing slash, so prefix matching respects path-segment boundaries:
  // "/r/nofap/" must not match "/r/nofapville". Case-insensitive to match the
  // routing of the sites this targets (Reddit subreddits, most forums).

  // Return a canonical form of a path ("/r/NoFap" -> "/r/nofap/") or null when
  // the path is empty or the site root (meaning "no path scope": whole domain).
  function normalizeWhitelistPath(path) {
    if (typeof path !== 'string') return null;
    var s = path.trim().toLowerCase();
    // Strip query string / fragment — we only scope on the path.
    s = s.split('#')[0].split('?')[0];
    if (!s || s === '/') return null;
    if (s.charAt(0) !== '/') s = '/' + s;
    if (s.charAt(s.length - 1) !== '/') s += '/';
    return s;
  }

  // Does a page's pathname fall under a stored whitelist path scope?
  // A null/absent storedPath means the entry is whole-domain -> always allowed
  // (host is checked separately by the caller).
  function whitelistPathMatches(urlPathname, storedPath) {
    var target = normalizeWhitelistPath(storedPath);
    if (!target) return true; // whole-domain entry
    var current = normalizeWhitelistPath(urlPathname) || '/';
    return current.indexOf(target) === 0;
  }

  // Parse a user-typed whitelist entry that may include a path, e.g.
  //   "reddit.com"                     -> { domain: "reddit.com", path: null }
  //   "old.reddit.com/r/NoFap/"        -> { domain: "old.reddit.com", path: "/r/nofap/" }
  //   "https://reddit.com/r/NoFap"     -> { domain: "reddit.com", path: "/r/nofap/" }
  // Returns null when the host part is not a valid domain.
  function parseWhitelistInput(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (!trimmed) return null;
    var domain = validateDomain(trimmed);
    if (!domain) return null;
    // Isolate the path portion (everything from the first "/" after the host).
    var work = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    var slash = work.indexOf('/');
    var path = slash >= 0 ? normalizeWhitelistPath(work.slice(slash)) : null;
    return { domain: domain, path: path };
  }

  var exported = {
    DOMAIN_REGEX: DOMAIN_REGEX,
    validateDomain: validateDomain,
    normalizeBlockHost: normalizeBlockHost,
    isTldEntry: isTldEntry,
    parseSiteEntry: parseSiteEntry,
    siteEntryRegex: siteEntryRegex,
    blocksWholeSite: blocksWholeSite,
    blocksAddress: blocksAddress,
    SHARED_SITES: SHARED_SITES,
    sharedSite: sharedSite,
    partialSiteEntries: partialSiteEntries,
    normalizeWhitelistPath: normalizeWhitelistPath,
    whitelistPathMatches: whitelistPathMatches,
    parseWhitelistInput: parseWhitelistInput
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.DomainValidate = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
