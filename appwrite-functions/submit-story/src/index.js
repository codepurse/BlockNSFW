const { Client, Databases, ID, Query } = require('node-appwrite');

// Server-side guard. Client limits in appwrite-client.js are bypassable, so
// we also rate-limit here by deviceId.
const SUBMISSION_LIMIT = 1;                 // max stories per device per window
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;  // rolling 1-week window
const DEFAULT_PAGE = 10;                    // approved stories per feed page
const MAX_PAGE = 50;                        // hard cap per request
const REPORT_HIDE_THRESHOLD = 3;            // distinct devices needed to auto-hide

// --- Feed cache ------------------------------------------------------------
// Appwrite bills one database read per document a query returns, and the free
// plan stops answering at 500K reads a month. In Nov 2026 the feed used all of
// it, and every app and extension user lost their stories until the reset. So
// the stories it reads are kept in this container's memory in blocks of
// FEED_BLOCK (the feed's 0-9, 10-19, ...), and a request whose stories are all
// in kept blocks is served from them. The apps ask for whole blocks (10 stories
// from 0, 10, 20...; the extension's shelf 50 from 0), and a request at any
// other offset or size is answered from the same blocks, so a script asking
// for odd windows can't keep the cache missing. A request past the end of the
// feed is answered from the feed's length without reading.
//
// A kept block answers only while no story has changed since it was read: each
// request first reads the most recently changed story (one read), and an
// approval, report or new submission moves that on. A page kept across an
// approval would sit still while "Load more" reads the shifted feed, and repeat
// a story, which app 1.19.0 crashes on. Deleting doesn't move it, so
// FEED_TTL_MS bounds how long a deleted story can still show. A like moves it
// too, but the kept pages take the new count instead (keepPagesThroughLike).
//
// Module scope survives between executions only while Appwrite keeps this
// container warm. A request whose blocks have to be read costs one read more
// than before the cache (an odd window reads its whole blocks, up to 18 more);
// one served from them costs one read instead of the page.
const FEED_TTL_MS = 30 * 60 * 1000;   // how long a story deleted in the console can still show
const FEED_BLOCK = 10;                // stories per kept block: the apps' page size
const FEED_CACHE_MAX = 100;           // blocks kept (1,000 stories); oldest goes first
const feedCache = new Map();          // block's first offset → { stories, at, version }
let feedTotal = null;                 // { total, at, version }: the feed's length at the latest read

// Which change the stories are at: the most recently changed one. One read.
async function feedVersion(databases, dbId, collId) {
  const list = await databases.listDocuments(dbId, collId, [
    Query.orderDesc('$updatedAt'),
    Query.limit(1),
  ]);
  const last = list.documents[0];
  return last ? `${last.$updatedAt} ${last.$id}` : '';
}

// The first offset of the block an offset falls in, and the end of the block
// the last story of a request falls in: the whole blocks a request needs.
const blockStart = (offset) => Math.floor(offset / FEED_BLOCK) * FEED_BLOCK;
const blockEnd = (offset, limit) => Math.ceil((offset + limit) / FEED_BLOCK) * FEED_BLOCK;

// The kept answer to a request, or null if a block it needs isn't kept.
function cachedFeedPage(offset, limit, now, version) {
  for (const [start, b] of feedCache) {
    if (now - b.at >= FEED_TTL_MS || b.version !== version) feedCache.delete(start);
  }
  if (!feedTotal || now - feedTotal.at >= FEED_TTL_MS || feedTotal.version !== version) return null;
  const { total } = feedTotal;
  const first = blockStart(offset);
  const run = [];
  for (let start = first; start < Math.min(offset + limit, total); start += FEED_BLOCK) {
    const block = feedCache.get(start);
    if (!block) return null;
    run.push(...block.stories);
  }
  return { stories: run.slice(offset - first, offset - first + limit), total };
}

// Keeps the stories a read returned, from offset `from` (a block's first), as
// blocks, and the feed's length.
function rememberFeedBlocks(from, stories, total, now, version) {
  feedTotal = { total, at: now, version };
  for (let i = 0; i < stories.length; i += FEED_BLOCK) {
    feedCache.delete(from + i);
    if (feedCache.size >= FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value);
    feedCache.set(from + i, { stories: stories.slice(i, i + FEED_BLOCK), at: now, version });
  }
}

