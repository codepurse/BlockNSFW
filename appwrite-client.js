/**
 * BlockNSFW community reports - Appwrite Function client
 *
 * Calls an Appwrite Function via its direct domain.
 * No API keys, no database IDs, no secrets in extension code.
 */

const APPWRITE_FUNCTION_URL = 'https://699ac1b100018b3f455a.sgp.appwrite.run';

const DEVICE_ID_KEY = 'pblocker_device_id';
const REPORT_COOLDOWN_KEY = 'pblocker_report_cooldown';
const REPORT_DAILY_KEY = 'pblocker_report_daily';
const REPORTED_KEYS_KEY = 'pblocker_reported_keys';
const REPORT_COOLDOWN_MS = 120_000;
const DAILY_REPORT_LIMIT = 5;

const PBlockerReports = (() => {
  const api = typeof browser === 'undefined' ? chrome : browser;

  return {
    async getDeviceId() {
      const stored = await api.storage.local.get(DEVICE_ID_KEY);
      if (stored[DEVICE_ID_KEY]) return stored[DEVICE_ID_KEY];

      const id = crypto.randomUUID();
      await api.storage.local.set({ [DEVICE_ID_KEY]: id });
      return id;
    },

    async getCooldownRemaining() {
      const stored = await api.storage.local.get(REPORT_COOLDOWN_KEY);
      const until = stored[REPORT_COOLDOWN_KEY] || 0;
      return Math.max(0, until - Date.now());
    },

    async setCooldown() {
      await api.storage.local.set({
        [REPORT_COOLDOWN_KEY]: Date.now() + REPORT_COOLDOWN_MS,
      });
    },

    async getDailyCount() {
      const stored = await api.storage.local.get(REPORT_DAILY_KEY);
      const data = stored[REPORT_DAILY_KEY] || { date: '', count: 0 };
      const today = new Date().toISOString().slice(0, 10);
      if (data.date !== today) return 0;
      return data.count;
    },

    async incrementDailyCount() {
      const today = new Date().toISOString().slice(0, 10);
      const stored = await api.storage.local.get(REPORT_DAILY_KEY);
      const data = stored[REPORT_DAILY_KEY] || { date: '', count: 0 };
      const count = data.date === today ? data.count + 1 : 1;
      await api.storage.local.set({
        [REPORT_DAILY_KEY]: { date: today, count },
      });
    },

    buildReportKey(reportType, domain) {
      return `${String(reportType || '').toLowerCase()}:${String(domain || '').toLowerCase().trim()}`;
    },

    async isReportKeyAlreadyReported(reportKey) {
      const stored = await api.storage.local.get(REPORTED_KEYS_KEY);
      const keys = stored[REPORTED_KEYS_KEY] || [];
      return keys.includes(reportKey);
    },

    async markReportKeyReported(reportKey) {
      const stored = await api.storage.local.get(REPORTED_KEYS_KEY);
      const keys = stored[REPORTED_KEYS_KEY] || [];
      keys.push(reportKey);
      await api.storage.local.set({ [REPORTED_KEYS_KEY]: keys });
    },

    async getDailyRemaining() {
      return DAILY_REPORT_LIMIT - await this.getDailyCount();
    },

    isConfigured() {
      return APPWRITE_FUNCTION_URL !== 'YOUR_FUNCTION_URL';
    },

    /**
     * Submit a website report via Appwrite Function.
     * @param {{ url: string, domain: string, reportType: string, category: string, notes?: string }} data
     */
    async submitReport({ url, domain, reportType, category, notes }) {
      if (!this.isConfigured()) {
        throw new Error('Community reports are not configured yet.');
      }

      const cooldown = await this.getCooldownRemaining();
      if (cooldown > 0) {
        const seconds = Math.ceil(cooldown / 1000);
        throw new Error(`Please wait ${seconds}s before submitting another report.`);
      }

      const dailyCount = await this.getDailyCount();
      if (dailyCount >= DAILY_REPORT_LIMIT) {
        throw new Error(`Daily limit reached (${DAILY_REPORT_LIMIT} reports per day). Try again tomorrow.`);
      }

      const validTypes = ['should_block', 'incorrectly_blocked'];
      const validCategories = ['adult', 'gambling', 'violence', 'other', 'n/a'];
      if (!validTypes.includes(reportType)) {
        throw new Error('Invalid report type.');
      }
      if (!validCategories.includes(category)) {
        throw new Error('Invalid category.');
      }

      const normalizedDomain = String(domain || '').toLowerCase().replace(/^www\./, '').trim();
      const reportKey = this.buildReportKey(reportType, normalizedDomain);
      if (await this.isReportKeyAlreadyReported(reportKey)) {
        throw new Error('You already submitted this report type for this website.');
      }

      const deviceId = await this.getDeviceId();

      let version = '';
      try { version = api.runtime.getManifest().version; } catch (_) {}

      const response = await fetch(APPWRITE_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          domain: normalizedDomain,
          reportType,
          reportKey,
          category,
          notes: (notes || '').slice(0, 500),
          deviceId,
          browser: 'chrome',
          version,
        }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        if (result.message?.includes('already submitted')) {
          throw new Error('This report was already submitted by the community. Thank you!');
        }
        throw new Error(result.message || 'Failed to submit report. Please try again.');
      }

      await this.setCooldown();
      await this.incrementDailyCount();
      await this.markReportKeyReported(reportKey);
      return result;
    },
  };
})();

