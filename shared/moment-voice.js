// shared/moment-voice.js
// "Hear yourself": the message someone recorded in their own voice, or the
// sound they chose, for the hard moment (Moments.VOICE_KEY), played when they
// tap it. On the blocked page it also plays by itself when they asked for
// that (`auto`), once the page is in view; browsers often refuse sound a page
// starts by itself, and then it says so and waits for the tap.
//
// Used by the blocked page and the gateway pause. It never asks about
// Supporter: a message once recorded stays, like the photo.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  // 42000 -> "0:42"
  function format(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  // Fills `line` from the stored record: a button marked data-voice-play and a
  // time marked data-voice-time. Returns whether there is a message to hear.
  //   opts: { autoplay (this page may start it, if the record says so),
  //           doc (for when the page is in view), Moments, makeAudio,
  //           loadSound (the file from IndexedDB; SoundStore.get), objectUrl }
  function wire(line, raw, opts) {
    var Moments = (opts && opts.Moments) || root.Moments;
    var src = Moments ? Moments.voiceSrc(raw) : '';
    var stored = !src && !!Moments && !!Moments.voiceStored && Moments.voiceStored(raw);
    if (!line) return !!(src || stored);
    line.hidden = !(src || stored);
    if (!src && !stored) return false;
    var button = line.querySelector('[data-voice-play]');
    var time = line.querySelector('[data-voice-time]');
    var make = (opts && opts.makeAudio) || function () { return new Audio(); };
    var audio = make();
    audio.preload = 'none';
    var total = Moments.voiceMs(raw);

    // The sound: in the note itself, or a file fetched from IndexedDB. If the
    // file has gone, there's nothing to offer.
    var ready;
    if (src) {
      audio.src = src;
      ready = Promise.resolve(true);
    } else {
      var load = (opts && opts.loadSound) || (root.SoundStore && root.SoundStore.get) || null;
      var toUrl = (opts && opts.objectUrl) || function (b) { return URL.createObjectURL(b); };
      ready = (load ? Promise.resolve(load()) : Promise.resolve(null)).then(function (blob) {
        if (!blob) { line.hidden = true; return false; }
        audio.src = toUrl(blob);
        return true;
      }, function () {
        line.hidden = true;
        return false;
      });
    }

    var idle = function () {
      button.textContent = 'Hear yourself';
      if (time) time.textContent = total ? format(total) : '';
    };
    var play = function () {
      Promise.resolve(audio.play()).then(function () {
        button.textContent = 'Pause';
      }, function () {
        if (time) time.textContent = 'It couldn’t play here.';
      });
    };
    button.addEventListener('click', function () {
      if (!audio.paused) {
        audio.pause();
        idle();
        return;
      }
      if (audio.src) play();
      else ready.then(function (ok) { if (ok) play(); });
    });
    audio.addEventListener('timeupdate', function () {
      if (!audio.paused && time) time.textContent = format(audio.currentTime * 1000) + (total ? ' / ' + format(total) : '');
    });
    audio.addEventListener('ended', function () {
      audio.currentTime = 0;
      idle();
    });
    idle();

    // By itself, once, when the page is in view.
    if (opts && opts.autoplay && Moments.voiceAuto && Moments.voiceAuto(raw)) {
      var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
      var started = false;
      var start = function () {
        if (started) return;
        started = true;
        ready.then(function (ok) {
          if (!ok) return;
          Promise.resolve(audio.play()).then(function () {
            button.textContent = 'Pause';
          }, function () {
            if (time) time.textContent = 'Your browser held it back. Tap to hear it.';
          });
        });
      };
      if (!doc || doc.visibilityState !== 'hidden') start();
      else {
        var onShow = function () {
          if (doc.visibilityState === 'hidden') return;
          doc.removeEventListener('visibilitychange', onShow);
          start();
        };
        doc.addEventListener('visibilitychange', onShow);
      }
    }
    return true;
  }

  var exported = { format: format, wire: wire };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.MomentVoice = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
