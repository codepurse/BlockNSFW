// Christmas: snow and lights from 1 December to 1 January.
//
// shared/season.js decides when, and whether the person still wants it;
// ui/christmas.js draws it on the popup and the held page and nowhere else.
// These hold the dates (it has to be gone on 2 January without anyone touching
// it), the switch, the words beside the wordmark, and the wiring: a page that
// loads the drawing before the season check, or a website that runs a frame of
// it, would be a bug nobody sees until December.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function loadSeason() {
  const sandbox = {};
  vm.runInNewContext(read('shared/season.js'), sandbox);
  return sandbox.Season;
}

const Season = loadSeason();
const on = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

test('it shows from 1 December to 1 January, both days included', () => {
  assert.equal(Season.inSeason(on(2026, 11, 30, 23, 59)), false, '30 November is too early');
  assert.equal(Season.inSeason(on(2026, 12, 1, 0, 0)), true, 'from the first minute of 1 December');
  assert.equal(Season.inSeason(on(2026, 12, 25)), true);
  assert.equal(Season.inSeason(on(2026, 12, 31, 23, 59)), true);
  assert.equal(Season.inSeason(on(2027, 1, 1, 0, 0)), true, 'New Year’s Day still has it');
  assert.equal(Season.inSeason(on(2027, 1, 1, 23, 59)), true);
  assert.equal(Season.inSeason(on(2027, 1, 2, 0, 0)), false, 'gone on 2 January by itself');
  assert.equal(Season.inSeason(on(2027, 7, 1)), false);
});

test('only a kept false turns it off', () => {
  assert.equal(Season.wanted(undefined), true, 'nothing kept means on');
  assert.equal(Season.wanted(null), true);
  assert.equal(Season.wanted(true), true);
  assert.equal(Season.wanted(false), false);
  assert.equal(Season.isOn(undefined, on(2026, 12, 10)), true);
  assert.equal(Season.isOn(false, on(2026, 12, 10)), false, 'the switch wins in season');
  assert.equal(Season.isOn(true, on(2026, 11, 10)), false, 'and the calendar wins out of it');
});

test('the words beside the wordmark count down to Christmas and see the year out', () => {
  assert.equal(Season.line(on(2026, 12, 1)), '24 days to Christmas');
  assert.equal(Season.line(on(2026, 12, 23, 23, 30)), '2 days to Christmas');
  assert.equal(Season.line(on(2026, 12, 24)), 'Christmas Eve');
  assert.equal(Season.line(on(2026, 12, 25)), 'Merry Christmas');
  assert.equal(Season.line(on(2026, 12, 30)), 'Merry Christmas');
  assert.equal(Season.line(on(2026, 12, 31)), 'New Year’s Eve');
  assert.equal(Season.line(on(2027, 1, 1)), 'Happy New Year');
});

test('the popup and the held page load the season check, then the drawing, in <head>', () => {
  for (const page of ['popup.html', 'blocked.html']) {
    const html = read(page);
    const head = html.slice(0, html.indexOf('</head>'));
    const season = head.indexOf('<script src="shared/season.js"></script>');
    const drawing = head.indexOf('<script src="ui/christmas.js"></script>');
    assert.ok(season > -1, `${page} loads shared/season.js in <head>`);
    assert.ok(drawing > season, `${page} loads ui/christmas.js after it, so <html> is marked before the first paint`);
  }
  assert.match(read('popup.html'), /id="season-line"/, 'the popup has a place for the words');
  assert.match(read('blocked.html'), /\.has-christmas-line \.doors-across \.door-arrival/, 'the held page hides the plain line the lights replace');
});

test('no website ever runs it', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const injected = (manifest.content_scripts || []).flatMap((c) => c.js || []);
  assert.ok(!injected.some((f) => /christmas|season/.test(f)), 'not a content script');
  assert.ok(!/christmas/i.test(read('content.js')), 'content.js never loads it');
  assert.ok(!/https?:\/\//.test(read('ui/christmas.js').replace(/^\s*\/\/.*$/gm, '')), 'and it reaches nothing on the network');
});

test('Settings has the switch, with the season check loaded before options.js', () => {
  const html = read('options.html');
  assert.match(html, /id="christmas-toggle"[^>]*checked/, 'a switch, on unless turned off');
  const season = html.indexOf('<script src="shared/season.js"></script>');
  assert.ok(season > -1 && season < html.indexOf('<script src="options.js"></script>'));
  assert.match(read('options.js'), /setupChristmasSwitch\(\);/);
});

test('a backup carries the choice, and only as true or false', () => {
  global.Moments = require('../shared/moments.js');
  global.Gateways = require('../shared/gateways.js');
  global.Ledger = require('../shared/ledger.js');
  global.Path = require('../shared/path.js');
  global.Progress = require('../shared/progress.js');
  const Backup = require('../shared/backup.js');
  assert.ok(Backup.SETTINGS_KEYS.includes(Season.KEY));
  const source = read('shared/backup.js');
  assert.match(source, /key === 'pblocker_christmas'\) return typeof v === 'boolean' \? v : undefined/);
});