/**
 * BlockNSFW community stories - Appwrite Function client
 *
 * Submits anonymous recovery/encouragement stories via an Appwrite Function.
 * The function writes approved stories into the Appwrite database collection.
 */

const APPWRITE_STORIES_FUNCTION_URL = 'https://6a3aafbf000d1e70cc28.sgp.appwrite.run';

const STORY_COOLDOWN_KEY = 'pblocker_story_cooldown';
const STORY_DAILY_KEY = 'pblocker_story_daily';
const STORY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DAILY_STORY_LIMIT = 1;

const PBlockerStories = (() => {
  const api = typeof browser === 'undefined' ? chrome : browser;

  return {
    // Human-friendly remaining time, e.g. "6d 23h", "45m 10s".
    formatWait(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const d = Math.floor(total / 86400);
      const h = Math.floor((total % 86400) / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },

    async getCooldownRemaining() {
      const stored = await api.storage.local.get(STORY_COOLDOWN_KEY);
      const until = stored[STORY_COOLDOWN_KEY] || 0;
      return Math.max(0, until - Date.now());
    },

    async setCooldown() {
      await api.storage.local.set({
        [STORY_COOLDOWN_KEY]: Date.now() + STORY_COOLDOWN_MS,
      });
    },

    async getDailyCount() {
      const stored = await api.storage.local.get(STORY_DAILY_KEY);
      const data = stored[STORY_DAILY_KEY] || { date: '', count: 0 };
      const today = new Date().toISOString().slice(0, 10);
      if (data.date !== today) return 0;
      return data.count;
    },

    async incrementDailyCount() {
      const today = new Date().toISOString().slice(0, 10);
      const stored = await api.storage.local.get(STORY_DAILY_KEY);
      const data = stored[STORY_DAILY_KEY] || { date: '', count: 0 };
      const count = data.date === today ? data.count + 1 : 1;
      await api.storage.local.set({
        [STORY_DAILY_KEY]: { date: today, count },
      });
    },

    async getDailyRemaining() {
      return DAILY_STORY_LIMIT - await this.getDailyCount();
    },

    isConfigured() {
      return APPWRITE_STORIES_FUNCTION_URL !== 'YOUR_STORIES_FUNCTION_URL';
    },

    /**
     * Fetch a page of approved community stories (newest first).
     * @param {{ offset?: number, limit?: number }} [opts]
     * @returns {Promise<{ stories: Array<{ id: string, title: string, content: string, likes: number, createdAt: string }>, total: number }>}
     */
    async fetchStories({ offset = 0, limit = 10 } = {}) {
      if (!this.isConfigured()) {
        throw new Error('Community stories are not configured yet.');
      }

      const url = `${APPWRITE_STORIES_FUNCTION_URL}?offset=${offset}&limit=${limit}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Failed to load stories.');
      }

      return {
        stories: Array.isArray(result.stories) ? result.stories : [],
        total: Number(result.total) || 0,
      };
    },

    /**
     * Like or unlike a story; returns the updated shared count.
     * @param {string} storyId
     * @param {boolean} liked - true to like, false to unlike
     * @returns {Promise<{ ok: boolean, likes: number }>}
     */
    async likeStory(storyId, liked) {
      if (!this.isConfigured()) {
        throw new Error('Community stories are not configured yet.');
      }

      let deviceId = '';
      try { deviceId = await PBlockerReports.getDeviceId(); } catch (_) {}

      const response = await fetch(APPWRITE_STORIES_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'like', storyId, like: !!liked, deviceId }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Failed to update like.');
      }

      return { ok: true, likes: Number(result.likes) || 0 };
    },

    /**
     * Submit a community story via Appwrite Function.
     * @param {{ title?: string, content: string }} data
     */
    async submitStory({ title, content }) {
      if (!this.isConfigured()) {
        throw new Error('Community stories are not configured yet.');
      }

      const cooldown = await this.getCooldownRemaining();
      if (cooldown > 0) {
        throw new Error(`You can share one story per week — try again in ${this.formatWait(cooldown)}.`);
      }

      const dailyCount = await this.getDailyCount();
      if (dailyCount >= DAILY_STORY_LIMIT) {
        throw new Error('You can share one story per week. Please try again later.');
      }

      const cleanContent = String(content || '').trim();
      if (cleanContent.length < 20) {
        throw new Error('Story must be at least 20 characters.');
      }
      if (cleanContent.length > 2000) {
        throw new Error('Story must be 2000 characters or less.');
      }

      const cleanTitle = String(title || '').trim().slice(0, 120);

      const deviceId = await PBlockerReports.getDeviceId();

      let version = '';
      try { version = api.runtime.getManifest().version; } catch (_) {}

      const response = await fetch(APPWRITE_STORIES_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: cleanTitle,
          content: cleanContent,
          nickname: 'Anonymous',
          status: 'pending',
          deviceId,
          browser: 'chrome',
          version,
        }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Failed to submit story. Please try again.');
      }

      await this.setCooldown();
      await this.incrementDailyCount();
      return result;
    },
  };
})();
