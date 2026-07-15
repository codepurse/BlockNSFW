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
    return DOMAIN_REGEX.test(domain) ? domain : null;
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
