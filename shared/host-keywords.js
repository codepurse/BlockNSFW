// shared/host-keywords.js
// Shared smart-blocking keyword list and strict host matcher used by both
// the service worker (background.js) and the content script (content.js) so
// the early block and the on-page decision agree.
//
// Safety rules (per NON_ENGLISH_ADULT_BLOCKING_TODO P1):
//   - Whole-label match
//   - Hyphen-bounded label match
//   - No broad substring match for short tokens
//
// In a service worker, this file is loaded via importScripts. In a content
// script context, it is loaded as a content script in manifest.json before
// content.js runs. Both entry points just read the same HostBlockKeywords
// global.

(function (root) {
  'use strict';

  // =====================================================================
  // Host-only adult keyword curation (NON_ENGLISH_ADULT_BLOCKING_TODO P1)
  // =====================================================================
  //
  // STRICT MATCHING RULES (see labelMatches() below):
  //   1. Whole-label match: an entire hostname label must equal the token.
  //   2. Hyphen-bounded match: the token may be a prefix or suffix of a
  //      label, joined by a single hyphen.
  //   3. NO broad substring match for adult tokens.
  //
  // This means:
  //   - "essex.com" cannot match the token "sex" (not a label boundary).
  //   - "sex-tape.com" WILL match (hyphen-bounded).
  //   - "pornhub.com" matches because "pornhub" is a whole label.
  //
  // CURATION RULES (apply before adding any new token):
  //   - Adult-only: the token's primary, dominant meaning on the open web
  //     is adult / pornographic. Tokens with strong benign secondary uses
  //     are REJECTED (see AMBIGUOUS_HOST_KEYWORDS below).
  //   - Whole-label safe: even at the label level the token is not a
  //     common dictionary word in the target language that benign sites
  //     would put in their hostname (e.g. "jav" is too common in Java
  //     communities; "xxx" is borderline but kept because it is almost
  //     exclusively adult as a whole label).
  //   - Language spread: include the major non-English adult terms so the
  //     smart filter catches mirrors that do not appear in HOSTS.txt.
  //   - Conservative: when in doubt, leave the token OUT and rely on
  //     HOSTS.txt + page-level fallback (content.js text scan) instead.
  //
  // AMBIGUOUS / REJECTED TOKENS (do NOT add these as strong keywords):
  //   - "sex"    : collides with "essex", "middlesex", "sussex", "sextoys"
  //                brand names, and many health terms.
  //   - "jav"    : collides with Java, JavaScript, javanese, javadoc.
  //   - "cam"    : collides with webcam / surveillance / sports cam / cam
  //                as in "Cambridge". Only "chaturbate", "bongacams",
  //                "cam4" are safe as full brand labels.
  //   - "tube"   : collides with YouTube, product tubes, anatomy pages.
  //   - "video"  / "videos" : collides with every video site on earth.
  //   - "live"   : collides with livestreams, news, sports.
  //   - "hd"     / "1080p" : collides with hardware / TV / monitor sites.
  //   - "red"    / "tube" / "pink" / "hot" : too generic.
  //   - Translations of "free" / "new" / "best" : not adult-specific.
  //   - Medicine / health / anatomy terms: out of scope for host blocking.
  //   - Common dictionary words in any language that benign sites embed.
  //
  // ADDING A NEW TOKEN:
  //   1. Confirm the token is adult-dominant in its language.
  //   2. Confirm the token is unlikely to appear as a benign label.
  //   3. Add it to STRONG_HOST_KEYWORDS with a one-line comment naming the
  //      language and the brief reason.
  //   4. Add a smoke-test case in tests/smoke.test.js or a new test file.
  //   5. Update the README / docs to mention the new language coverage.
  // =====================================================================

  // Strong exact-label adult tokens. Used by the smart hostname filter.
  // Each token is unambiguous when matched as a whole label or at a
  // hyphen boundary (see STRICT MATCHING RULES above).
  var STRONG_HOST_KEYWORDS = [
    // English / Western adult brand names.
    'porn',
    'porno',
    'pornos',
    'xxx',
    'xvideos',
    'xhamster',
    'xnxx',
    'redtube',
    'youporn',
    'brazzers',
    'chaturbate',
    'bongacams',
    'cam4',
    'pornhub',
    'spankbang',
    'tube8',
    'youjizz',
    'nudography',
    'onlyfans',
    'erome',
    'hentai',
    'hentaihaven',
    'rule34',
    'pornoizle',
    'tubeporn',

    // Foreign-language transliterations. Each is documented with the
    // language and the reason it is safe at the label level.
    'seks',     // Polish / Indonesian / Turkish transliteration. Whole-label
                // hosts using this token are virtually all adult. Benign
                // collisions (Estonian words containing the substring) are
                // filtered out by whole-label matching.
    'sikis',    // Turkish adult slang ("fuck"). Whole-label hosts only.
    'bokep',    // Indonesian adult slang. Whole-label adult mirrors.
    'yadong',   // Korean adult slang (야동, romanized). Whole-label adult
                // mirrors (e.g. "yadong.com", "free-yadong.net").

    // CJK / non-Latin script tokens. These match against the decoded
    // Unicode form of an IDN hostname. Risk: benign CJK hosts may also
    // contain these characters, but the STRICT MATCHING RULES still apply,
    // and the whole-label form is dominated by adult mirrors.
    '色情',     // Chinese (Simplified / Traditional) for "pornography".
                // Whole-label adult mirrors ("色情.com", "色情影院.net").
    '야동',     // Korean for "adult video". Whole-label adult mirrors.
    'порно',   // Russian Cyrillic for "porno". Whole-label adult mirrors.
    'سكس',     // Arabic for "sex". Whole-label adult mirrors.
    'หนังโป๊'  // Thai for "pornographic film". Whole-label adult mirrors.
  ];

  // Back-compat alias. Older call sites in background.js and any future
  // import that still asks for the flat list sees only the strong tokens.
  var ADULT_HOST_KEYWORDS = STRONG_HOST_KEYWORDS;

  // Ambiguous / rejected tokens. Tracked here so future curators see the
  // reason these were NOT promoted to STRONG_HOST_KEYWORDS. The smart
  // hostname filter does NOT consult this list - it is documentation only.
  var AMBIGUOUS_HOST_KEYWORDS = {
    'sex':      'collides with essex, sussex, middlesex, sexting, sextoys',
    'jav':      'collides with Java, JavaScript, Javanese, javadoc',
    'cam':      'collides with webcam, surveillance, sports, Cambridge',
    'tube':     'collides with YouTube, product tubes, anatomy',
    'video':    'collides with every video site on earth',
    'videos':   'collides with every video site on earth',
    'live':     'collides with livestreams, news, sports',
    'hd':       'collides with hardware / TV / monitor sites',
    'red':      'too generic (redhat, redcross, reddit)',
    'pink':     'too generic (branding, fashion, health)',
    'hot':      'too generic (news, weather, food)',
    'free':     'too generic (every freebie site)',
    'porno-ru': 'ru TLD already covered by "porno"'
  };

  // Safe-host bypass tokens. If a hostname contains any of these (broad
  // substring), we suppress the block — these are recovery / accountability /
  // education / support sites that may legitimately contain adult-themed
  // words in their name (e.g. "pornhub-recovery.com" or "sex-addicts-help.org").
  // The list is intentionally broad: a false negative on a support site is far
  // worse than blocking a real adult site that also happens to mention "help".
  // The DNS layer + HOSTS.txt + the strict adult list still catch the
  // unambiguous cases.
  var SAFE_HOST_TOKENS = [
    'help',
    'recovery',
    'recover',
    'quit',
    'addiction',
    'support',
    'therapy',
    'counseling',
    'counselling',
    'treatment',
    'awareness',
    'education',
    'educate',
    'protect',
    'protection',
    'accountability',
    'nofap',
    'no-porn',
    'stop-porn',
    'antiporn',
    'anti-porn',
    'safer',
    'safe',
    'healing',
    'rehab',
    'overcome',
    'overcoming',
    'freedom',
    'liberty',
    'testimonial',
    'testimony',
    'research',
    'study',
    'academic'
  ];

  // Internal: run the strict scan over one form of the hostname.
  function labelMatches(candidate) {
    if (!candidate) return false;
    var labels = String(candidate).split('.');
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!label) continue;
      var lowerLabel = label.toLowerCase();
      for (var j = 0; j < ADULT_HOST_KEYWORDS.length; j++) {
        var k = ADULT_HOST_KEYWORDS[j];
        if (!k) continue;
        if (lowerLabel === k) return true;
        if (lowerLabel.endsWith('-' + k)) return true;
        if (lowerLabel.startsWith(k + '-')) return true;
      }
    }
    return false;
  }

  // The strict hostname smart-match.
  //   1) Safe-host bypass: if the ASCII hostname contains a recovery /
  //      accountability / education / support token, do NOT block.
  //   2) Scan the ASCII / punycode form (whole-label / hyphen-bounded).
  //   3) If a decoded Unicode form differs, scan that too.
  //   4) Never use a broad substring match for adult tokens — only the
  //      safe-host bypass uses broad substring, and only because false
  //      negatives there are far worse than false positives.
  function matchesAdultKeywordHost(hostname) {
    if (!hostname) return false;
    // Safe-host bypass runs on the normalized ASCII form.
    var normalized = String(hostname).toLowerCase();
    for (var s = 0; s < SAFE_HOST_TOKENS.length; s++) {
      if (normalized.indexOf(SAFE_HOST_TOKENS[s]) >= 0) return false;
    }
    if (labelMatches(hostname)) return true;
    if (typeof root.HostnameNormalize !== 'undefined' && root.HostnameNormalize.getHostnameVariants) {
      try {
        var variants = root.HostnameNormalize.getHostnameVariants(hostname);
        if (variants && variants.unicode && variants.unicode !== variants.ascii) {
          if (labelMatches(variants.unicode)) return true;
        }
      } catch (_) {
        // Decode failure: ASCII-only result stands.
      }
    }
    return false;
  }

  var exported = {
    STRONG_HOST_KEYWORDS: STRONG_HOST_KEYWORDS,
    AMBIGUOUS_HOST_KEYWORDS: AMBIGUOUS_HOST_KEYWORDS,
    ADULT_HOST_KEYWORDS: ADULT_HOST_KEYWORDS,
    SAFE_HOST_TOKENS: SAFE_HOST_TOKENS,
    matchesAdultKeywordHost: matchesAdultKeywordHost
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.HostBlockKeywords = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
