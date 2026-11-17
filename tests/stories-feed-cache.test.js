// The stories function keeps the feed pages it served (submit-story/src/index.js).
//
// Appwrite bills one database read per document a query returns, and the feed
// used up the free plan's 500K a month. The function now keeps each page it
// serves in memory and serves it again while no story has changed, which costs
// one read to check instead of the page. A like, the commonest change, is put
// into the kept pages instead of dropping them. These tests run it against a fake
// database that counts billed reads, and check each kept answer against a
// freshly loaded copy of the function, which has nothing kept and so answers
// as the function did before it kept pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fixtures', 'fake-node-appwrite.js');
const FUNCTION = path.join(__dirname, '..', 'appwrite-functions', 'submit-story', 'src', 'index.js');

// The function requires node-appwrite, which is installed only on Appwrite.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'node-appwrite' ? FAKE : resolveFilename.call(this, request, ...rest);
};
const db = require(FAKE).state;

const MIN = 60 * 1000;
const START = Date.parse('2026-11-18T00:00:00Z');
const realNow = Date.now;
let clock = START;
Date.now = () => clock;

process.env.DATABASE_ID = 'db';
process.env.COLLECTION_ID = 'stories';

// A cold start: a new copy of the function with nothing kept.
function coldStart() {
  delete require.cache[require.resolve(FUNCTION)];
  return require(FUNCTION);
}

// Stories s0 (oldest) to s{count-1} (newest), all approved.
function seed(count) {
  const stories = new Map();
  for (let i = 0; i < count; i++) {
    stories.set(`s${i}`, story(`s${i}`, Date.parse('2026-10-01T00:00:00Z') + i * MIN));
  }
  db.collections.clear();
  db.collections.set('stories', stories);
}

function story(id, createdAt, status = 'approved') {
  return {
    $id: id,
    $createdAt: new Date(createdAt).toISOString(),
    $updatedAt: new Date(createdAt).toISOString(),
    status,
    title: `Story ${id}`,
    content: `The words of story ${id}, long enough to share.`,
    likes: 0,
    likedBy: [],
    reportedBy: [],
    deviceId: `device-${id}`,
  };
}

// Approving a story in the console, as Appwrite records it.
function approveInConsole(id) {
  const doc = db.collections.get('stories').get(id);
  doc.status = 'approved';
  doc.$updatedAt = new Date(clock).toISOString();
}

let logs = [];
const errors = [];

async function call(fn, req) {
  let out;
  const res = { json: (body, status = 200, headers = {}) => (out = { body, status, headers }) };
  await fn({ req, res, log: (m) => logs.push(m), error: (m) => errors.push(m) });
  return out;
}

const feed = (fn, offset, limit) =>
  call(fn, { method: 'GET', query: { offset: String(offset), limit: String(limit) } });
// Each change lands a second after the last, so it gets its own $updatedAt, as
// real ones do (Appwrite keeps milliseconds).
const post = (fn, body) => {
  clock += 1000;
  return call(fn, { method: 'POST', body });
};

// The answer, and the reads it cost.
async function measured(fn, offset, limit) {
  const before = db.reads;
  const answer = await feed(fn, offset, limit);
  return { answer, reads: db.reads - before };
}

// What a function with nothing kept answers right now; its reads don't count.
async function uncached(offset, limit) {
  const before = db.reads;
  const answer = await feed(coldStart(), offset, limit);
  db.reads = before;
  return answer;
}

const ids = (...answers) => answers.flatMap((a) => a.body.stories.map((s) => s.id));

test.beforeEach(() => {
  clock = START;
  logs = [];
  errors.length = 0;
});

test.afterEach(() => {
  assert.deepEqual(errors, []);
});

test.after(() => {
  Date.now = realNow;
  Module._resolveFilename = resolveFilename;
});

test('an unchanged page costs one read, and is read again after 30 minutes', async () => {
  seed(30);
  const fn = coldStart();
  const first = await measured(fn, 0, 10);
  assert.equal(first.reads, 11);

  clock = START + 29 * MIN;
  const repeat = await measured(fn, 0, 10);
  assert.equal(repeat.reads, 1);
  assert.deepEqual(repeat.answer, first.answer);

  clock = START + 30 * MIN;
  assert.equal((await measured(fn, 0, 10)).reads, 11);
});