// A like changes one number on one story and leaves the feed's order and
// length alone, so the kept pages take the new count instead of being read
// again. Only when the like is the one change since they were read: the liked
// story itself must not have changed since (hidden by reports, approved or
// unapproved in the console, all of which move its place in the feed; a phone
// can still show a hidden story and take a like on it), and one read lists the
// stories changed after their version, where anything else (an approval, a
// like another copy of this function saved) leaves them to be read again.
// Called after the like is saved with the story's $updatedAt from before it;
// no read if nothing is kept.
async function keepPagesThroughLike(databases, dbId, collId, storyId, lastChanged, likes, now) {
  let version = '';
  for (const e of feedCache.values()) {
    if (now - e.at < FEED_TTL_MS && e.version > version) version = e.version;
  }
  if (!version) return false;
  const since = version.slice(0, version.indexOf(' '));
  if (!lastChanged || lastChanged > since) return false;
  const changed = await databases.listDocuments(dbId, collId, [
    Query.greaterThan('$updatedAt', since),
    Query.limit(2),
  ]);
  const only = changed.documents[0];
  if (changed.total !== 1 || !only || only.$id !== storyId) return false;
  const next = `${only.$updatedAt} ${only.$id}`;
  for (const e of feedCache.values()) {
    if (e.version !== version) continue;
    // A new array of new objects: a page already handed out stays as it was.
    e.stories = e.stories.map((s) => (s.id === storyId ? { ...s, likes } : s));
    e.version = next;
  }
  if (feedTotal && feedTotal.version === version) feedTotal.version = next;
  return true;
}

function makeDatabases() {
  const client = new Client()
    // Endpoint + project are auto-injected by Appwrite; fall back if not.
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  return new Databases(client);
}

