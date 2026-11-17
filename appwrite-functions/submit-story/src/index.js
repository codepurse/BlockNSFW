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
// each page served is kept in this container's memory, and a request inside a
// kept window is served from it (the extension's 50-story shelf also answers
// the 10-story feed pages).
//
// A kept page answers only while no story has changed since it was read: each
// request first reads the most recently changed story (one read), and an
// approval, report or new submission moves that on. A page kept across an
// approval would sit still while "Load more" reads the shifted feed, and repeat
// a story, which app 1.19.0 crashes on. Deleting doesn't move it, so
// FEED_TTL_MS bounds how long a deleted story can still show. A like moves it
// too, but the kept pages take the new count instead (keepPagesThroughLike).
//
// Module scope survives between executions only while Appwrite keeps this
// container warm. A request whose page has to be read costs one read more than
// before the cache; one served from it costs one read instead of the page.
const FEED_TTL_MS = 30 * 60 * 1000;   // how long a story deleted in the console can still show
const FEED_CACHE_MAX = 20;            // windows kept; oldest goes first
const feedCache = new Map();          // `${offset}:${limit}` → { offset, stories, total, at, version }

// Which change the stories are at: the most recently changed one. One read.
async function feedVersion(databases, dbId, collId) {
  const list = await databases.listDocuments(dbId, collId, [
    Query.orderDesc('$updatedAt'),
    Query.limit(1),
  ]);
  const last = list.documents[0];
  return last ? `${last.$updatedAt} ${last.$id}` : '';
}

function cachedFeedPage(offset, limit, now, version) {
  for (const [key, e] of feedCache) {
    if (now - e.at >= FEED_TTL_MS || e.version !== version) {
      feedCache.delete(key);
      continue;
    }
    const end = e.offset + e.stories.length;
    // Starts at or after the window's start, and the window holds all of it or
    // the feed ends there (past the end is an empty page, still free).
    if (e.offset <= offset && (offset + limit <= end || end >= e.total)) {
      const from = offset - e.offset;
      return { stories: e.stories.slice(from, from + limit), total: e.total };
    }
  }
  return null;
}

function rememberFeedPage(offset, limit, stories, total, now, version) {
  const key = `${offset}:${limit}`;
  feedCache.delete(key);
  if (feedCache.size >= FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value);
  feedCache.set(key, { offset, stories, total, at: now, version });
}

// A like changes one number on one story and leaves the feed's order and
// length alone, so the kept pages take the new count instead of being read
// again. Only when the like is the one change since they were read: one read
// lists the stories changed after their version, and anything else there (an
// approval in the console, a like another copy of this function saved) leaves
// them to be read again. Called after the like is saved; no read if nothing is
// kept.
async function keepPagesThroughLike(databases, dbId, collId, storyId, likes, now) {
  let version = '';
  for (const e of feedCache.values()) {
    if (now - e.at < FEED_TTL_MS && e.version > version) version = e.version;
  }
  if (!version) return false;
  const since = version.slice(0, version.indexOf(' '));
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

      const list = await databases.listDocuments(dbId, collId, [
        Query.equal('status', 'approved'),
        Query.orderDesc('$createdAt'),
        Query.limit(limit),
        Query.offset(offset),
      ]);
      // Only expose public fields — deviceId/browser/version stay private.
      const stories = list.documents.map((d) => ({
        id: d.$id,
        title: d.title || '',
        content: d.content || '',
        likes: d.likes || 0,
        createdAt: d.$createdAt,
      }));
      rememberFeedPage(offset, limit, stories, list.total, now, version);
      log(`Feed ${offset}:${limit} read ${stories.length} stories`);
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
          if (await keepPagesThroughLike(databases, dbId, collId, storyId, likes, Date.now())) {
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