test('the 50-story shelf also answers the 10-story pages inside it', async () => {
  seed(80);
  const fn = coldStart();
  assert.equal((await measured(fn, 0, 50)).reads, 51);

  for (const [offset, limit] of [[0, 10], [10, 10], [40, 10], [5, 3]]) {
    const page = await measured(fn, offset, limit);
    assert.equal(page.reads, 1, `offset ${offset}, limit ${limit}`);
    assert.deepEqual(page.answer, await uncached(offset, limit));
  }

  // Past the kept stories but not the end of the feed: read as before.
  const beyond = await measured(fn, 45, 10);
  assert.equal(beyond.reads, 11);
  assert.deepEqual(beyond.answer, await uncached(45, 10));
});

test('a feed kept whole answers a page past its end', async () => {
  seed(5);
  const fn = coldStart();
  assert.equal((await measured(fn, 0, 50)).reads, 6);
  const past = await measured(fn, 10, 10);
  assert.equal(past.reads, 1);
  assert.deepEqual(past.answer, await uncached(10, 10));
});

test('a page kept from further down does not answer the first page', async () => {
  seed(40);
  const fn = coldStart();
  assert.equal((await measured(fn, 10, 10)).reads, 11);
  assert.equal((await measured(fn, 15, 5)).reads, 1);
  const first = await measured(fn, 0, 10);
  assert.equal(first.reads, 11);
  assert.deepEqual(first.answer, await uncached(0, 10));
});

test('a cold start reads one more than the function read before it kept pages', async () => {
  seed(30);
  for (const [offset, limit, reads] of [[0, 10, 11], [0, 50, 31], [10, 10, 11], [40, 10, 2]]) {
    assert.equal((await measured(coldStart(), offset, limit)).reads, reads, `offset ${offset}, limit ${limit}`);
  }
});

test('a story approved after page 1 was kept does not repeat on the next page', async () => {
  // App 1.19.0 appends "Load more" pages without dropping repeats, and its list
  // crashes on two stories with one id.
  seed(30);
  db.collections.get('stories').set('waiting', story('waiting', START - 60 * MIN, 'pending'));
  const fn = coldStart();
  await feed(fn, 0, 10);                  // someone opens Stories; page 1 is kept

  clock = START + 2 * MIN;
  approveInConsole('waiting');            // written an hour ago, so it lands on top

  clock = START + 5 * MIN;
  const page1 = await feed(fn, 0, 10);    // someone else opens Stories
  clock = START + 6 * MIN;
  const page2 = await feed(fn, 10, 10);   // and taps "Load more"

  const seen = ids(page1, page2);
  assert.equal(new Set(seen).size, seen.length, `repeated: ${seen.join(' ')}`);
  assert.equal(seen[0], 'waiting');
  assert.deepEqual(page1, await uncached(0, 10));
});

test('a like is shown on the next load', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);
  await feed(fn, 0, 50);

  const liked = await post(fn, { action: 'like', storyId: 's29', like: true, deviceId: 'phone-a' });
  assert.equal(liked.body.likes, 1);
  for (const [offset, limit] of [[0, 10], [0, 50]]) {
    const page = await feed(fn, offset, limit);
    assert.equal(page.body.stories[0].likes, 1);
    assert.deepEqual(page, await uncached(offset, limit));
  }

  await post(fn, { action: 'like', storyId: 's29', like: false, deviceId: 'phone-a' });
  assert.deepEqual(await feed(fn, 0, 10), await uncached(0, 10));
});

test('a like keeps the kept pages, with the new count', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);
  await feed(fn, 0, 50);

  const before = db.reads;
  const liked = await post(fn, { action: 'like', storyId: 's25', like: true, deviceId: 'phone-a' });
  assert.equal(liked.body.likes, 1);
  assert.equal(db.reads - before, 2, 'the story, and what changed since the pages were read');
  assert.ok(logs.includes('Like on s25 kept in the cached feed'));

  for (const [offset, limit] of [[0, 10], [0, 50], [2, 5]]) {
    const page = await measured(fn, offset, limit);
    assert.equal(page.reads, 1, `offset ${offset}, limit ${limit}`);
    assert.deepEqual(page.answer, await uncached(offset, limit));
  }

  await post(fn, { action: 'like', storyId: 's25', like: false, deviceId: 'phone-a' });
  const unliked = await measured(fn, 0, 10);
  assert.equal(unliked.reads, 1);
  assert.deepEqual(unliked.answer, await uncached(0, 10));
});

