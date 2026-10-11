// "Hear yourself": a message in someone's own voice for the hard moment
// (shared/moments.js keeps it; shared/moment-voice.js plays it). The blocked
// page and the gateway pause play only plain recorded audio, only when
// tapped, and never ask about Supporter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Moments = require('../shared/moments.js');
const MomentVoice = require('../shared/moment-voice.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const CLIP = 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21l';

test('only plain recorded audio is played, and only up to its size', () => {
  assert.equal(Moments.voiceSrc({ src: CLIP, ms: 4000 }), CLIP);
  assert.equal(Moments.voiceSrc({ src: CLIP.replace('audio/webm', 'audio/ogg') }), CLIP.replace('audio/webm', 'audio/ogg'));
  assert.equal(Moments.voiceSrc({ src: CLIP.replace('audio/webm', 'audio/mp4') }), CLIP.replace('audio/webm', 'audio/mp4'));
  for (const bad of [
    null, 'x', {}, { src: 42 },
    { src: 'data:text/html;base64,PHNjcmlwdD4=' },
    { src: 'data:audio/webm;codecs=opus;base64,AAAA' },
    { src: 'javascript:alert(1)' },
    { src: 'https://example.com/a.webm' },
    { src: 'data:audio/webm;base64,AA AA' },
    { src: 'data:audio/webm;base64,' + 'A'.repeat(Moments.VOICE_MAX) }
  ]) assert.equal(Moments.voiceSrc(bad), '', JSON.stringify(bad).slice(0, 60));
  assert.equal(Moments.voiceMs({ ms: 42123.7 }), 42123);
  assert.equal(Moments.voiceMs({ ms: -5 }), 0);
  assert.equal(Moments.voiceMs({ ms: 9e9 }), 600000);
  assert.equal(Moments.voiceMs(null), 0);
});

// A tiny stand-in for the DOM and an <audio> element.
function fakeLine() {
  const listeners = {};
  const button = { textContent: '', addEventListener: (t, f) => { listeners[t] = f; }, click: () => listeners.click() };
  const time = { textContent: '' };
  return {
    hidden: true,
    button,
    time,
    querySelector: (sel) => (sel === '[data-voice-play]' ? button : sel === '[data-voice-time]' ? time : null)
  };
}
function fakeAudio() {
  const on = {};
  const a = {
    paused: true, currentTime: 0, src: '', preload: '',
    played: 0,
    play() { a.paused = false; a.played++; return Promise.resolve(); },
    pause() { a.paused = true; },
    addEventListener: (t, f) => { on[t] = f; },
    fire: (t) => on[t] && on[t]()
  };
  return a;
}

test('nothing to hear: the line stays hidden', () => {
  const line = fakeLine();
  assert.equal(MomentVoice.wire(line, null, { Moments }), false);
  assert.equal(line.hidden, true);
  assert.equal(MomentVoice.wire(line, { src: 'data:text/html;base64,AAAA' }, { Moments }), false);
  assert.equal(line.hidden, true);
});

test('a message: shown with its length, played only on a tap, paused on another', async () => {
  const line = fakeLine();
  const audio = fakeAudio();
  assert.equal(MomentVoice.wire(line, { src: CLIP, ms: 42000 }, { Moments, makeAudio: () => audio }), true);
  assert.equal(line.hidden, false);
  assert.equal(line.button.textContent, 'Hear yourself');
  assert.equal(line.time.textContent, '0:42');
  assert.equal(audio.played, 0, 'never plays by itself');
  assert.equal(audio.src, CLIP);
  line.button.click();
  await Promise.resolve();
  assert.equal(audio.played, 1);
  assert.equal(line.button.textContent, 'Pause');
  audio.currentTime = 12;
  audio.fire('timeupdate');
  assert.equal(line.time.textContent, '0:12 / 0:42');
  line.button.click();
  assert.equal(audio.paused, true);
  assert.equal(line.button.textContent, 'Hear yourself');
  audio.paused = true;
  audio.fire('ended');
  assert.equal(audio.currentTime, 0);
});

test('the blocked page and the gateway pause play it, and never ask about Supporter', () => {
  for (const [page, script] of [['blocked.html', 'blocked.js'], ['gateway.html', 'gateway.js']]) {
    const html = read(page);
    assert.match(html, /<script src="shared\/moment-voice\.js"><\/script>/, `${page} loads the player`);
    assert.match(html, /data-voice-play>Hear yourself</, `${page} has the button`);
    assert.doesNotMatch(html, /supporter\.js|extras\//, `${page} loads no Supporter code`);
    assert.match(read(script), /Moments\.VOICE_KEY/, `${script} reads the message`);
  }
  assert.doesNotMatch(read('shared/moment-voice.js'), /pblocker_supporter|Supporter\./);
  // Nothing autoplays from the markup; only the blocked page may start it, and
  // only when the person asked (the record's `auto`).
  for (const f of ['blocked.html', 'gateway.html']) assert.doesNotMatch(read(f), /autoplay/i, f);
  assert.match(read('blocked.js'), /MomentVoice\.wire\(document\.getElementById\('moment-voice'\), store\[Moments\.VOICE_KEY\], \{ autoplay: true \}\)/);
  assert.doesNotMatch(read('gateway.js'), /autoplay/, 'the gateway pause never starts it by itself');
});

test('a sound kept as a file in IndexedDB: the note is checked, then the file is fetched and played', async () => {
  const note = { store: 'idb', type: 'audio/mpeg', size: 4 * 1024 * 1024, at: 1, ms: 240000, auto: false };
  assert.equal(Moments.voiceStored(note), true);
  assert.equal(Moments.hasVoice(note), true);
  assert.equal(Moments.voiceStored({ ...note, size: Moments.VOICE_FILE_MAX + 1 }), false, 'over 15 MB');
  assert.equal(Moments.voiceStored({ ...note, type: 'text/html' }), false);
  assert.equal(Moments.voiceStored({ ...note, store: 'web' }), false);
  assert.equal(Moments.voiceAuto({ ...note, auto: true }), true);
  assert.equal(Moments.VOICE_FILE_MAX, 15 * 1024 * 1024);

  const blob = { size: 4, type: 'audio/mpeg' };
  let audio = fakeAudio();
  let line = fakeLine();
  assert.equal(MomentVoice.wire(line, note, { Moments, makeAudio: () => audio, loadSound: async () => blob, objectUrl: () => 'blob:sound' }), true);
  assert.equal(line.hidden, false);
  assert.equal(line.time.textContent, '4:00');
  await tick();
  assert.equal(audio.src, 'blob:sound');
  line.button.click();
  await tick();
  assert.equal(audio.played, 1);

  // The file gone from IndexedDB: nothing is offered.
  line = fakeLine();
  MomentVoice.wire(line, note, { Moments, makeAudio: fakeAudio, loadSound: async () => null });
  await tick();
  assert.equal(line.hidden, true);
  // IndexedDB refusing (a private window, say): the same.
  line = fakeLine();
  MomentVoice.wire(line, note, { Moments, makeAudio: fakeAudio, loadSound: async () => { throw new Error('blocked'); } });
  await tick();
  assert.equal(line.hidden, true);
  // By itself, from IndexedDB, once the file is there.
  audio = fakeAudio();
  MomentVoice.wire(fakeLine(), { ...note, auto: true }, { Moments, makeAudio: () => audio, loadSound: async () => blob, objectUrl: () => 'blob:x', autoplay: true, doc: { visibilityState: 'visible' } });
  await tick();
  await tick();
  assert.equal(audio.played, 1);
});

test('the blocked page, the gateway pause and Settings load the sound store', () => {
  for (const page of ['blocked.html', 'gateway.html', 'options.html']) {
    assert.match(read(page), /<script src="shared\/sound-store\.js"><\/script>/, page);
  }
  const store = read('shared/sound-store.js');
  assert.doesNotMatch(store, /fetch\(|XMLHttpRequest|pblocker_supporter|Supporter\./, 'local only, and never asks about Supporter');
});

test('chosen sound files are accepted too: MP3 and WAV', () => {
  assert.ok(Moments.voiceSrc({ src: 'data:audio/mpeg;base64,SUQzBAAAAAAA' }));
  assert.ok(Moments.voiceSrc({ src: 'data:audio/wav;base64,UklGRiQAAABXQVZF' }));
  assert.equal(Moments.voiceSrc({ src: 'data:audio/x-msvideo;base64,AAAA' }), '');
  assert.equal(Moments.voiceAuto({ src: CLIP, auto: true }), true);
  assert.equal(Moments.voiceAuto({ src: CLIP, auto: 'yes' }), false);
  assert.equal(Moments.voiceAuto({ src: 'nope', auto: true }), false, 'nothing to play, nothing plays');
});

test('by itself: only when asked, once the page is in view; refused, it says so and waits for the tap', async () => {
  const docFor = (state) => {
    const on = {};
    return { visibilityState: state, addEventListener: (t, f) => { on[t] = f; }, removeEventListener: () => {}, show() { this.visibilityState = 'visible'; on.visibilitychange(); } };
  };
  // Not asked: never.
  let audio = fakeAudio();
  MomentVoice.wire(fakeLine(), { src: CLIP, ms: 3000 }, { Moments, makeAudio: () => audio, autoplay: true, doc: docFor('visible') });
  await tick();
  assert.equal(audio.played, 0);
  // Asked, but the page doesn't allow it (the gateway): never.
  audio = fakeAudio();
  MomentVoice.wire(fakeLine(), { src: CLIP, ms: 3000, auto: true }, { Moments, makeAudio: () => audio, doc: docFor('visible') });
  await tick();
  assert.equal(audio.played, 0);
  // Asked, and the page in view: it plays.
  audio = fakeAudio();
  let line = fakeLine();
  MomentVoice.wire(line, { src: CLIP, ms: 3000, auto: true }, { Moments, makeAudio: () => audio, autoplay: true, doc: docFor('visible') });
  await tick();
  assert.equal(audio.played, 1);
  assert.equal(line.button.textContent, 'Pause');
  // A tab opened in the background waits until it's looked at.
  audio = fakeAudio();
  const doc = docFor('hidden');
  MomentVoice.wire(fakeLine(), { src: CLIP, ms: 3000, auto: true }, { Moments, makeAudio: () => audio, autoplay: true, doc });
  await tick();
  assert.equal(audio.played, 0);
  doc.show();
  await tick();
  assert.equal(audio.played, 1);
  // The browser refuses: it says so, and the tap still works.
  audio = fakeAudio();
  audio.play = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
  line = fakeLine();
  MomentVoice.wire(line, { src: CLIP, ms: 3000, auto: true }, { Moments, makeAudio: () => audio, autoplay: true, doc: docFor('visible') });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(line.time.textContent, /held it back\. Tap to hear it/);
  assert.equal(line.button.textContent, 'Hear yourself');
});
