// shared/domain-policy.js
// Two curated exceptions to parent-domain matching, in one place because the
// runtime lookup and the static-ruleset generator both need them and must not
// disagree. Getting this wrong in the generator is worse: `requestDomains`
// matches sub-domains at the network layer, where the user cannot see what
// happened or whitelist their way out of it.
//
// Background: `isUrlInDefaultBlocklist()` blocks a host if the host or any
// parent of it is on the list. That is correct for `cdn.pornhub.com` matching
// `pornhub.com`, and catastrophic when the parent is a namespace anyone can
// register under. `www.blogspot.com` in data/HOSTS.txt became `blogspot.com`
// after www-stripping, and blocked every Blogger blog; `gob.mx` blocked every
// Mexican government site. Both shipped.
//
// shared/public-suffix.js is the general fix. These two lists are what it
// cannot know on its own.

(function (root) {
  'use strict';

  // Multi-tenant hosts whose children must never be blocked by a parent entry.
  //
  // Fifteen of these are in the Public Suffix List too (github.io, pages.dev,
  // vercel.app, netlify.app, herokuapp.com, r2.dev, cloudfront.net, the akamai
  // and azure names, googleapis.com…). That overlap is DELIBERATE and must not
  // be trimmed: the PSL is fetched at runtime, and when that fetch fails the
  // guard degrades to dropping nothing. Removing the overlap once "because the
  // PSL covers it" turned a load failure into `safe.cloudfront.net` being
  // blocked — caught by tests/firefox-performance.test.js, which injects a
  // blocklist directly and so never runs the guard.
  //
  // So: the PSL is the general fix, catching the namespaces nobody thought to
  // list. This is the floor underneath it, and it holds on its own.
  var SHARED_HOST_PARENTS = [
    'b-cdn.net',          // bunny.net CDN — IS in data/HOSTS.txt, and is NOT a
                          // public suffix, so this entry is the only thing
                          // standing between its customers and a block
    'cloudfront.net',
    'akamaized.net',
    'akamaihd.net',
    'azureedge.net',
    'azurefd.net',
    'cloudflare.net',
    'fastly.net',
    'fastlylb.net',
    'cdn77.org',
    'kxcdn.com',
    'stackpathdns.com',
    'edgecastcdn.net',
    'imgix.net',
    'scene7.com',
    'amazonaws.com',
    'digitaloceanspaces.com',
    'r2.dev',
    'netlify.app',
    'vercel.app',
    'pages.dev',
    'herokuapp.com',
    'github.io',
    'imagedelivery.net',
    'twimg.com',
    'fbcdn.net',
    'cdninstagram.com',
    'gstatic.com',
    'googleapis.com',
    'ggpht.com'
  ];

  // Public suffixes this project blocks wholesale ON PURPOSE.
  //
  // The bar is deliberately high: the namespace itself has to exist for adult
  // content, so that blocking every registration under it is the correct
  // outcome rather than collateral damage. A namespace that merely *contains*
  // adult sites (blogspot.com, pages.dev) does not qualify — those get their
  // individual sub-domains listed instead.
  //
  // Adding to this list means blocking every site under a suffix, sight
  // unseen. Do not add one without checking what is actually registered there.
  var BLOCKED_PUBLIC_SUFFIXES = [
    'sex.hu',   // Hungarian adult second-level domain
    'szex.hu'   // ditto, Hungarian spelling
  ];

  var exported = {
    SHARED_HOST_PARENTS: SHARED_HOST_PARENTS,
    BLOCKED_PUBLIC_SUFFIXES: BLOCKED_PUBLIC_SUFFIXES,
    sharedHostParentSet: function () { return new Set(SHARED_HOST_PARENTS); },
    blockedPublicSuffixSet: function () { return new Set(BLOCKED_PUBLIC_SUFFIXES); }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.DomainPolicy = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
