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

  var exported = {
    DOMAIN_REGEX: DOMAIN_REGEX,
    validateDomain: validateDomain
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.DomainValidate = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
