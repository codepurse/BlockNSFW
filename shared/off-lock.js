// shared/off-lock.js
// What it takes to turn protection off: the level, the sentence, and how a
// typed sentence is checked.
//
// Turning BlockNSFW off is meant to take a moment, so it can't happen on an
// impulse. Until 2.0.3 that moment was the same for everyone: the streak, a
// reason, and a 164-word English sentence typed back exactly, one wrong letter
// and start again. Many people want exactly that, and keep it. But a reviewer
// who installed BlockNSFW only to hide suggestive images was never asked, and
// for anyone not fluent in English the sentence couldn't be done at all, so
// uninstalling was the only way out: friction that protects nobody.
//
// So it's a choice, made at setup and kept in Settings:
//   simple  your PIN, if you set one
//   pause   the streak, then why you installed BlockNSFW, in your own words
//   strict  both, then a sentence typed by hand (the default, and where
//           everyone who had BlockNSFW before stays)
// and under strict, which sentence: the full one (unchanged, the default), a
// short one, or one you write yourself, in any language.
//
// The check is about stopping to type it, not about spelling: capital letters,
// punctuation and spacing don't count, and about one slip in fifty characters
// is forgiven. All of it still has to be typed by hand.
//
// The settings are offLock and offSentence in pblocker_settings. Making either
// easier counts as loosening protection (isEasierLevel, sentenceChangeLoosens),
// so Settings asks for the PIN, the access code or the Pact's wait.
//
// Loaded as a classic script by options.html and onboarding.html, and as a
// CommonJS module in tests.

