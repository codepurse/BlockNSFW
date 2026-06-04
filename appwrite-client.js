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
