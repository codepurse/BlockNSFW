// options-backup.js
// Settings › About › Your data: save a backup, and restore one
// (shared/backup.js). Free for everyone: it's your own data.
//
// Restoring adds history and never takes it away. Settings and lists are
// replaced only after the PIN (and access code) when one is set, and never
// while the Pact is on: a backup is not a way around protection. The rest
// comes back either way.
//
// Uses showToast, showConfirmModal, requirePINIfSet and readPact from
// options.js, loaded before it.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function formatDay(ms) {
    try {
      return new Date(ms).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  async function saveBackup() {
    const button = $('backup-export');
    button.disabled = true;
    try {
      const now = Date.now();
      const id = await Progress.deviceId(browserAPI.storage.local, now);
      const store = await browserAPI.storage.local.get(Backup.keys());
      // The sound is a file in IndexedDB (shared/sound-store.js): it goes in
      // the backup written out whole.
      const note = store[Moments.VOICE_KEY];
      if (Moments.voiceStored(note) && typeof SoundStore !== 'undefined') {
        try {
          const blob = await SoundStore.get();
          if (blob) store[Moments.VOICE_KEY] = { src: await SoundStore.toDataUrl(blob), at: note.at, ms: note.ms, auto: note.auto === true };
        } catch (_) {}
      }
      let app = '';
      try { app = browserAPI.runtime.getManifest().version; } catch (_) {}
      const backup = Backup.make(store, { now, id, app });
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = Backup.fileName(now);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('Backup saved. Keep the file somewhere private.', 'success');
    } catch (_) {
      showToast('The backup couldn’t be made. Try again.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  // What's in it, in a sentence or two, for the question before restoring.
  function summary(d, pactOn) {
    const what = [];
    if (d.days) what.push(plural(d.days, 'day', 'days') + ' of history');
    if (d.pathDays) what.push(`the path to day ${d.pathDays}`);
    if (d.checkins) what.push(plural(d.checkins, 'check-in', 'check-ins'));
    if (d.photo) what.push('your photo');
    if (d.voice) what.push('your voice message');
    const from = [d.from ? `from ${d.from}` : '', d.when ? `saved ${formatDay(d.when)}` : ''].filter(Boolean).join(', ');
    let text = `This backup${from ? ` (${from})` : ''} holds ${what.length ? what.join(', ') : 'no history yet'}. It’s added to what’s here, and nothing here is lost.`;
    if (d.settings) {
      text += pactOn
        ? ' Your settings and lists stay as they are while the Pact is on.'
        : ' Your settings and lists are replaced with the backup’s.';
    }
    return text;
  }

  async function restore(file) {
    if (!file) return;
    if (file.size > Backup.MAX_BYTES) {
      showToast('That file is too large to be a BlockNSFW backup.', 'error');
      return;
    }
    let parsed;
    try {
      parsed = Backup.parse(await file.text());
    } catch (_) {
      parsed = { ok: false, reason: 'That file couldn’t be read.' };
    }
    if (!parsed.ok) {
      showToast(parsed.reason, 'error');
      return;
    }
    const backup = parsed.backup;
    const d = Backup.describe(backup);
    let pactOn = false;
    try { pactOn = typeof Pact !== 'undefined' && !!Pact && Pact.isActive(await readPact()); } catch (_) {}
    const confirmed = await showConfirmModal({
      title: 'Restore this backup?',
      description: summary(d, pactOn),
      confirmText: 'Restore'
    });
    if (!confirmed) return;

    let withSettings = d.settings && !pactOn;
    let skippedForPin = false;
    if (withSettings) {
      withSettings = await requirePINIfSet('replace your settings and lists from a backup', { critical: true });
      skippedForPin = !withSettings;
    }
    try {
      const now = Date.now();
      const id = await Progress.deviceId(browserAPI.storage.local, now);
      const local = await browserAPI.storage.local.get(Backup.keys());
      const { writes, settings } = Backup.plan(backup, local, { id, now, withSettings }, null);
      // A sound comes back as a file in IndexedDB, with only a note about it
      // in storage.local, which is too small for a long one.
      const voice = writes[Moments.VOICE_KEY];
      if (voice && voice.src) {
        try {
          const blob = SoundStore.fromDataUrl(voice.src);
          await SoundStore.put(blob);
          writes[Moments.VOICE_KEY] = { store: 'idb', type: blob.type, size: blob.size, at: voice.at, ms: voice.ms, auto: voice.auto === true };
        } catch (_) {
          if (voice.src.length > 2000000) delete writes[Moments.VOICE_KEY];
        }
      }
      if (Object.keys(writes).length) await browserAPI.storage.local.set(writes);
      let message = 'Backup restored.';
      if (settings) message += ' Your settings and lists are the backup’s now.';
      else if (d.settings && pactOn) message += ' Your settings stayed as they are, because the Pact is on.';
      else if (skippedForPin) message += ' Your settings stayed as they are, since the PIN wasn’t entered.';
      showToast(message, 'success');
      if (settings) setTimeout(() => location.reload(), 1500);
    } catch (_) {
      showToast('The backup couldn’t be restored. Nothing was changed.', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof Backup === 'undefined' || typeof Progress === 'undefined' || !$('backup-export')) return;
    $('backup-export').addEventListener('click', saveBackup);
    const input = $('backup-import-file');
    $('backup-import').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      restore(file);
    });
  });
})();