(function (root) {
  'use strict';

  var LEVELS = ['simple', 'pause', 'strict'];
  var DEFAULT_LEVEL = 'strict';

  // Word for word what everyone typed before 2.0.3.
  var FULL_SENTENCE = 'By typing this sentence, I acknowledge that I am consciously choosing to override the protection I previously put in place to guard my focus, discipline, and personal growth. I understand that this action directly contradicts the commitment I made to become a stronger, more self-controlled, and purpose-driven version of myself. I accept full responsibility for this decision, including any negative impact it may have on my goals, my time, my mental clarity, and my long-term well-being. I recognize that this choice is not accidental, not forced, and not automatic it is entirely mine. I understand that I am stepping away from the standards I set for myself, and I do so knowingly, without excuses, and without blaming circumstances, emotions, or external triggers. I acknowledge that growth requires consistency and integrity, and by proceeding, I am choosing short-term gratification over long-term self-respect. I accept that this action reflects my current priorities, and I take complete ownership of whatever follows as a result of this decision.';

  var SHORT_SENTENCE = 'I am choosing to turn off the protection I set up for myself. I know why I put it in place, and I am stepping away from it on purpose. This decision is mine, and I take responsibility for what follows.';

  var SENTENCE_KINDS = ['full', 'short', 'own'];

  // Your own sentence: long enough to be a real pause, in any language. A
  // language written without spaces is counted in characters instead.
  var OWN_MIN_WORDS = 30;
  var OWN_MIN_CHARS_UNSPACED = 60;
  var OWN_MAX_CHARS = 1500;

  // About one slip in fifty characters.
  var SLIP_RATE = 0.02;

  function normalizeLevel(value) {
    return LEVELS.indexOf(value) >= 0 ? value : DEFAULT_LEVEL;
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  /** Why this can't be your own sentence, or null if it can. */
  function ownSentenceProblem(text) {
    var value = String(text || '').trim();
    if (value.length > OWN_MAX_CHARS) return 'That’s more than ' + OWN_MAX_CHARS + ' characters. Shorten it a little.';
    var words = wordCount(value);
    var letters = value.replace(/\s/g, '').length;
    if (words >= OWN_MIN_WORDS || (words < 10 && letters >= OWN_MIN_CHARS_UNSPACED)) return null;
    return 'Write at least ' + OWN_MIN_WORDS + ' words, or ' + OWN_MIN_CHARS_UNSPACED + ' characters in a language written without spaces.';
  }

  /** { kind, text? }, where anything unusable is the full sentence. */
  function normalizeSentence(raw) {
    var kind = raw && SENTENCE_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'full';
    if (kind === 'own') {
      var text = typeof raw.text === 'string' ? raw.text.trim() : '';
      return ownSentenceProblem(text) ? { kind: 'full' } : { kind: 'own', text: text };
    }
    return { kind: kind };
  }

  function sentenceFor(choice) {
    var sentence = normalizeSentence(choice);
    if (sentence.kind === 'own') return sentence.text;
    return sentence.kind === 'short' ? SHORT_SENTENCE : FULL_SENTENCE;
  }

  // The words Settings and setup show for each choice.
  var LEVEL_DESCRIPTIONS = {
    simple: 'Your PIN, if you set one, and nothing else.',
    pause: 'Your days of protection, then why you installed BlockNSFW, in your own words.',
    strict: 'Your days and why you installed it, then a sentence typed by hand. Capital letters, punctuation and a few slips don’t count.'
  };

  function describeLevel(level) {
    return LEVEL_DESCRIPTIONS[normalizeLevel(level)];
  }

  function describeSentence(choice) {
    var sentence = normalizeSentence(choice);
    if (sentence.kind === 'own') return 'One you wrote yourself.';
    if (sentence.kind === 'short') return 'Three short sentences, ' + wordCount(SHORT_SENTENCE) + ' words.';
    return 'The full commitment, ' + wordCount(FULL_SENTENCE) + ' words. Before 2.0.3 everyone typed this one.';
  }

  function isEasierLevel(from, to) {
    return LEVELS.indexOf(normalizeLevel(to)) < LEVELS.indexOf(normalizeLevel(from));
  }

  // Going to the full sentence never loosens anything. Any other change of
  // sentence might: a short one, or your own, can be less than what it
  // replaces.
  function sentenceChangeLoosens(from, to) {
    var a = normalizeSentence(from);
    var b = normalizeSentence(to);
    if (b.kind === 'full') return false;
    return a.kind !== b.kind || (b.kind === 'own' && a.text !== b.text);
  }

  // What's compared: lower case, apostrophes dropped ("don’t" and "dont" are
  // the same), other punctuation and symbols as spaces, runs of space as one.
  // Unicode-aware, so a sentence in any language is read the same way.
  function normalizeForMatch(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/['‘’ʼ`´]/g, '')
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function slipsAllowed(target) {
    return Math.max(1, Math.floor(target.length * SLIP_RATE));
  }

  // Levenshtein distance, or max + 1 as soon as it's sure to exceed max. Only
  // a band max wide either side of the diagonal is filled in. With `prefix`,
  // the distance from `a` to the closest start of `b`, of whatever length.
  function distanceWithin(a, b, max, prefix) {
    var over = max + 1;
    if (!prefix && Math.abs(a.length - b.length) > max) return over;
    if (prefix && b.length < a.length - max) return over;
    var previous = new Array(b.length + 1);
    var current = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) previous[j] = j <= max ? j : over;
    for (var i = 1; i <= a.length; i++) {
      var from = Math.max(1, i - max);
      var to = Math.min(b.length, i + max);
      current[0] = i <= max ? i : over;
      // The cells just outside the band are read by the next row.
      current[from - 1] = from === 1 ? current[0] : over;
      if (to < b.length) current[to + 1] = over;
      var best = from === 1 ? current[0] : over;
      for (var k = from; k <= to; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        var value = Math.min(previous[k - 1] + cost, previous[k] + 1, current[k - 1] + 1, over);
        current[k] = value;
        if (value < best) best = value;
      }
      if (best > max) return over;
      var swap = previous;
      previous = current;
      current = swap;
    }
    if (!prefix) return Math.min(previous[b.length], over);
    var n = a.length;
    var closest = n <= max ? previous[0] : over;
    for (var e = Math.max(1, n - max); e <= Math.min(b.length, n + max); e++) {
      if (previous[e] < closest) closest = previous[e];
    }
    return Math.min(closest, over);
  }

  /** Whether `typed` is the sentence, give or take a few slips. */
  function matches(typed, sentence) {
    var target = normalizeForMatch(sentence);
    var value = normalizeForMatch(typed);
    if (!target || !value) return false;
    return distanceWithin(value, target, slipsAllowed(target)) <= slipsAllowed(target);
  }

  /**
   * For the line under the box while it's typed: 'match', 'typing' while what's
   * there is the start of the sentence give or take the same slips, or 'off'.
   */
  function progress(typed, sentence) {
    var target = normalizeForMatch(sentence);
    var value = normalizeForMatch(typed);
    if (!value) return 'empty';
    if (matches(typed, sentence)) return 'match';
    // Slips allowed so far grow with what's typed, up to the whole sentence's,
    // so the first words aren't waved through whatever they say.
    var allowed = Math.min(slipsAllowed(target), Math.max(2, Math.ceil(value.length * 0.05)));
    return distanceWithin(value, target, allowed, true) <= allowed ? 'typing' : 'off';
  }

  var exported = {
    LEVELS: LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    FULL_SENTENCE: FULL_SENTENCE,
    SHORT_SENTENCE: SHORT_SENTENCE,
    OWN_MIN_WORDS: OWN_MIN_WORDS,
    OWN_MIN_CHARS_UNSPACED: OWN_MIN_CHARS_UNSPACED,
    OWN_MAX_CHARS: OWN_MAX_CHARS,
    normalizeLevel: normalizeLevel,
    normalizeSentence: normalizeSentence,
    ownSentenceProblem: ownSentenceProblem,
    sentenceFor: sentenceFor,
    wordCount: wordCount,
    describeLevel: describeLevel,
    describeSentence: describeSentence,
    isEasierLevel: isEasierLevel,
    sentenceChangeLoosens: sentenceChangeLoosens,
    normalizeForMatch: normalizeForMatch,
    matches: matches,
    progress: progress
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.OffLock = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
