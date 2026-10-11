// shared/sound-store.js
// The sound for the hard moment, kept as a file in the extension's own
// IndexedDB: a recording or a song of up to 15 MB, stored as it is. Browser
// storage for extensions (storage.local) holds about 10 MB in all, shared
// with the blocklist and everything else, so only a short note about the
// sound lives there (Moments.VOICE_KEY: type, size, length, `auto`).
//
// Read by the blocked page and the gateway pause; written by the recorder in
// Settings (a Supporter extra) and by restoring a backup. Nothing here leaves
// the device. It never asks whether someone is a supporter.
//
// Loaded as a classic <script> in pages.

(function (root) {
  'use strict';

  var DB = 'blocknsfw';
  var VERSION = 1;
  var STORE = 'sounds';
  var KEY = 'moment';

  function open(idb) {
    var factory = idb || root.indexedDB;
    return new Promise(function (resolve, reject) {
      if (!factory) { reject(new Error('no IndexedDB')); return; }
      var req = factory.open(DB, VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open failed')); };
    });
  }

  function run(mode, fn, idb) {
    return open(idb).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var result;
        var req = fn(tx.objectStore(STORE));
        if (req) req.onsuccess = function () { result = req.result; };
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error || new Error('failed')); };
      });
    });
  }

  // Keeps the sound (a Blob), replacing any before it.
  function put(blob, idb) {
    return run('readwrite', function (s) { return s.put(blob, KEY); }, idb);
  }

  // The sound as a Blob, or null.
  function get(idb) {
    return run('readonly', function (s) { return s.get(KEY); }, idb).then(function (v) {
      return v && typeof v.size === 'number' ? v : null;
    });
  }

  function remove(idb) {
    return run('readwrite', function (s) { return s.delete(KEY); }, idb);
  }

  // A data: URL as a Blob (for restoring a backup).
  function fromDataUrl(src) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(String(src || ''));
    if (!m) return null;
    var bin = atob(m[2]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  // A Blob as a data: URL (for saving a backup).
  function toDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('unreadable')); };
      reader.readAsDataURL(blob);
    });
  }

  root.SoundStore = { DB: DB, STORE: STORE, KEY: KEY, put: put, get: get, remove: remove, fromDataUrl: fromDataUrl, toDataUrl: toDataUrl };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