test('likes one after another all land in the kept pages', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);
  for (const [storyId, deviceId] of [['s29', 'a'], ['s28', 'b'], ['s29', 'c']]) {
    await post(fn, { action: 'like', storyId, like: true, deviceId });
  }
  const page = await measured(fn, 0, 10);
  assert.equal(page.reads, 1);
  assert.deepEqual(page.answer.body.stories.slice(0, 2).map((s) => s.likes), [2, 1]);
  assert.deepEqual(page.answer, await uncached(0, 10));
});

test('a page handed out before a like stays as it was sent', async () => {
  seed(30);
  const fn = coldStart();
  const sent = await feed(fn, 0, 10);
  const copy = structuredClone(sent.body);
  await post(fn, { action: 'like', storyId: 's29', like: true, deviceId: 'a' });
  assert.deepEqual(sent.body, copy);
});

test('a like after an approval leaves the pages to be read again, and nothing repeats', async () => {
  seed(30);
  db.collections.get('stories').set('waiting', story('waiting', START - 60 * MIN, 'pending'));
  const fn = coldStart();
  await feed(fn, 0, 10);

  clock = START + 2 * MIN;
  approveInConsole('waiting');
  await post(fn, { action: 'like', storyId: 's29', like: true, deviceId: 'phone-a' });
  assert.ok(!logs.some((m) => m.startsWith('Like on')));

  const page1 = await measured(fn, 0, 10);
  assert.equal(page1.reads, 11);
  assert.deepEqual(page1.answer, await uncached(0, 10));
  const page2 = await feed(fn, 10, 10);
  const seen = ids(page1.answer, page2);
  assert.equal(new Set(seen).size, seen.length, `repeated: ${seen.join(' ')}`);
  assert.equal(seen[0], 'waiting');
});

test('a like costs no extra read when nothing is kept', async () => {
  seed(30);
  const fn = coldStart();
  let before = db.reads;
  await post(fn, { action: 'like', storyId: 's29', like: true, deviceId: 'a' });
  assert.equal(db.reads - before, 1);

  await feed(fn, 0, 10);
  clock = START + 31 * MIN;               // the kept page has expired
  before = db.reads;
  await post(fn, { action: 'like', storyId: 's28', like: true, deviceId: 'a' });
  assert.equal(db.reads - before, 1);
});

test('a story hidden by reports leaves the feed on the next load', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);

  for (const device of ['a', 'b']) await post(fn, { action: 'report', storyId: 's29', deviceId: device });
  assert.deepEqual(await feed(fn, 0, 10), await uncached(0, 10));

  await post(fn, { action: 'report', storyId: 's29', deviceId: 'c' });
  const after = await feed(fn, 0, 10);
  assert.ok(!ids(after).includes('s29'));
  assert.deepEqual(after, await uncached(0, 10));
});

test('a story deleted in the console shows until the kept page expires, and nothing repeats', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);
  db.collections.get('stories').delete('s25');

  clock = START + 5 * MIN;
  const page1 = await feed(fn, 0, 10);
  const page2 = await feed(fn, 10, 10);
  assert.ok(ids(page1).includes('s25'));
  const seen = ids(page1, page2);
  assert.equal(new Set(seen).size, seen.length, `repeated: ${seen.join(' ')}`);

  clock = START + 30 * MIN;
  assert.ok(!ids(await feed(fn, 0, 10)).includes('s25'));
});

test('the log says whether a page came from the cache or the database', async () => {
  seed(30);
  const fn = coldStart();
  await feed(fn, 0, 10);
  await feed(fn, 0, 10);
  assert.deepEqual(logs, ['Feed 0:10 read 10 stories', 'Feed 0:10 from cache']);
});
