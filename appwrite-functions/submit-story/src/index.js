const { Client, Databases, ID, Query } = require('node-appwrite');

// Server-side guard. Client limits in appwrite-client.js are bypassable, so
// we also rate-limit here by deviceId.
const SUBMISSION_LIMIT = 1;                 // max stories per device per window
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;  // rolling 1-week window
const DEFAULT_PAGE = 10;                    // approved stories per feed page
const MAX_PAGE = 50;                        // hard cap per request
const REPORT_HIDE_THRESHOLD = 3;            // distinct devices needed to auto-hide

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
        return res.json({ ok: true, likes: Number(updated.likes) || 0 });
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
