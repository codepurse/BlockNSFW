const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../shared/gateways.js');

const ALL_ON = { gateways: G.BUILT_IN.map((g) => g.id) };

test('every built-in gateway is off until chosen', () => {
  assert.equal(G.count({}), 0);
  assert.equal(G.match('https://www.instagram.com/explore/', {}), null);
  assert.equal(G.match('https://www.reddit.com/', {}), null);
});

test('each built-in gateway matches its own pages and nothing next door', () => {
  const hit = (href) => (G.match(href, ALL_ON) || {}).key || null;
  assert.equal(hit('https://www.instagram.com/explore/'), 'instagram-explore');
  assert.equal(hit('https://www.instagram.com/explore/tags/x/'), 'instagram-explore');
  assert.equal(hit('https://www.instagram.com/'), null, 'the feed is not Explore');
  assert.equal(hit('https://www.instagram.com/explorer_profile/'), null, 'a profile that starts with the word');
  assert.equal(hit('https://old.reddit.com/r/all'), 'reddit');
  assert.equal(hit('https://notreddit.com/'), null);
  assert.equal(hit('https://www.google.com/search?q=a&tbm=isch'), 'image-search');
  assert.equal(hit('https://www.google.co.uk/search?q=a&udm=2'), 'image-search');
  assert.equal(hit('https://www.google.com/search?q=a'), null, 'web results are not image search');
  assert.equal(hit('https://www.bing.com/images/search?q=a'), 'image-search');
  assert.equal(hit('https://duckduckgo.com/?q=a&iax=images&ia=images'), 'image-search');
  assert.equal(hit('https://x.com/search?q=a'), 'x-search');
  assert.equal(hit('https://twitter.com/explore'), 'x-search');
  assert.equal(hit('https://x.com/someone'), null);
  assert.equal(hit('https://www.tiktok.com/@someone'), 'tiktok');
  assert.equal(hit('https://www.youtube.com/shorts/abc'), 'youtube-shorts');
  assert.equal(hit('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(hit('chrome-extension://abc/options.html'), null);
});

test('only the gateways turned on count', () => {
  const settings = { gateways: ['reddit'] };
  assert.equal(G.match('https://www.reddit.com/', settings).key, 'reddit');
  assert.equal(G.match('https://www.tiktok.com/', settings), null);
  assert.equal(G.count({ gateways: ['reddit', 'reddit', 'nope'] }), 1, 'duplicates and unknown ids drop');
});

test('a site of your own: the whole site, or one part of it', () => {
  assert.equal(G.normalizeCustom('https://www.Example.com/'), 'example.com');
  assert.equal(G.normalizeCustom('example.com/Gallery/'), 'example.com/gallery');
  assert.equal(G.normalizeCustom('example.com/a?b=c#d'), 'example.com/a');
  assert.equal(G.normalizeCustom('not a site'), null);
  assert.equal(G.normalizeCustom(''), null);
  const settings = { gatewaysCustom: ['example.com/gallery', 'other.org'] };
  assert.equal(G.match('https://example.com/gallery/12', settings).key, 'custom:example.com/gallery');
  assert.equal(G.match('https://example.com/about', settings), null);
  assert.equal(G.match('https://m.other.org/x', settings).name, 'other.org');
});

test('the pause is one of the offered lengths, ten seconds unless chosen', () => {
  assert.equal(G.normalizeSettings({}).pause, 10);
  assert.equal(G.normalizeSettings({ gatewayPauseSeconds: 30 }).pause, 30);
  assert.equal(G.normalizeSettings({ gatewayPauseSeconds: 2 }).pause, 10);
});

test('Go on opens a gateway for fifteen minutes, then the pause comes back', () => {
  const now = 1_000_000;
  const passes = G.addPass({}, 'reddit', now);
  assert.equal(G.passValid(passes, 'reddit', now + 60_000), true);
  assert.equal(G.passValid(passes, 'tiktok', now + 60_000), false);
  assert.equal(G.passValid(passes, 'reddit', now + G.PASS_MS + 1), false);
  assert.equal(G.passValid({ reddit: now + 10 * G.PASS_MS }, 'reddit', now), false,
    'a pass longer than the rule allows is not honoured');
});

test('Not tonight is counted, by gateway and by hour', () => {
  const at = new Date(2026, 9, 9, 23, 30).getTime();
  let stops = G.addStop(undefined, 'reddit', at);
  stops = G.addStop(stops, 'reddit', at);
  assert.equal(G.pattern(stops), null, 'two is not a pattern yet');
  stops = G.addStop(stops, 'instagram-explore', at);
  assert.equal(stops.total, 3);
  assert.deepEqual(G.pattern(stops), { key: 'reddit', name: 'Reddit', hour: 23 });
  assert.equal(G.normalizeStops({ total: -4, byKey: { a: 'x' } }).total, 0);
});

test('the last few stops keep their time, oldest first', () => {
  let stops;
  for (let i = 1; i <= G.RECENT_MAX + 3; i++) stops = G.addStop(stops, i % 2 ? 'reddit' : 'tiktok', i * 1000);
  assert.equal(stops.total, G.RECENT_MAX + 3);
  assert.equal(stops.recent.length, G.RECENT_MAX);
  assert.deepEqual(stops.recent[0], { key: 'tiktok', at: 4000 });
  assert.deepEqual(stops.recent[G.RECENT_MAX - 1], { key: 'reddit', at: (G.RECENT_MAX + 3) * 1000 });
  const odd = G.normalizeStops({ recent: [{ key: 'a', at: 5 }, null, { key: 7, at: 1 }, { key: 'b', at: 'x' }, { key: 'c', at: 2 }] });
  assert.deepEqual(odd.recent, [{ key: 'c', at: 2 }, { key: 'a', at: 5 }]);
  assert.deepEqual(G.normalizeStops(undefined).recent, []);
});

test('the sites where a gateway lives are watched, and only those', () => {
  const settings = { gateways: ['instagram-explore'], gatewaysCustom: ['example.org/gallery'] };
  assert.equal(G.onGatewaySite('https://www.instagram.com/', settings), true, 'the feed can move into Explore');
  assert.equal(G.onGatewaySite('https://example.org/', settings), true);
  assert.equal(G.onGatewaySite('https://www.reddit.com/', settings), false, 'reddit is not turned on');
  assert.equal(G.onGatewaySite('https://news.example.com/', settings), false);
  assert.equal(G.onGatewaySite('https://duckduckgo.com/?q=a', { gateways: ['image-search'] }), true);
});