module.exports = async ({ req, res, log, error }) => {
  const databases = makeDatabases();
  // Match the variable names used by the reports function.
  const dbId = process.env.DATABASE_ID || process.env.APPWRITE_DATABASE_ID;
  const collId = process.env.COLLECTION_ID || process.env.APPWRITE_COLLECTION_ID;

  const method = String(req.method || '').toUpperCase();

  try {
    // --- GET: return the approved feed (public, read-only) -----------------
    if (method === 'GET') {
      const q = req.query || {};
      const limit = Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_PAGE, 1), MAX_PAGE);
      const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
      const now = Date.now();
      // Read before the page, so a change made while it's read shows up as a
      // newer version next time instead of being missed.
      const version = await feedVersion(databases, dbId, collId);

      const kept = cachedFeedPage(offset, limit, now, version);
      if (kept) {
        log(`Feed ${offset}:${limit} from cache`);
        return res.json({ ok: true, stories: kept.stories, total: kept.total }, 200, {
          'Cache-Control': 'public, max-age=60',
        });
      }

      // Read every block the request needs in one query, kept or not, so an
      // answer never mixes kept stories with ones read now.
      const from = blockStart(offset);
      const list = await databases.listDocuments(dbId, collId, [
        Query.equal('status', 'approved'),
        Query.orderDesc('$createdAt'),
        Query.limit(blockEnd(offset, limit) - from),
        Query.offset(from),
      ]);
      // Only expose public fields — deviceId/browser/version stay private.
      const read = list.documents.map((d) => ({
        id: d.$id,
        title: d.title || '',
        content: d.content || '',
        likes: d.likes || 0,
        createdAt: d.$createdAt,
      }));
      rememberFeedBlocks(from, read, list.total, now, version);
      const stories = read.slice(offset - from, offset - from + limit);
      log(`Feed ${offset}:${limit} read ${read.length} stories`);
      return res.json({ ok: true, stories, total: list.total }, 200, {
        'Cache-Control': 'public, max-age=60',
      });
    }

    // --- POST: like a story, or submit a new one ---------------------------
    if (method === 'POST') {
      // Works whether the runtime hands back a parsed object or a raw string.
      const payload =
        req.body && typeof req.body === 'object'
          ? req.body
          : JSON.parse(req.bodyRaw || req.body || '{}');

      // Like / unlike an existing story — deduped per device via likedBy.
      if (payload.action === 'like') {
        const storyId = String(payload.storyId || '');
        const liker = String(payload.deviceId || '').slice(0, 64);
        if (!storyId) {
          return res.json({ ok: false, message: 'Missing storyId.' }, 400);
        }
        if (!liker) {
          return res.json({ ok: false, message: 'Missing deviceId.' }, 400);
        }

        const doc = await databases.getDocument(dbId, collId, storyId);
        const likedBy = Array.isArray(doc.likedBy) ? doc.likedBy.slice() : [];
        const has = likedBy.includes(liker);
        const wantLike = payload.like !== false;

        // Already in the desired state → no write (cheap; blocks like-spam).
        if (wantLike === has) {
          return res.json({ ok: true, likes: Number(doc.likes) || 0 });
        }

        let likes = Number(doc.likes) || 0;
        if (wantLike) {
          likedBy.push(liker);
          likes += 1;
        } else {
          const i = likedBy.indexOf(liker);
          if (i !== -1) likedBy.splice(i, 1);
          likes = Math.max(0, likes - 1);
        }

        const updated = await databases.updateDocument(dbId, collId, storyId, { likes, likedBy });
        likes = Number(updated.likes) || 0;
        try {
          if (await keepPagesThroughLike(databases, dbId, collId, storyId, doc.$updatedAt, likes, Date.now())) {
            log(`Like on ${storyId} kept in the cached feed`);
          }
        } catch (e) {
          // The like is saved; the kept pages are just read again next time.
          log(`Cached feed not kept through a like: ${e.message}`);
        }
        return res.json({ ok: true, likes });
      }

      // Report a story as inappropriate — deduped per device via reportedBy.
      // Auto-hidden from the public feed once enough distinct devices flag it,
      // pending a human review that flips status back to approved or leaves it hidden.
      if (payload.action === 'report') {
        const storyId = String(payload.storyId || '');
        const reporter = String(payload.deviceId || '').slice(0, 64);
        if (!storyId) {
          return res.json({ ok: false, message: 'Missing storyId.' }, 400);
        }

        const doc = await databases.getDocument(dbId, collId, storyId);
        const reportedBy = Array.isArray(doc.reportedBy) ? doc.reportedBy.slice() : [];

        // A device reporting the same story twice must not inflate the count.
        if (reporter && !reportedBy.includes(reporter)) {
          reportedBy.push(reporter);
        }
        const reportCount = reportedBy.length;

        const patch = { reportCount, reportedBy };
        if (reportCount >= REPORT_HIDE_THRESHOLD && doc.status === 'approved') {
          patch.status = 'hidden';   // drops out of the approved feed for everyone
        }

        await databases.updateDocument(dbId, collId, storyId, patch);
        log(`Story reported: ${storyId} (count=${reportCount})`);
        return res.json({ ok: true });
      }

      const { title, content, deviceId, browser, version } = payload;

      const cleanContent = String(content || '').trim();
      if (cleanContent.length < 20) {
        return res.json({ ok: false, message: 'Story content must be at least 20 characters.' }, 400);
      }

      // Server-side weekly limit per device (best-effort anti-spam).
      if (deviceId) {
        const since = new Date(Date.now() - WINDOW_MS).toISOString();
        const recent = await databases.listDocuments(dbId, collId, [
          Query.equal('deviceId', String(deviceId)),
          Query.greaterThanEqual('$createdAt', since),
          Query.limit(SUBMISSION_LIMIT),
        ]);
        if (recent.total >= SUBMISSION_LIMIT) {
          return res.json({ ok: false, message: 'You can share one story per week. Please try again later.' }, 429);
        }
      }

      const doc = await databases.createDocument(dbId, collId, ID.unique(), {
        title: String(title || '').trim().slice(0, 120),
        content: cleanContent.slice(0, 2000),
        status: 'pending',          // forced — never trust client status
        likes: 0,
        deviceId: String(deviceId || '').slice(0, 64),
        browser: String(browser || '').slice(0, 32),
        version: String(version || '').slice(0, 32),
      });

      log(`Story submitted: ${doc.$id}`);
      return res.json({ ok: true, message: 'Story submitted for review.', documentId: doc.$id });
    }

    log(`Unhandled method: "${method}"`);
    return res.json({ ok: false, message: 'Method not allowed' }, 405);
  } catch (err) {
    error(err.message || 'Unknown error');             // full detail in logs
    return res.json({ ok: false, message: 'Something went wrong. Please try again.' }, 500); // generic to client
  }
};
