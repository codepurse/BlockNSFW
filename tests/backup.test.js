// A backup in one file (shared/backup.js), free for everyone. It never holds
// the PIN, the Pact, an access code, the Supporter code or which sites were
// blocked; restoring adds and never takes away; and settings are replaced
// only when the caller allows it (options-backup.js: PIN, never under a Pact).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
global.Moments = require('../shared/moments.js');
global.Gateways = require('../shared/gateways.js');
global.Ledger = require('../shared/ledger.js');
global.Path = require('../shared/path.js');
global.Progress = require('../shared/progress.js');
const Backup = require('../shared/backup.js');
const { Moments, Ledger, Path, Progress } = global;

const NOW = new Date(2026, 9, 11, 15, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const ID_OLD = 'd111111111111';
const ID_NEW = 'd222222222222';
const PHOTO = { src: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', at: 5 };
const VOICE = { src: 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQ==', at: 6, ms: 4200 };

// A computer that has been used for a while.
function oldComputer() {
  return {
    pblocker_settings: { enabled: true, blockedPageTheme: 'verse' },
    pblocker_whitelist: ['example.org'],
    pblocker_risk_hours: { enabled: true, start: 1380, end: 120 },
    pblocker_color_scheme: 'dark',
    pblocker_popup_face: 'words',
    pblocker_pin: { hash: 'secret', salt: 'x' },
    pblocker_pact: { active: true, witness: { secret: 'TOTPSECRET' } },
    pblocker_access_code: { code: 'abc' },
    pblocker_supporter: { kind: 'store', code: 'POLAR-KEY-123', activationId: 'act' },
    pblocker_audit_blocked: [{ url: 'https://adult.example/x' }],
    pblocker_top_domains: { 'adult.example': 9 },
    [Ledger.KEY]: { days: { '2026-09-01': { st: 'kept', g: 1, w: 0, x: 0, b: 2, h: [23] } } },
    [Moments.FIRST_SEEN_KEY]: NOW - 200 * DAY,
    [Path.KEY]: { opened: { 1: '2026-09-01', 2: '2026-09-02' }, done: { 1: 1 }, lines: { 1: 'Phone in the kitchen.' }, edited: { 1: 1 }, rounds: 0 },
    pblocker_checkins: [{ day: '2026-10-01', a: { sleep: 0 }, at: 1 }],
    [Moments.WORDS_KEY]: { plan: 'Walk.', note: '', person: { name: 'Sam', phone: '' } },
    [Moments.PHOTO_KEY]: PHOTO,
    [Moments.VOICE_KEY]: VOICE,
    [Moments.WAITS_KEY]: [{ at: NOW - 3 * DAY, ms: 540000, before: 4, after: 1 }],
    pblocker_streak_start: NOW - 40 * DAY,
    pblocker_longest_streak: 55
  };
}

const exported = () => JSON.parse(JSON.stringify(Backup.make(oldComputer(), { now: NOW - DAY, id: ID_OLD, app: '2.0.0' })));

test('a backup never holds the PIN, the Pact, an access code, the Supporter code or blocked sites', () => {
  const text = JSON.stringify(exported());
  for (const secret of ['secret', 'TOTPSECRET', 'abc"', 'POLAR-KEY-123', 'adult.example', 'pblocker_pin', 'pblocker_pact', 'pblocker_supporter', 'pblocker_access_code']) {
    assert.ok(!text.includes(secret), `the backup must not carry ${secret}`);
  }
  for (const k of Backup.NEVER_KEYS) assert.ok(!Backup.keys().includes(k), `keys() must not read ${k}`);
});

test('a backup holds settings, lists, history, the path, check-ins, words, photo, voice and the run', () => {
  const b = exported();
  assert.equal(b.format, 'blocknsfw-backup');
  assert.equal(b.device.id, ID_OLD);
  assert.deepEqual(b.settings.pblocker_whitelist, ['example.org']);
  assert.equal(b.settings.pblocker_settings.blockedPageTheme, 'verse');
  assert.equal(b.progress.snapshot.ledger['2026-09-01'].st, 'kept');
  assert.equal(b.progress.path.lines[1], 'Phone in the kitchen.');
  assert.equal(b.progress.checkins.length, 1);
  assert.equal(b.progress.words.plan, 'Walk.');
  assert.equal(b.progress.photo.src, PHOTO.src);
  assert.equal(b.progress.voice.ms, 4200);
  assert.deepEqual(b.progress.run, { start: NOW - 40 * DAY, longest: 55 });
  assert.equal(Backup.fileName(NOW), 'blocknsfw-backup-2026-10-11.json');
});

test('only a BlockNSFW backup is accepted, and one from a newer version says so', () => {
  assert.equal(Backup.parse('').ok, false);
  assert.equal(Backup.parse('{nope').ok, false);
  assert.equal(Backup.parse(JSON.stringify({ format: 'other' })).ok, false);
  assert.match(Backup.parse(JSON.stringify({ ...exported(), version: 99 })).reason, /newer BlockNSFW/);
  assert.match(Backup.parse(JSON.stringify({ ...exported(), device: { id: 'bad' } })).reason, /damaged/);
  assert.equal(Backup.parse('x'.repeat(Backup.MAX_BYTES + 1)).ok, false);
  assert.equal(Backup.parse(JSON.stringify(exported())).ok, true);
});

test('onto a new computer: history beside its own, everything else back, and the run carried over', () => {
  const backup = Backup.parse(JSON.stringify(exported())).backup;
  const fresh = { [Moments.FIRST_SEEN_KEY]: NOW - 60000, pblocker_streak_start: NOW - 60000 };
  const { writes, settings } = Backup.plan(backup, fresh, { id: ID_NEW, now: NOW, withSettings: true });
  assert.equal(settings, true);
  assert.deepEqual(Object.keys(writes[Progress.ELSEWHERE_KEY]), [ID_OLD], 'the old computer kept beside this one');
  assert.equal(writes[Path.KEY].lines[1], 'Phone in the kitchen.');
  assert.equal(writes.pblocker_checkins.length, 1);
  assert.equal(writes[Moments.WORDS_KEY].plan, 'Walk.');
  assert.equal(writes[Moments.PHOTO_KEY].src, PHOTO.src);
  assert.equal(writes[Moments.VOICE_KEY].ms, 4200);
  assert.deepEqual(writes[Moments.WAITS_KEY], [{ at: NOW - 3 * DAY, ms: 540000, before: 4, after: 1 }], 'the urges waited out come along');
  assert.equal(writes.pblocker_streak_start, NOW - 40 * DAY, 'the 40-day run comes along');
  assert.equal(writes.pblocker_longest_streak, 55);
  assert.deepEqual(writes.pblocker_whitelist, ['example.org']);
  assert.equal(writes.pblocker_color_scheme, 'dark');
  assert.equal(writes.pblocker_popup_face, 'words', 'the popup face comes back');
  for (const k of Backup.NEVER_KEYS) assert.ok(!(k in writes), `${k} is never written`);
});

test('restoring never takes away: words, photo and voice here stay, and a run broken here stays broken', () => {
  const backup = Backup.parse(JSON.stringify(exported())).backup;
  const here = {
    [Moments.FIRST_SEEN_KEY]: NOW - 300 * DAY,     // set up long before the backup
    pblocker_streak_start: NOW - 2 * DAY,          // broken two days ago
    pblocker_longest_streak: 80,
    [Moments.WORDS_KEY]: { plan: 'Mine.', note: '', person: { name: '', phone: '' } },
    [Moments.PHOTO_KEY]: { src: 'data:image/png;base64,iVBORw0KGgo=', at: 9 },
    [Moments.VOICE_KEY]: { src: 'data:audio/ogg;base64,T2dnUw==', at: 9, ms: 1000 },
    pblocker_checkins: [{ day: '2026-10-05', a: { mood: 1 }, at: 3 }],
    [Moments.WAITS_KEY]: [{ at: NOW - 2 * DAY, ms: 300000 }],
    [Path.KEY]: { opened: { 1: '2026-09-01', 2: '2026-09-02', 3: '2026-09-03' }, done: {}, lines: {}, rounds: 0 }
  };
  const { writes } = Backup.plan(backup, here, { id: ID_NEW, now: NOW, withSettings: false });
  assert.ok(!(Moments.WORDS_KEY in writes), 'words here stay');
  assert.ok(!(Moments.PHOTO_KEY in writes), 'the photo here stays');
  assert.ok(!(Moments.VOICE_KEY in writes), 'the voice here stays');
  assert.ok(!('pblocker_streak_start' in writes), 'an older run never mends one broken here');
  assert.ok(!('pblocker_longest_streak' in writes), 'the longest here was longer');
  assert.equal(writes.pblocker_checkins.length, 2, 'check-ins add up');
  assert.equal(writes[Moments.WAITS_KEY].length, 2, 'waits add up');
  assert.deepEqual(Object.keys(writes[Path.KEY].opened), ['1', '2', '3'], 'the path keeps the furthest day');
});

test('settings and lists are replaced only when allowed; the rest comes back either way', () => {
  const backup = Backup.parse(JSON.stringify(exported())).backup;
  const { writes, settings } = Backup.plan(backup, {}, { id: ID_NEW, now: NOW, withSettings: false });
  assert.equal(settings, false);
  for (const k of Backup.SETTINGS_KEYS) assert.ok(!(k in writes), `${k} untouched`);
  assert.ok(writes[Path.KEY], 'the path still comes back');
  // A settings value of the wrong kind is never written.
  const odd = Backup.parse(JSON.stringify({ ...exported(), settings: { pblocker_settings: 'nope', pblocker_whitelist: { x: 1 }, pblocker_color_scheme: 'x'.repeat(100) } })).backup;
  const r = Backup.plan(odd, {}, { id: ID_NEW, now: NOW, withSettings: true });
  assert.equal(r.settings, false);
  // Even a hand-made file can't sneak the PIN, the Pact or a Supporter code in.
  const sneaky = Backup.parse(JSON.stringify({ ...exported(), settings: { pblocker_pin: {}, pblocker_supporter: {}, pblocker_pact: {} } })).backup;
  const w = Backup.plan(sneaky, {}, { id: ID_NEW, now: NOW, withSettings: true }).writes;
  for (const k of ['pblocker_pin', 'pblocker_supporter', 'pblocker_pact']) assert.ok(!(k in w));
});

test('a backup of this same computer adds nothing to its history', () => {
  const backup = Backup.parse(JSON.stringify(exported())).backup;
  const { writes } = Backup.plan(backup, oldComputer(), { id: ID_OLD, now: NOW, withSettings: false });
  assert.ok(!(Progress.ELSEWHERE_KEY in writes), 'this computer is never kept beside itself');
});

test('Settings restores settings only after the PIN, and never under a Pact', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'options-backup.js'), 'utf8');
  assert.match(src, /let withSettings = d\.settings && !pactOn;/);
  assert.match(src, /withSettings = await requirePINIfSet\('replace your settings and lists from a backup', \{ critical: true \}\);/);
  assert.match(src, /Backup\.plan\(backup, local, \{ id, now, withSettings \}/);
  for (const script of ['build-chrome.ps1', 'build-firefox.ps1']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), /"options-backup\.js",/, `${script} ships options-backup.js`);
  }
});
