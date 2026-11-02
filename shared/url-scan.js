// shared/url-scan.js
// Builds the text that URL adult-keyword scans run against.
//
// Scanning a raw query string is what makes filter-friendly sites look adult.
// A site that ships its own adult filter puts the switch in the query, so the
// keyword lands in the parameter NAME while the value says the filter is ON:
//
//   https://4get.ca/web?s=cats&nsfw=no       -> filtered, must NOT be blocked
//   https://example.com/search?show_nsfw=0   -> filtered, must NOT be blocked
//   https://4get.ca/web?s=cats&nsfw=yes      -> filter off, keep blocking
//
// Parameter names are controls, not content, so a keyword in a name only counts
// when the value says the switch is turned on. Parameter values are always
// scanned, so ?q=porn still reads as an adult signal.
//
// In a content script this file is loaded before content.js via
// manifest.json; in Node it exports the same helpers for tests.

(function (root) {
  'use strict';

  // Values meaning "the adult filter is engaged" on a positively named
  // parameter (nsfw=no), and "disengaged" on a negatively named one
  // (hide_nsfw=no).
  var FILTER_OFF_VALUES = /^(no|off|0|false|none|never|hide|hidden|exclude|excluded|deny|disable|disabled|strict|safe)$/;
  var FILTER_ON_VALUES = /^(yes|on|1|true|only|all|allow|allowed|include|included|show|shown|enable|enabled)$/;

  // Parameter names that already carry the negation, which flips their
  // polarity: `hide_nsfw=true` says the same thing as `nsfw=false`.
  var NEGATED_PARAM_NAME = /(^|[^a-z])(no|not|non|hide|block|exclude|filter|without|safe|deny|disable|disallow|strict|skip|remove)([^a-z]|$)/;

  /**
   * True when this parameter is a filter switch in the "adult content is being
   * filtered out" position, which makes any keyword in its name a control label
   * rather than a description of the page.
   */
  function isFilterSwitchEngaged(key, value) {
    var name = String(key == null ? '' : key).toLowerCase();
    var val = String(value == null ? '' : value).trim().toLowerCase();
    // A bare flag (?nsfw) states no polarity, so it keeps its old meaning.
    if (!val) return false;

    var negatedName = NEGATED_PARAM_NAME.test(name);
    if (FILTER_OFF_VALUES.test(val)) return !negatedName;
    if (FILTER_ON_VALUES.test(val)) return negatedName;
    return false;
  }

  function decodeSafely(value) {
    if (!value) return '';
    try {
      return decodeURIComponent(String(value));
    } catch (_) {
      // Stray "%" or an invalid escape: the raw text still scans fine.
      return String(value);
    }
  }

  function toUrl(urlLike) {
    if (!urlLike) return null;
    if (typeof urlLike === 'object' && typeof urlLike.pathname === 'string') return urlLike;
    try {
      return new URL(String(urlLike));
    } catch (_) {
      return null;
    }
  }

  // Query text with every engaged filter switch dropped. Both halves of a
  // dropped pair go: an engaged switch always has a boolean-ish value, so no
  // adult keyword can hide in the value we discard.
  function buildQueryScanText(u) {
    var search = u.search || '';
    if (!search || search === '?') return '';

    var parts = [];
    try {
      var params = u.searchParams || new URLSearchParams(search);
      params.forEach(function (value, key) {
        if (isFilterSwitchEngaged(key, value)) return;
        parts.push(decodeSafely(key));
        parts.push(decodeSafely(value));
      });
    } catch (_) {
      // No usable URLSearchParams: scan the raw query rather than nothing.
      return decodeSafely(search.replace(/\+/g, ' '));
    }
    return parts.join(' ');
  }

  /**
   * Text safe to run adult-keyword regexes over: the decoded path plus the
   * query with filter switches removed. Word-boundary patterns keep working
   * because the pieces are space-joined.
   *
   * @param {string|URL|Location} urlLike
   * @param {{includeQuery?: boolean}} [opts]
   * @returns {string}
   */
  function buildUrlScanText(urlLike, opts) {
    var includeQuery = !opts || opts.includeQuery !== false;
    var u = toUrl(urlLike);
    if (!u) return decodeSafely(String(urlLike || '').replace(/\+/g, ' '));

    var text = decodeSafely(u.pathname || '');
    if (includeQuery) {
      var query = buildQueryScanText(u);
      if (query) text += ' ' + query;
    }
    return text;
  }

  // --- Reading an address for what it is about ------------------------------
  //
  // The address door (the fourth on the blocked page) holds a page whose
  // address carries an adult word, before anything loads. An address about
  // getting away from porn carries the same word:
  //
  //   fightthenewdrug.org/how-porn-affects-the-brain-like-a-drug/
  //   forum.nofap.com/index.php?threads/day-90-no-porn.12345/
  //   google.com/search?q=porn+induced+erectile+dysfunction
  //
  // The page-text door after it reads the words around a match before it
  // judges; this reads the words around the match in the address the same way,
  // so the door that knows least is no longer the strictest.
  //
  // An address part speaks for recovery when it has a recovery word, and none
  // of these: a word for looking ("free", "hd", "videos"), a word for getting
  // past a blocker ("unblocked", "proxy"), any word about minors, or a second
  // kind of adult word ("porn" and "xxx"). Those vetoes come first, so a
  // recovery word can never carry a looking search through.

  // Search engines, and the parameter each keeps the searched words in. The
  // background's network rules force SafeSearch on all of them but Startpage
  // (and Restricted Mode on YouTube), so the results page is filtered either
  // way; Startpage, which they can't reach, is held whole unless its own switch
  // is off (shared/unsafe-search.js).
  var SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com|yahoo\.com|yandex\.[a-z.]+|ecosia\.org|qwant\.com|startpage\.com|aol\.com|presearch\.(com|org)|youtube\.com)$/;
  var SEARCH_PARAMS = ['q', 'p', 'text', 'query', 'search_query'];
  // The engine's copy of what was typed before a suggestion was picked
  // (Google's oq, Bing's pq): the search itself already says it in full, and a
  // half-typed "porn addic" would otherwise outvote it.
  var ENGINE_ECHO_PARAMS = ['oq', 'pq'];
  // A search box on any other site: X, Reddit, a store. Nothing filters those
  // results, so a search there is never read as recovery.
  var SITE_SEARCH_PARAMS = /^(q|p|s|k|kw|query|search|search_query|searchterm|term|terms|text|keyword|keywords|tag|tags|find)$/;

  // The adult words the address door holds on, each with its kind: "porn" and
  // "pornography" in one address are one subject, "porn" and "xxx" are two.
  var ADULT_KIND = {
    porn: 'porn', porno: 'porn', porns: 'porn', pornography: 'porn', pornographic: 'porn',
    xxx: 'xxx', nsfw: 'nsfw', hentai: 'hentai', nude: 'nude', naked: 'nude', erotic: 'erotic'
  };

  // Phrases that say "away from it", read before the words are split.
  // "porn-free" and "free from porn" are the opposite of looking; "porn free"
  // with a space is "free porn" reordered and stays a search for it. "no porn"
  // is the NoFap forum's own phrase ("day 90 no porn").
  var AWAY_FROM = /\b(break[\s-]+free|free[\s-]+from|(porn|porno|nsfw|xxx|hentai)-?free|no[\s-]+(porn|porno|pornography|nsfw|hentai|fap))\b/g;

  function wordSet(words) {
    var set = Object.create(null);
    words.split(/\s+/).forEach(function (word) { if (word) set[word] = true; });
    return set;
  }

  // Words that say an address is about getting away from it. Every one was
  // weighed against porn's own vocabulary and left out when it doubles as a
  // category: "wife", "girlfriend", "shame", "family", "stepsister" are all
  // searched for, so they are not here (some are vetoes below instead).
  var RECOVERY_WORDS = wordSet(
    'quit quits quitting quitter stop stops stopped stopping ' +
    'addict addicts addicted addiction addictions addictive compulsive compulsion compulsions ' +
    'dependence dependency habit habits ' +
    'recover recovers recovery recovering recovered overcome overcomes overcoming overcame ' +
    'relapse relapses relapsed relapsing urge urges craving cravings trigger triggers withdrawal withdrawals ' +
    'nofap nopmo pmo reboot rebooting rewire rewiring flatline detox streak retention ' +
    'abstain abstaining abstinence sober sobriety ' +
    'rehab therapy therapist therapists counseling counselling counselor counsellor counselors counsellors ' +
    'treatment treatments accountability ' +
    'blocker blockers block blocking filter filters filtering ' +
    'help heal healing harm harms harmful effect effects affect affects affected affecting ' +
    'impact impacts consequences dangers damage damaging risks problem problems problematic unhealthy toxic ' +
    'resist resisting avoid avoiding struggle struggles struggling cope coping ' +
    'fight fighting battle battling conquer conquering escape escaping issue issues ' +
    'bad wrong sin normal healthy ' +
    'brain brains neuroscience science research studies statistics stats facts myths health mental ' +
    'depression anxiety loneliness guilt erectile dysfunction pied ' +
    'marriage marriages spouse spouses relationship relationships betrayal betrayed trauma ' +
    'faith christian christians catholic church bible biblical god jesus pray prayer prayers ' +
    'purity ministry sermon scripture islam islamic muslim haram ' +
    'prevention prevent protect protection awareness education educate parenting parental safety trafficking ' +
    'why ' +
    // "porno" is the word in French, Spanish, Portuguese, Italian and German.
    'adiccion adicción adicto adicta dejar vicio viciado dependencia dependência ' +
    'dependance dépendance arreter arrêter sevrage sucht süchtig aufhoren aufhören dipendenza smettere'
  );

  // Words that say someone is looking for it. "quit free porn" is still a
  // search for free porn, and "stepsister porn addiction" for stepsister porn.
  var SEEKING_WORDS = wordSet(
    'free hd 4k 1080p 720p uncensored download downloads stream streaming tube tubes ' +
    'cam cams webcam webcams gallery galleries pics pictures photos gif gifs clip clips collection ' +
    'leak leaked leaks video videos vid vids movie movies links star stars pornstar pornstars ' +
    'actress actresses amateur homemade anal lesbian lesbians ebony milf milfs hardcore softcore ' +
    'horny sexy hot hottest busty boobs tits ass pussy cock dick fuck fucking blowjob nudes ' +
    'girl girls babe babes mom stepmom sister stepsister stepsis stepbro stepdad stepson stepdaughter family ' +
    'onlyfans fansly chaturbate game games comic comics manga doujin doujinshi'
  );
  // Not "live" or "chat": "how to live porn-free" and a support chat room are
  // what they mean next to a recovery word, and "cams" covers the rest.

  // Asking how to get past a blocker is not a search for help.
  var BYPASS_WORDS = wordSet('unblock unblocked bypass proxy proxies mirror mirrors');

  // Never read as recovery, whatever else the words say. This holds some real
  // help searches ("teen porn addiction", "protect kids from porn") as the
  // price of never letting one through that isn't: "how to quit porn" and
  // "porn blocker" still go through.
  var MINOR_WORDS = wordSet(
    'child children childs kid kids minor minors underage teen teens teenage teenager teenagers ' +
    'preteen preteens young younger youth loli lolita shota jailbait schoolgirl schoolgirls ' +
    'schoolboy schoolboys school schools babysitter'
  );

  /**
   * What one piece of an address says: which kinds of adult word it carries,
   * whether it speaks for recovery, and whether anything vetoes that.
   * Hyphens and underscores join a slug's words ("living-porn-free"), so they
   * are read as phrase joins first and as word breaks after.
   */
  function readPart(text) {
    var lower = String(text == null ? '' : text).toLowerCase().replace(/_/g, '-');
    AWAY_FROM.lastIndex = 0;
    var away = AWAY_FROM.test(lower);
    AWAY_FROM.lastIndex = 0;
    var kinds = Object.create(null);
    var kindCount = 0;
    var recovery = away;
    var veto = false;
    var words = lower.split(/[^\p{L}\p{N}]+/u);
    for (var i = 0; i < words.length; i++) {
      var kind = ADULT_KIND[words[i]];
      if (kind && !kinds[kind]) {
        kinds[kind] = true;
        kindCount++;
      }
      if (RECOVERY_WORDS[words[i]]) recovery = true;
      if (BYPASS_WORDS[words[i]] || MINOR_WORDS[words[i]]) veto = true;
    }
    // "free" counts against a part unless it is the free of "porn-free".
    var rest = away ? lower.replace(AWAY_FROM, ' ').split(/[^\p{L}\p{N}]+/u) : words;
    for (var j = 0; j < rest.length && !veto; j++) {
      if (SEEKING_WORDS[rest[j]]) veto = true;
    }
    if (kindCount > 1) veto = true;
    return { adult: kindCount > 0, recovery: recovery && !veto };
  }

  // The pieces of an address that are read separately: the path, then each
  // query parameter. A recovery word only speaks for the piece it is in, so
  // "/porn?quit" is not about quitting.
  function addressParts(u) {
    var parts = [{ text: decodeSafely(u.pathname || ''), kind: 'slug' }];
    var search = u.search || '';
    if (!search || search === '?') return parts;
    var engine = SEARCH_HOST.test(String(u.hostname || '').toLowerCase());
    var params = u.searchParams || new URLSearchParams(search);
    params.forEach(function (value, key) {
      if (isFilterSwitchEngaged(key, value)) return;
      var name = String(key).toLowerCase();
      if (engine && ENGINE_ECHO_PARAMS.indexOf(name) !== -1) return;
      if (engine && SEARCH_PARAMS.indexOf(name) !== -1) {
        parts.push({ text: value, kind: 'search' });
      } else if (SITE_SEARCH_PARAMS.test(name)) {
        parts.push({ text: value, kind: 'site-search' });
      } else {
        // A slug can live in the query too: XenForo forums put the thread
        // title in a parameter name ("?threads/day-90-no-porn.12345/").
        parts.push({ text: key + ' ' + value, kind: 'slug' });
      }
    });
    return parts;
  }

  /**
   * True when every piece of the address that carries an adult word reads as
   * being about getting away from it: an article slug
   * ("/how-porn-affects-the-brain"), a forum thread ("day-90-no-porn"), or a
   * search on a SafeSearch engine ("porn induced erectile dysfunction").
   * A search box on any other site never qualifies, nor does an address with
   * no adult word in it.
   *
   * @param {string|URL|Location} urlLike
   * @returns {boolean}
   */
  function isRecoveryAddress(urlLike) {
    var u = toUrl(urlLike);
    if (!u) return false;
    var parts;
    try {
      parts = addressParts(u);
    } catch (_) {
      return false;
    }
    var carried = false;
    for (var i = 0; i < parts.length; i++) {
      var read = readPart(parts[i].text);
      if (!read.adult) continue;
      carried = true;
      if (parts[i].kind === 'site-search' || !read.recovery) return false;
    }
    return carried;
  }

  /**
   * The same reading for a page's own words: "How Porn Can Affect the Brain
   * Like a Drug" is about getting away from it; "Free Porn Videos" is not.
   * For a title or description, which the page's author wrote as plainly as a
   * slug. Text with no adult word in it is not about recovery from anything.
   *
   * @param {string} text
   * @returns {boolean}
   */
  function readsAsRecovery(text) {
    var read = readPart(text);
    return read.adult && read.recovery;
  }

  /**
   * True when the address is a search-engine results page for a search about
   * quitting: "how to quit porn addiction", "porn blocker for chrome". Asks the
   * same question isRecoveryAddress asks of every piece, of the search alone.
   *
   * @param {string|URL|Location} urlLike
   * @returns {boolean}
   */
  function isRecoverySearch(urlLike) {
    var u = toUrl(urlLike);
    if (!u || !SEARCH_HOST.test(String(u.hostname || '').toLowerCase())) return false;
    var query = '';
    try {
      var params = u.searchParams || new URLSearchParams(u.search || '');
      for (var i = 0; i < SEARCH_PARAMS.length && !query; i++) {
        query = params.get(SEARCH_PARAMS[i]) || '';
      }
    } catch (_) {
      return false;
    }
    return readPart(query).recovery;
  }

  var exported = {
    FILTER_OFF_VALUES: FILTER_OFF_VALUES,
    FILTER_ON_VALUES: FILTER_ON_VALUES,
    NEGATED_PARAM_NAME: NEGATED_PARAM_NAME,
    isFilterSwitchEngaged: isFilterSwitchEngaged,
    buildUrlScanText: buildUrlScanText,
    isRecoveryAddress: isRecoveryAddress,
    isRecoverySearch: isRecoverySearch,
    readsAsRecovery: readsAsRecovery
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.UrlScan = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
