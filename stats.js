const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'pblocker_settings';
const BLOCKED_STATS_KEY = 'pblocker_stats';
const DAILY_STATS_KEY = 'pblocker_daily_stats';
const STREAK_START_KEY = 'pblocker_streak_start';
const LONGEST_STREAK_KEY = 'pblocker_longest_streak';
const AUDIT_BLOCKED_KEY = 'pblocker_audit_blocked';
const TOP_DOMAINS_KEY = 'pblocker_top_domains';
const DAILY_HISTORY_KEY = 'pblocker_daily_history';

const MOTIVATIONAL_QUOTES = [
  { text: "The secret of change is to focus all of your energy not on fighting the old, but on building the new.", author: "Socrates" },
  { text: "Every moment is a fresh beginning.", author: "T.S. Eliot" },
  { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
  { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { text: "Your limitation—it's only your imagination.", author: "Unknown" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Unknown" },
  { text: "Dreams don't work unless you do.", author: "John C. Maxwell" },
  { text: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" }
];

const AVG_TIME_PER_BLOCK_MINUTES = 5;

function $(id) { return document.getElementById(id); }

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatTimeSaved(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDaysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs((date2 - date1) / oneDay));
}

function getRandomQuote() {
  return MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
}

async function getStats() {
  const { [BLOCKED_STATS_KEY]: stats } = await browserAPI.storage.local.get(BLOCKED_STATS_KEY);
  return stats || { blockedCount: 0, websiteBlockedCount: 0, imageBlockedCount: 0, searchResultBlockedCount: 0 };
}

async function getStreakData() {
  const { [STREAK_START_KEY]: streakStart, [LONGEST_STREAK_KEY]: longestStreak } = 
    await browserAPI.storage.local.get([STREAK_START_KEY, LONGEST_STREAK_KEY]);
  return {
    streakStart: streakStart || null,
    longestStreak: longestStreak || 0
  };
}

async function getTopDomains() {
  const { [TOP_DOMAINS_KEY]: topDomains } = await browserAPI.storage.local.get(TOP_DOMAINS_KEY);
  return topDomains || {};
}

async function getDailyHistory() {
  const { [DAILY_HISTORY_KEY]: history } = await browserAPI.storage.local.get(DAILY_HISTORY_KEY);
  return history || {};
}

async function getRecentActivity() {
  const { [AUDIT_BLOCKED_KEY]: blockedLog } = await browserAPI.storage.local.get(AUDIT_BLOCKED_KEY);
  return blockedLog || [];
}

function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

function renderStreak(streakData) {
  const banner = $('streak-banner');
  const currentStreakEl = $('current-streak');
  const longestStreakEl = $('longest-streak');
  const startDateEl = $('streak-start-date');

  if (!streakData.streakStart) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  const currentStreak = getDaysBetween(streakData.streakStart, Date.now());
  currentStreakEl.textContent = currentStreak;
  longestStreakEl.textContent = `${streakData.longestStreak || currentStreak} days`;
  startDateEl.textContent = `Started ${formatDate(streakData.streakStart)}`;
}

function renderStats(stats) {
  $('total-blocked').textContent = formatNumber(stats.blockedCount || 0);
  $('websites-blocked').textContent = formatNumber(stats.websiteBlockedCount || 0);
  $('images-filtered').textContent = formatNumber(stats.imageBlockedCount || 0);
  $('search-filtered').textContent = formatNumber(stats.searchResultBlockedCount || 0);
  
  const timeSavedMinutes = (stats.blockedCount || 0) * AVG_TIME_PER_BLOCK_MINUTES;
  $('time-saved').textContent = formatTimeSaved(timeSavedMinutes);
}

function renderChart(dailyHistory) {
  const chartBars = $('chart-bars');
  const chartLabels = $('chart-labels');
  chartBars.innerHTML = '';
  chartLabels.innerHTML = '';

  const today = new Date();
  const last7Days = [];
  const values = [];
  let maxValue = 1;

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().slice(0, 10);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    
    last7Days.push({ key: dateKey, label: dayName });
    const value = dailyHistory[dateKey] || 0;
    values.push(value);
    if (value > maxValue) maxValue = value;
  }

  last7Days.forEach((day, index) => {
    const value = values[index];
    const heightPercent = maxValue > 0 ? (value / maxValue) * 100 : 0;
    const height = Math.max(4, heightPercent * 1.6);

    const wrapper = document.createElement('div');
    wrapper.className = 'chart-bar-wrapper';

    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = `${height}px`;

    if (value > 0) {
      const tooltip = document.createElement('div');
      tooltip.className = 'chart-bar-tooltip';
      tooltip.textContent = value.toString();
      bar.appendChild(tooltip);
    }

    wrapper.appendChild(bar);
    chartBars.appendChild(wrapper);

    const label = document.createElement('div');
    label.className = 'chart-label';
    label.textContent = day.label;
    chartLabels.appendChild(label);
  });
}

function renderTopDomains(topDomains) {
  const container = $('top-sites');
  const entries = Object.entries(topDomains).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎉</div>
        <div class="empty-state-text">No sites blocked yet. Keep up the great work!</div>
      </div>
    `;
    return;
  }

  container.innerHTML = entries.map(([domain, count], index) => `
    <div class="top-site-item">
      <div class="top-site-info">
        <div class="top-site-rank">${index + 1}</div>
        <div class="top-site-domain" title="${domain}">${domain}</div>
      </div>
      <div class="top-site-count">${count}x</div>
    </div>
  `).join('');
}

function renderRecentActivity(activity) {
  const container = $('activity-list');

  if (activity.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No recent activity to display.</div>
      </div>
    `;
    return;
  }

  const recentItems = activity.slice(-20).reverse();

  container.innerHTML = recentItems.map(item => {
    const domain = extractDomain(item.url);
    const timeAgo = getTimeAgo(item.timestamp);
    
    return `
      <div class="activity-item">
        <div class="activity-info">
          <div class="activity-icon blocked">🚫</div>
          <div>
            <div class="activity-domain" title="${domain}">${domain}</div>
            <div class="activity-time">${timeAgo}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(timestamp);
}

function renderQuote() {
  const quote = getRandomQuote();
  $('quote-text').textContent = `"${quote.text}"`;
  $('quote-author').textContent = `— ${quote.author}`;
}

async function init() {
  try {
    const [stats, streakData, topDomains, dailyHistory, recentActivity] = await Promise.all([
      getStats(),
      getStreakData(),
      getTopDomains(),
      getDailyHistory(),
      getRecentActivity()
    ]);

    renderStreak(streakData);
    renderStats(stats);
    renderChart(dailyHistory);
    renderTopDomains(topDomains);
    renderRecentActivity(recentActivity);
    renderQuote();

  } catch (error) {
    console.error('BlockNSFW stats: Error loading data', error);
  }
}

document.addEventListener('DOMContentLoaded', init);
