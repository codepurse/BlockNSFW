// shared/backup.js
// A backup of BlockNSFW in one file, made and restored in Settings › About
// (options-backup.js). Free for everyone: it's your own data.
//
// It holds your settings and lists; this computer's history (a Progress
// snapshot) and your other computers'; the path, the evening check-ins, your
// own words, the photo and the voice message; the urges you waited out; and
// your run.
//
// It never holds the PIN, the Pact or its witness, an access code, your
// Supporter code (a backup isn't a way to share it), the log of blocked
// addresses or the sites blocked most, or anything that's only a copy of
// something downloaded.
//
// Restoring adds and never takes away: history, the path, check-ins, waits and
// your words are merged with what's here (shared/progress.js, Path.merge); the
// photo and the voice come back only where there are none. Settings and lists
// are replaced, but only when the caller allows it: options-backup.js asks
// for the PIN when one is set and never replaces them while the Pact is on,
// so a backup is never a way around protection.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var FORMAT = 'blocknsfw-backup';
  var VERSION = 1;
  var MAX_BYTES = 40 * 1024 * 1024;   // a 15 MB sound and a photo, written as text
  var CHECKINS_KEY = 'pblocker_checkins';
  var RUN_KEY = 'pblocker_streak_start';
  var LONGEST_KEY = 'pblocker_longest_streak';

  // Settings and lists: replaced on restore, when allowed.
  var SETTINGS_KEYS = ['pblocker_settings', 'pblocker_whitelist', 'pblocker_subscriptions',
    'pblocker_risk_hours', 'pblocker_color_scheme', 'pblocker_look', 'pblocker_popup_face',
    'pblocker_popup_sections'];

  // Never in a backup, whatever else changes: checked by the tests.
  var NEVER_KEYS = ['pblocker_pin', 'pblocker_pin_lock', 'pblocker_pact', 'pblocker_pact_queue',
    'pblocker_pact_clock', 'pblocker_pact_code_lock', 'pblocker_access_code', 'pblocker_supporter',
    'pblocker_audit_blocked', 'pblocker_top_domains', 'pblocker_temp_disable_until', 'pblocker_device'];

  function mod(name, deps) {
    return (deps && deps[name]) || root[name] || null;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  // The proof a photo or voice message was chosen under (shared/supporter.js
  // keepsake), when it's a receipt from monolab.dev: it goes with them, so
  // they still show on a new computer after the plan ends. A signed code
  // stays out, since that is the Supporter code itself. The page that shows
  // them checks it; here it's only carried.
  function receiptOf(raw) {
    var paid = raw && typeof raw === 'object' ? raw.paid : null;
    return typeof paid === 'string' && paid.length <= 2048 && /^BNR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(paid) ? paid : '';
  }

  function withPaid(record, raw) {
    var paid = receiptOf(raw);
    if (paid) record.paid = paid;
    return record;
  }

  // Every key the backup is made from.
  function keys(deps) {
    var Moments = mod('Moments', deps);
    var Progress = mod('Progress', deps);
    var Path = mod('Path', deps);
    var out = SETTINGS_KEYS.concat(Progress.snapshotKeys(deps), [
      Progress.ELSEWHERE_KEY, Path.KEY, CHECKINS_KEY, Moments.WORDS_KEY, Moments.PHOTO_KEY,
      Moments.VOICE_KEY, Moments.WAITS_KEY, RUN_KEY, LONGEST_KEY
    ]);
    return out.filter(function (k, i) { return out.indexOf(k) === i; });
  }

  // The backup, as an object ready for JSON. `store` holds keys().
  //   opts: { now, id (this computer, Progress.deviceId), app (the version) }
  function make(store, opts, deps) {
    var Moments = mod('Moments', deps);
    var Progress = mod('Progress', deps);
    var Path = mod('Path', deps);
    var s = store || {};
    var settings = {};
    SETTINGS_KEYS.forEach(function (k) {
      if (s[k] !== undefined && s[k] !== null) settings[k] = s[k];
    });
    var photo = Moments.photoSrc(s[Moments.PHOTO_KEY]);
    var voice = Moments.voiceSrc(s[Moments.VOICE_KEY]);
    return {
      format: FORMAT,
      version: VERSION,
      app: String(opts.app || ''),
      exportedAt: opts.now,
      device: { id: opts.id, label: Progress.label() },
      settings: settings,
      progress: {
        snapshot: Progress.snapshot(s, opts.id, opts.now, deps),
        elsewhere: Progress.normalizeElsewhere(s[Progress.ELSEWHERE_KEY], opts.id, deps),
        path: Path.normalize(s[Path.KEY]),
        checkins: Progress.mergeCheckins(s[CHECKINS_KEY], []),
        words: Moments.normalizeWords(s[Moments.WORDS_KEY]),
        photo: photo ? withPaid({ src: photo, at: num(s[Moments.PHOTO_KEY].at) }, s[Moments.PHOTO_KEY]) : null,
        voice: voice ? withPaid({ src: voice, at: num(s[Moments.VOICE_KEY].at), ms: Moments.voiceMs(s[Moments.VOICE_KEY]), auto: Moments.voiceAuto(s[Moments.VOICE_KEY]) }, s[Moments.VOICE_KEY]) : null,
        waits: Moments.normalizeWaits(s[Moments.WAITS_KEY]),
        run: { start: num(s[RUN_KEY]), longest: Math.floor(num(s[LONGEST_KEY])) }
      }
    };
  }

  // "blocknsfw-backup-2026-10-11.json"
  function fileName(now) {
    var d = new Date(now);
    return 'blocknsfw-backup-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '.json';
  }

  // The file's text, checked. { ok: true, backup } or { ok: false, reason }.
  function parse(text, deps) {
    var Progress = mod('Progress', deps);
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'That file is empty.' };
    if (text.length > MAX_BYTES) return { ok: false, reason: 'That file is too large to be a BlockNSFW backup.' };
    var b;
    try { b = JSON.parse(text); } catch (_) { return { ok: false, reason: 'That isn’t a BlockNSFW backup.' }; }
    if (!b || typeof b !== 'object' || b.format !== FORMAT) return { ok: false, reason: 'That isn’t a BlockNSFW backup.' };
    if (!(Number(b.version) >= 1)) return { ok: false, reason: 'That isn’t a BlockNSFW backup.' };
    if (Number(b.version) > VERSION) return { ok: false, reason: 'That backup is from a newer BlockNSFW. Update this one first, then try again.' };
    if (!num(b.exportedAt) || !b.device || !Progress.validId(b.device.id)) return { ok: false, reason: 'That backup is damaged, so it can’t be restored.' };
    if (!b.progress || typeof b.progress !== 'object') b.progress = {};
    if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) b.settings = {};
    return { ok: true, backup: b };
  }

  // What a backup holds, in plain words for the question before restoring.
  function describe(backup, deps) {
    var Progress = mod('Progress', deps);
    var Path = mod('Path', deps);
    var p = backup.progress || {};
    var snap = Progress.normalizeSnapshot(p.snapshot, deps);
    var path = Path.normalize(p.path);
    var label = snap && snap.label ? snap.label : (typeof backup.device.label === 'string' ? backup.device.label.slice(0, 60) : '');
    return {
      from: label,
      when: num(backup.exportedAt),
      days: snap ? Object.keys(snap.ledger).length : 0,
      computers: Object.keys(Progress.normalizeElsewhere(p.elsewhere, null, deps)).length + (snap ? 1 : 0),
      checkins: Progress.mergeCheckins(p.checkins, []).length,
      pathDays: Object.keys(path.opened).length,
      lines: Object.keys(path.lines).length,
      photo: !!(p.photo && mod('Moments', deps).photoSrc(p.photo)),
      voice: !!(p.voice && mod('Moments', deps).voiceSrc(p.voice)),
      settings: SETTINGS_KEYS.some(function (k) { return backup.settings[k] !== undefined; })
    };
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // A settings value from the file, if it's the right kind of thing.
  function settingValue(key, v) {
    if (key === 'pblocker_settings' || key === 'pblocker_risk_hours' || key === 'pblocker_look' ||
        key === 'pblocker_popup_sections') {
      return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    }
    if (key === 'pblocker_whitelist' || key === 'pblocker_subscriptions') return Array.isArray(v) ? v : undefined;
    if (key === 'pblocker_color_scheme' || key === 'pblocker_popup_face') {
      return typeof v === 'string' && v.length < 20 ? v : undefined;
    }
    return undefined;
  }

  // What restoring writes: { writes: { key: value }, settings: bool }.
  //   local: the keys() of this computer; opts: { id (this computer), now,
  //   withSettings (the PIN and Pact allow it) }
  function plan(backup, local, opts, deps) {
    var Moments = mod('Moments', deps);
    var Progress = mod('Progress', deps);
    var Path = mod('Path', deps);
    var l = local || {};
    var p = backup.progress || {};
    var writes = {};
    var put = function (key, value) {
      if (!sameValue(value, l[key])) writes[key] = value;
    };

    // History: the backup's computer, and the others it knew, beside this one's.
    var incoming = [p.snapshot].concat(Object.keys(p.elsewhere || {}).map(function (k) { return p.elsewhere[k]; }));
    var merged = Progress.mergeElsewhere(l[Progress.ELSEWHERE_KEY], incoming, opts.id, deps);
    if (merged.changed) writes[Progress.ELSEWHERE_KEY] = merged.elsewhere;

    if (p.path) put(Path.KEY, Path.merge(l[Path.KEY], p.path));
    if (Array.isArray(p.checkins) && p.checkins.length) put(CHECKINS_KEY, Progress.mergeCheckins(l[CHECKINS_KEY], p.checkins));
    if (p.words) put(Moments.WORDS_KEY, Progress.mergeWords(l[Moments.WORDS_KEY], p.words, deps));
    if (Array.isArray(p.waits) && p.waits.length) put(Moments.WAITS_KEY, Moments.mergeWaits(l[Moments.WAITS_KEY], p.waits));
    if (!Moments.photoSrc(l[Moments.PHOTO_KEY]) && Moments.photoSrc(p.photo)) {
      writes[Moments.PHOTO_KEY] = withPaid({ src: p.photo.src, at: num(p.photo.at) || opts.now }, p.photo);
    }
    if (!Moments.hasVoice(l[Moments.VOICE_KEY]) && Moments.voiceSrc(p.voice)) {
      writes[Moments.VOICE_KEY] = withPaid({ src: p.voice.src, at: num(p.voice.at) || opts.now, ms: Moments.voiceMs(p.voice), auto: p.voice.auto === true }, p.voice);
    }

    // Your run. The longest stays the longest. The current one comes back
    // only onto a computer set up after the backup was made (moving to a new
    // one), never over a run this computer broke since.
    var run = p.run || {};
    var longest = Math.max(Math.floor(num(l[LONGEST_KEY])), Math.floor(num(run.longest)));
    if (longest) put(LONGEST_KEY, longest);
    var firstHere = num(l[Moments.FIRST_SEEN_KEY]);
    var startThere = num(run.start);
    var startHere = num(l[RUN_KEY]);
    if (startThere && startThere < opts.now && firstHere > num(backup.exportedAt) && (!startHere || startThere < startHere)) {
      writes[RUN_KEY] = startThere;
    }

    var settings = false;
    if (opts.withSettings) {
      SETTINGS_KEYS.forEach(function (key) {
        var v = settingValue(key, backup.settings[key]);
        if (v !== undefined) { put(key, v); settings = true; }
      });
    }
    NEVER_KEYS.forEach(function (k) { delete writes[k]; });
    return { writes: writes, settings: settings };
  }

  var exported = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MAX_BYTES: MAX_BYTES,
    SETTINGS_KEYS: SETTINGS_KEYS,
    NEVER_KEYS: NEVER_KEYS,
    keys: keys,
    make: make,
    fileName: fileName,
    parse: parse,
    describe: describe,
    plan: plan
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Backup = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
