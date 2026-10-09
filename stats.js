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
const TOP_SITES_LIMIT = 10;
const RECENT_LIMIT = 20;

const LOAD_FAILED = 'That didn’t load. Reload the page to try again.';

function $(id) { return document.getElementById(id); }

// Exact figures with the reader's own separators: 12,345 rather than 12.3K.
function formatNumber(num) {
  const n = Number(num) || 0;
  try { return n.toLocaleString(); } catch (_) { return String(n); }
}

function formatDays(days) {
  return `${formatNumber(days)} ${days === 1 ? 'day' : 'days'}`;
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

// The hostname of a blocked page and nothing else: never its scheme, path,
// query or fragment, which can say what the page was.
function extractDomain(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = String(url || '').trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[\/?#]/)[0]
      .replace(/^[^@]*@/, '')
      .replace(/:\d*$/, '');
  }
  return host.replace(/^www\./i, '');
}

// --- Building rows ------------------------------------------------------------
//
// Every value is set with textContent. Hostnames come from storage that pages
// fed, so none of it is ever parsed as markup.

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function timeElement(timestamp, text, className) {
  const el = make('time', className, text);
  try { el.setAttribute('datetime', new Date(timestamp).toISOString()); } catch (_) {}
  return el;
}

function emptyItem(text) {
  return make('li', 'domain-empty', text);
}

function hostRow(host, side) {
  const row = make('li', 'domain-row');
  const main = make('div', 'domain-main');
  const name = make('span', 'domain', host || 'Unknown site');
  if (host) name.title = host;
  main.appendChild(name);
  row.appendChild(main);
  row.appendChild(side);
  return row;
}

// --- Sections -----------------------------------------------------------------

// Days kept leads (shared/moments.js): one bad night costs one day of the
// last 30, where a streak would have gone back to zero. The current run and
// the longest one are still there, second.
async function getKeptData() {
  const Moments = globalThis.Moments;
  if (!Moments) return null;
  const Gateways = globalThis.Gateways;
  const store = await browserAPI.storage.local.get([
    Moments.SLIPS_KEY, Moments.FIRST_SEEN_KEY, Moments.KEPT_KEY, 'pblocker_audit_disabled', 'pblocker_settings',
    Gateways ? Gateways.STOPS_KEY : 'pblocker_gateway_stops'
  ]);
  const settings = store.pblocker_settings || {};
  const stops = Gateways ? Gateways.normalizeStops(store[Gateways.STOPS_KEY]) : { total: 0 };
  return {
    days: Moments.daysKept({
      now: Date.now(),
      firstSeen: store[Moments.FIRST_SEEN_KEY],
      slips: store[Moments.SLIPS_KEY],
      disabledLog: store.pblocker_audit_disabled,
      currentlyEnabled: settings.enabled !== false
    }),
    moments: Moments.normalizeKept(store[Moments.KEPT_KEY]).count,
    stops: stops.total,
    stopPattern: Gateways ? Gateways.pattern(stops) : null
  };
}

function hourLabel(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

function renderStreak(streakData, kept) {
  const section = $('protection-section');
  if (!section) return;

  if (!streakData.streakStart && !kept) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const currentStreak = streakData.streakStart ? getDaysBetween(streakData.streakStart, Date.now()) : 0;
  $('current-streak').textContent = formatDays(currentStreak);
  $('longest-streak').textContent = formatDays(streakData.longestStreak || currentStreak);
  $('streak-start-date').textContent = streakData.streakStart ? `Since ${formatDate(streakData.streakStart)}` : '';

  if (kept) {
    $('days-kept').textContent = `${formatNumber(kept.days.kept)} of ${formatNumber(kept.days.counted)}`;
    $('days-kept-desc').textContent = kept.days.counted >= 30
      ? 'Protection on all day and no slip, in the last 30 days'
      : 'Protection on all day and no slip, since you started';
    const moments = $('kept-moments-record');
    if (moments) moments.hidden = kept.moments === 0;
    $('kept-moments').textContent = formatNumber(kept.moments);

    // Times someone chose Not tonight on a gateway's pause.
    const stopsRecord = $('gateway-stops-record');
    if (stopsRecord) {
      stopsRecord.hidden = !kept.stops;
      $('gateway-stops').textContent = formatNumber(kept.stops || 0);
      $('gateway-stops-desc').textContent = kept.stopPattern
        ? `Most often at ${kept.stopPattern.name}, around ${hourLabel(kept.stopPattern.hour)}`
        : 'Times you chose “Not tonight” on a gateway';
    }
  }
}

function renderStats(stats) {
  $('total-blocked').textContent = formatNumber(stats.blockedCount || 0);
  $('websites-blocked').textContent = formatNumber(stats.websiteBlockedCount || 0);
  $('images-filtered').textContent = formatNumber(stats.imageBlockedCount || 0);
  $('search-filtered').textContent = formatNumber(stats.searchResultBlockedCount || 0);

  const timeSavedMinutes = (stats.blockedCount || 0) * AVG_TIME_PER_BLOCK_MINUTES;
  $('time-saved').textContent = formatTimeSaved(timeSavedMinutes);
}

// The last seven days, oldest first, as seven bars on one baseline. Each day
// is read as its name and date, then its blocks; the bar is only the picture
// of the figure above it, so it is hidden from screen readers.
const WEEK_BAR_MAX = 156;

function renderChart(dailyHistory) {
  const list = $('week-list');
  if (!list) return;

  const today = new Date();
  const days = [];

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().slice(0, 10);
    days.push({ date, isToday: i === 0, value: dailyHistory[dateKey] || 0 });
  }

  const most = Math.max(1, ...days.map(day => day.value));

  list.replaceChildren(...days.map(({ date, isToday, value }) => {
    const item = make('li', isToday ? 'week-day is-today' : 'week-day');

    const name = make('span', 'meta week-name', date.toLocaleDateString('en-US', { weekday: 'short' }));
    name.appendChild(make('span', 'visually-hidden', `, ${formatDate(date)}: `));

    const plot = make('span', 'week-plot');
    const count = make('span', 'week-count', formatNumber(value));
    count.appendChild(make('span', 'visually-hidden', value === 1 ? ' block' : ' blocks'));
    plot.appendChild(count);
    if (value > 0) {
      const bar = make('span', 'week-bar');
      bar.setAttribute('aria-hidden', 'true');
      bar.style.height = `${Math.max(2, Math.round((value / most) * WEEK_BAR_MAX))}px`;
      plot.appendChild(bar);
    }

    item.appendChild(name);
    item.appendChild(plot);
    return item;
  }));
}

function renderTopDomains(topDomains) {
  const container = $('top-sites');
  const entries = Object.entries(topDomains).sort((a, b) => b[1] - a[1]).slice(0, TOP_SITES_LIMIT);

  if (entries.length === 0) {
    container.replaceChildren(emptyItem('Nothing has been blocked yet.'));
    return;
  }

  container.replaceChildren(...entries.map(([domain, count]) => {
    const n = Number(count) || 0;
    const tally = make('span', 'domain-count', `${formatNumber(n)} ${n === 1 ? 'block' : 'blocks'}`);
    return hostRow(String(domain), tally);
  }));
}

function renderRecentActivity(activity) {
  const container = $('activity-list');
  const items = Array.isArray(activity) ? activity : [];

  if (items.length === 0) {
    container.replaceChildren(emptyItem('No recent blocks.'));
    return;
  }

  const recentItems = items.slice(-RECENT_LIMIT).reverse();

  container.replaceChildren(...recentItems.map(item => {
    const domain = extractDomain(item && item.url);
    const when = timeElement(item && item.timestamp, getTimeAgo(item && item.timestamp), 'domain-count');
    return hostRow(domain, when);
  }));
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
  $('quote-text').textContent = quote.text;
  $('quote-author').textContent = `— ${quote.author}`;
}

// The index numerals count the sections on show, so hiding Protection never
// leaves the page starting at 02.
function numberSections() {
  let n = 0;
  document.querySelectorAll('.section').forEach((section) => {
    if (section.hidden) return;
    n += 1;
    const index = section.querySelector('.index');
    if (index) index.textContent = String(n).padStart(2, '0');
  });
}

function showAlert(message) {
  const el = $('stats-alert');
  if (el) el.textContent = message || '';
}

async function init() {
  try {
    const [stats, streakData, topDomains, dailyHistory, recentActivity, kept] = await Promise.all([
      getStats(),
      getStreakData(),
      getTopDomains(),
      getDailyHistory(),
      getRecentActivity(),
      getKeptData().catch(() => null)
    ]);

    renderStreak(streakData, kept);
    renderStats(stats);
    renderChart(dailyHistory);
    renderTopDomains(topDomains);
    renderRecentActivity(recentActivity);
    renderQuote();
    numberSections();

  } catch (error) {
    console.error('BlockNSFW stats: Error loading data', error);
    showAlert(LOAD_FAILED);
  }
}

document.addEventListener('DOMContentLoaded', init);
