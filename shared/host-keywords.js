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

  // Safe-host bypass tokens. When one of these appears in a hostname we
  // suppress the block — these are recovery / accountability / education /
  // support sites that legitimately carry adult-themed words in their name
  // (e.g. "pornhub-recovery.com" or "porn-addiction-treatment.org"). A false
  // negative on a support site is far worse than missing one adult mirror, so
  // this list stays generous in what it covers.
  //
  // MATCHING RULE (see safeHostMatches below): a token must occupy whole
  // hyphen-delimited segments of a single label. It is NOT a bare substring.
  //
  // That distinction is the whole point. Substring matching meant any hostname
  // *containing* one of these strings anywhere had the smart filter switched
  // off wholesale — so "hentai-protect.io", "xnxx-safer.tv" and
  // "cdn.safe.pornhub-mirror.com" were all exempt, and an operator could buy
  // an exemption by putting "safe" in a new mirror's name. Segment matching
  // keeps "porn-addiction-treatment.org" exempt (its segments really are
  // "addiction" and "treatment") while "helpxxx.com" is not (its single
  // segment is "helpxxx", not "help").
  //
  // CURATION RULE: a token must be safety-coded enough that an adult operator
  // would not plausibly put it in a domain name. Words that are merely
  // positive or generic are rejected — segment matching narrows them but does
  // not make them safe, because the operator picks the segments. Removed for
  // exactly that reason, and deliberately NOT to be re-added:
  //   safe, safer   — free cover; "safe-<anything>" is one registration away
  //   study, research, academic — an adult mirror adds "-study" at no cost
  //   freedom, liberty — common in adult branding, not specific to recovery
  //   protect       — the bare verb is generic; "protection" is kept, being
  //                   long enough and strongly enough safety-coded to survive
  // A genuine academic or research site caught by this narrowing has a real
  // escape hatch already: data/WHITELIST.txt, which is exactly what the remote
  // whitelist exists for.
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
    'protection',
    'accountability',
    'nofap',
    'no-porn',
    'stop-porn',
    'antiporn',
    'anti-porn',
    'healing',
    'rehab',
    'overcome',
    'overcoming',
    'testimonial',
    'testimony'
  ];

  /**
   * Does a safe token occupy whole hyphen-delimited segments of some label?
   *
   * Each label is padded with hyphens so a single indexOf covers the four
   * positions a token can hold — the whole label, a prefix, a suffix, or a
   * run in the middle — and covers hyphenated tokens ("stop-porn") with the
   * same test as single words ("recovery").
   *
   *   "porn-addiction-treatment" -> "-porn-addiction-treatment-"
   *      contains "-addiction-"  -> exempt (a real support site)
   *   "helpxxx"                  -> "-helpxxx-"
   *      does not contain "-help-" -> not exempt
   */
  function safeHostMatches(hostname) {
    var labels = String(hostname == null ? '' : hostname).toLowerCase().split('.');
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!label) continue;
      var padded = '-' + label + '-';
      for (var j = 0; j < SAFE_HOST_TOKENS.length; j++) {
        if (padded.indexOf('-' + SAFE_HOST_TOKENS[j] + '-') !== -1) return true;
      }
    }
    return false;
  }

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
  //   1) Safe-host bypass: if a recovery / accountability / education /
  //      support token occupies whole hyphen-delimited segments of a label,
  //      do NOT block. See safeHostMatches.
  //   2) Scan the ASCII / punycode form (whole-label / hyphen-bounded).
  //   3) If a decoded Unicode form differs, scan that too.
  //   4) Never use a broad substring match, for adult tokens OR safe ones.
  //      Both sides are segment-bounded, so neither a longer word containing
  //      an adult token nor a longer word containing a safe token can decide
  //      the verdict by accident.
  function matchesAdultKeywordHost(hostname) {
    if (!hostname) return false;
    if (safeHostMatches(hostname)) return false;
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
    safeHostMatches: safeHostMatches,
    matchesAdultKeywordHost: matchesAdultKeywordHost
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.HostBlockKeywords = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
