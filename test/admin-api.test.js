import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { Cache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { distance } from '../src/geometry.js';

// Explicit fake configuration: never read .env, process.env, or real credentials.
const TOKEN = 'offline-admin-data-token-not-a-secret-0123456789';
const ADMIN = 'offline-admin-dashboard-token-not-a-secret-9876543210';
const GOLF_KEY = 'offline-admin-fake-golf-key';
const GPXZ_KEY = 'offline-admin-fake-gpxz-key';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ADMIN_AUTH = { authorization: `Bearer ${ADMIN}` };
const EPOCH = Date.parse('2026-10-23T12:00:00.000Z');
const DAY = 86400000;
const PATH = [{ lat: 57, lon: 12 }, { lat: 57.001, lon: 12.002 }];
const LEGACY_KEY = `gpxz:sample:v1:${'a'.repeat(64)}`;
const SECOND_KEY = `gpxz:sample:v1:${'b'.repeat(64)}`;
const SECRETS = [TOKEN, ADMIN, GOLF_KEY, GPXZ_KEY];
const originalFetch = globalThis.fetch;
let defaultFetchCalls = 0;
before(() => {
  globalThis.fetch = () => {
    defaultFetchCalls++;
    throw new Error('OFFLINE TEST: default fetch must not be used');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(defaultFetchCalls, 0, 'every provider call must use the injected fake');
});

function environment(dir, overrides = {}) {
  return { SERVER_API_TOKEN: TOKEN, ADMIN_API_TOKEN: ADMIN, DATA_DIR: dir,
    GOLF_API_ENABLED: 'true', GOLF_API_KEY: GOLF_KEY,
    GPXZ_API_ENABLED: 'true', GPXZ_API_KEY: GPXZ_KEY,
    GOLF_API_DAILY_LIMIT: '1000', GPXZ_DAILY_LIMIT: '1000',
    FAILURE_COOLDOWN_SECONDS: '5', RATE_LIMIT_PER_MINUTE: '10000', ...overrides };
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function elevation(path = PATH, samples = 3) {
  return { status: 'OK', results: Array.from({ length: samples }, (_, i) => ({
    lat: path[0].lat + (path[1].lat - path[0].lat) * i / (samples - 1),
    lon: path[0].lon + (path[1].lon - path[0].lon) * i / (samples - 1),
    elevation: 100 + i, resolution: 30, data_source: 'offline-admin-fixture'
  })) };
}

function providerReply(url, options) {
  const parsed = new URL(url);
  if (parsed.hostname === 'api.gpxz.io') {
    assert.equal(parsed.pathname, '/v1/elevation/sample');
    const form = new URLSearchParams(options.body);
    assert.deepEqual([...form.keys()].sort(), ['bathymetry', 'interpolation', 'latlons', 'samples']);
    assert.equal(form.get('interpolation'), 'bilinear');
    assert.equal(form.get('bathymetry'), 'false');
    const path = form.get('latlons').split('|').map(pair => {
      const [lat, lon] = pair.split(',').map(Number);
      return { lat, lon };
    });
    assert.equal(path.length, 2);
    return json(elevation(path, Number(form.get('samples'))));
  }
  assert.equal(parsed.origin, 'https://golfapi.io');
  const parts = parsed.pathname.split('/');
  const id = parts.at(-1);
  if (parts.at(-2) === 'coordinates') return json({ courseID: id, coordinates: [
    { poi: '1', hole: '1', latitude: '57', longitude: '12' },
    { poi: '2', hole: '1', latitude: '57.001', longitude: '12.002' }
  ] });
  if (parts.at(-2) === 'courses') return json({ courseID: id, courseName: `Links ${id}`,
    clubName: 'Offline Club', country: 'SE', numHoles: '18',
    rawProviderField: 'never-include-provider-bodies-in-admin', apiRequestsLeft: 987 });
  assert.ok(['clubs', 'courses'].includes(id), `unexpected fake request: ${parsed}`);
  return json({ [id]: id === 'clubs'
    ? [{ clubID: 'club', clubName: 'Search Club', country: 'NO', courses: [
      { courseID: 'coords', courseName: 'Nested Coordinates Links' },
      { courseID: 'club-search-only', courseName: 'Not Downloaded' }
    ] }]
    : [{ courseID: 'coords', courseName: 'Search Coordinates Links', clubName: 'Search Club', country: 'NO' },
      { courseID: 'search-only', courseName: 'Not Downloaded' }] });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, respond = providerReply) {
  const dir = await mkdtemp(join(tmpdir(), 'fairwayvector-admin-api-'));
  const apps = new Set();
  const calls = [];
  let clock = EPOCH;
  t.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  return {
    dir, calls,
    time(value) { clock = value; },
    advance(ms) { clock += ms; },
    // A pre-admin cache has responses/usage but no AdminStore tables or counters.
    seed(callback) {
      const cache = new Cache(dir, { now: () => clock });
      try { return callback(cache); } finally { cache.close(); }
    },
    async open(overrides = {}) {
      const app = await buildApp(loadConfig(environment(dir, overrides)), {
        now: () => clock, logger: false,
        fetchImpl: async (url, options) => {
          calls.push({ url: String(url), options });
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          return respond(url, options, calls.length);
        }
      });
      apps.add(app);
      return app;
    },
    async close(app) { await app.close(); apps.delete(app); }
  };
}

function data(app, url, extra = {}) {
  return app.inject({ method: 'GET', url, ...extra, headers: { ...AUTH, ...extra.headers } });
}
function sample(app, payload = { path: PATH, samples: 3 }, headers = {}) {
  return data(app, '/api/v1/elevation/sample', { method: 'POST', payload, headers });
}
function assign(app, payload, headers = ADMIN_AUTH, url = '/api/admin/elevation/assign') {
  return app.inject({ method: 'POST', url, payload, headers });
}
async function overview(app, query = '') {
  const response = await app.inject({ url: `/api/admin/overview${query}`, headers: ADMIN_AUTH });
  assert.equal(response.statusCode, 200, response.body);
  for (const secret of SECRETS) assert.ok(!response.body.includes(secret), 'snapshot leaked a fake secret');
  assert.ok(!response.body.includes('never-include-provider-bodies-in-admin'));
  return response.json();
}
function errorIs(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['x-cache'], undefined);
}
function cacheIs(response, status) {
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-cache'], status);
}
function trafficIs(snapshot, expected = {}) {
  const totals = { requests: 0, completed: 0, cacheHits: 0, fetched: 0, coalesced: 0,
    errors: 0, upstreamCalls: 0, ...expected };
  assert.deepEqual(snapshot.traffic, { ...totals,
    cacheHitRate: totals.completed ? totals.cacheHits / totals.completed : null });
}

test('admin shell and allowlisted static assets are public, secret-free and CSP protected', async t => {
  const f = await fixture(t);
  const app = await f.open();
  for (const [url, type] of [['/admin', 'text/html'], ['/admin/', 'text/html'],
    ['/admin/admin.css', 'text/css'], ['/admin/admin.js', 'text/javascript']]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.headers['content-type'].startsWith(type));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    const csp = response.headers['content-security-policy'];
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'",
      "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) {
      assert.ok(csp.split(';').map(value => value.trim()).includes(directive), csp);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
    for (const secret of SECRETS) assert.ok(!response.body.includes(secret));
  }
  for (const url of ['/admin/config.js', '/admin/.env', '/admin/../src/config.js']) {
    const response = await app.inject({ url, headers: ADMIN_AUTH });
    assert.notEqual(response.statusCode, 200, `${url} must not expose arbitrary files`);
    for (const secret of SECRETS) assert.ok(!response.body.includes(secret));
  }
  trafficIs(await overview(app));
  assert.equal(f.calls.length, 0);
});

test('admin is disabled with 503 without ADMIN_API_TOKEN, while public shell and data still work', async t => {
  const f = await fixture(t);
  const app = await f.open({ ADMIN_API_TOKEN: '' });
  for (const headers of [{}, AUTH, ADMIN_AUTH]) {
    errorIs(await app.inject({ url: '/api/admin/overview', headers }), 503, 'admin_disabled');
    errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'A' }, headers), 503, 'admin_disabled');
  }
  for (const url of ['/healthz', '/admin', '/admin/admin.js', '/admin/admin.css']) {
    assert.equal((await app.inject(url)).statusCode, 200);
  }
  cacheIs(await data(app, '/api/v1/golf/courses/A'), 'MISS');
  assert.equal(f.calls.length, 1);
});

test('admin config rejects reused, short, nonprintable and oversized tokens', () => {
  for (const token of [TOKEN, 'short', 'x'.repeat(31), 'x'.repeat(513),
    `${'x'.repeat(32)} `, `${'x'.repeat(32)}\n`, 'é'.repeat(32)]) {
    assert.throws(() => loadConfig(environment(tmpdir(), { ADMIN_API_TOKEN: token })), /ADMIN_API_TOKEN/);
  }
  assert.equal(loadConfig(environment(tmpdir(), { ADMIN_API_TOKEN: '' })).adminToken, '');
  const env = environment(tmpdir());
  delete env.ADMIN_API_TOKEN;
  assert.equal(loadConfig(env).adminToken, '');
  for (const length of [32, 512]) {
    const token = 'a'.repeat(length);
    assert.equal(loadConfig(environment(tmpdir(), { ADMIN_API_TOKEN: token })).adminToken, token);
  }
});

test('admin/data tokens are isolated; health, admin polls and rejected authentication never count', async t => {
  const f = await fixture(t);
  const app = await f.open();
  for (const authorization of [undefined, `Bearer ${TOKEN}`, 'Basic abc', `bearer ${ADMIN}`, `Bearer ${ADMIN}x`]) {
    const headers = authorization === undefined ? {} : { authorization };
    errorIs(await app.inject({ url: '/api/admin/overview', headers }), 401, 'unauthorized');
    errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'A' }, headers), 401, 'unauthorized');
  }
  for (const url of ['/api/v1/golf/clubs?name=Links', '/api/v1/golf/courses?name=Links',
    '/api/v1/golf/courses/A', '/api/v1/golf/coordinates/A', '/api/v1/elevation/sample']) {
    for (const headers of [{}, ADMIN_AUTH, { authorization: 'Bearer invalid' }]) {
      errorIs(await app.inject({ url, headers, ...(url.includes('elevation')
        ? { method: 'POST', payload: { path: PATH, samples: 3 } } : {}) }), 401, 'unauthorized');
    }
  }
  for (const headers of [{}, AUTH, ADMIN_AUTH]) {
    const health = await app.inject({ url: '/healthz', headers });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
  }
  for (let i = 0; i < 3; i++) trafficIs(await overview(app));
  assert.equal(f.calls.length, 0);
  cacheIs(await data(app, '/api/v1/golf/courses/A'), 'MISS');
  const baseline = await overview(app);
  trafficIs(baseline, { requests: 1, completed: 1, fetched: 1, upstreamCalls: 1 });
  assert.deepEqual((await overview(app)).traffic, baseline.traffic);
});

for (const provider of ['golf', 'gpxz']) {
  test(`${provider} statistics distinguish requests, hits, successful fetches, failed attempts and cooldown/cache-only`, async t => {
    const f = await fixture(t, (url, options, count) => count === 2
      ? new Response('offline failure must not leak', { status: 429, headers: { 'retry-after': '5' } })
      : providerReply(url, options));
    const app = await f.open();
    const invoke = (id = 'A', cacheOnly = false) => provider === 'golf'
      ? data(app, `/api/v1/golf/courses/${id}`, { headers: cacheOnly ? { 'x-cache-only': 'true' } : {} })
      : sample(app, { path: PATH, samples: id === 'A' ? 3 : id === 'B' ? 4 : 5 },
        cacheOnly ? { 'x-cache-only': 'true' } : {});
    cacheIs(await invoke(), 'MISS');
    trafficIs(await overview(app), { requests: 1, completed: 1, fetched: 1, upstreamCalls: 1 });
    cacheIs(await invoke(), 'HIT');
    trafficIs(await overview(app), { requests: 2, completed: 2, cacheHits: 1, fetched: 1, upstreamCalls: 1 });
    errorIs(await invoke('B'), 502, 'provider_unavailable');
    const failed = await overview(app);
    trafficIs(failed, { requests: 3, completed: 3, cacheHits: 1, fetched: 1, errors: 1, upstreamCalls: 2 });
    assert.equal(failed.providers.find(item => item.id === provider).cooldownSeconds, 5);
    const cooldown = await invoke('C');
    errorIs(cooldown, 503, 'provider_cooldown');
    assert.equal(cooldown.headers['retry-after'], '5');
    errorIs(await invoke('C', true), 404, 'cache_miss');
    cacheIs(await invoke('A', true), 'HIT');
    const blocked = await overview(app);
    trafficIs(blocked, { requests: 6, completed: 6, cacheHits: 2, fetched: 1, errors: 3, upstreamCalls: 2 });
    assert.equal(f.calls.length, 2, 'cooldown and cache-only requests must not dispatch');
    assert.equal(blocked.providers.find(item => item.id === provider).todayCalls, 2);
    assert.equal(blocked.providers.find(item => item.id !== provider).upstreamCalls, 0);
    f.advance(5000);
    cacheIs(await invoke('B'), 'MISS');
    const recovered = await overview(app);
    trafficIs(recovered, { requests: 7, completed: 7, cacheHits: 2, fetched: 2, errors: 3, upstreamCalls: 3 });
    assert.equal(recovered.providers.find(item => item.id === provider).cooldownSeconds, 0);
    assert.equal(recovered.daily.at(-1).upstreamCalls, 3);
    assert.equal(recovered.daily.at(-1).errors, 3);
    assert.equal(f.calls.length, 3);
  });
}

test('authenticated schema, JSON and semantic validation failures count as errors without upstream attempts', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const responses = [
    await data(app, '/api/v1/golf/courses'),
    await data(app, '/api/v1/golf/courses/bad.id'),
    await data(app, '/api/v1/golf/coordinates/A?refresh=true'),
    await sample(app, { path: PATH, samples: 1 }),
    await sample(app, { path: PATH, samples: 3, courseID: 'bad.id' }),
    await sample(app, { path: PATH, samples: 3, courseID: 123 }),
    await sample(app, '{broken', { 'content-type': 'application/json' })
  ];
  for (const response of responses) assert.equal(response.statusCode, 400, response.body);
  trafficIs(await overview(app), { requests: responses.length, completed: responses.length, errors: responses.length });
  assert.equal(f.calls.length, 0);
});

for (const provider of ['golf', 'gpxz']) {
  test(`${provider} gated concurrent requests coalesce without claiming a stored-cache hit`, { timeout: 10000 }, async t => {
    const entered = deferred();
    const release = deferred();
    const followerRead = deferred();
    t.after(() => release.resolve());
    // Observe real cache reads without replacing their behavior. onRequest alone
    // is too early a barrier for POST: its body may still be parsing.
    const originalGet = Cache.prototype.get;
    let reads = 0;
    t.mock.method(Cache.prototype, 'get', function (key) {
      const result = originalGet.call(this, key);
      if (++reads === 2) followerRead.resolve();
      return result;
    });
    const f = await fixture(t, async (url, options) => {
      entered.resolve();
      await release.promise;
      return providerReply(url, options);
    });
    const app = await f.open();
    const invoke = tag => provider === 'golf' ? data(app, '/api/v1/golf/courses/A')
      : sample(app, { path: PATH, samples: 3, courseID: tag });
    const first = invoke('tag-A').then(response => response);
    await entered.promise;
    const follower = invoke('tag-B').then(response => response);
    try {
      await followerRead.promise;
      trafficIs(await overview(app), { requests: 2, completed: 0, upstreamCalls: 1 });
      assert.equal(f.calls.length, 1);
    } finally { release.resolve(); }
    const [a, b] = await Promise.all([first, follower]);
    cacheIs(a, 'MISS');
    cacheIs(b, 'COALESCED');
    assert.deepEqual(a.json(), b.json());
    assert.equal(a.headers['x-fetched-at'], b.headers['x-fetched-at']);
    const result = await overview(app);
    trafficIs(result, { requests: 2, completed: 2, fetched: 1, coalesced: 1, upstreamCalls: 1 });
    if (provider === 'gpxz') {
      assert.equal(result.inventory.elevationProfiles, 1);
      assert.equal(result.inventory.elevationSamples, 3);
      assert.equal(result.inventory.courseCount, 2);
      for (const course of result.courses.items) assert.equal(course.elevation.profiles, 1);
    }
    assert.equal(f.calls.length, 1);
  });
}

test('request counters and tracking start survive restart; disabled providers still serve cached hits', async t => {
  const f = await fixture(t);
  let app = await f.open();
  cacheIs(await data(app, '/api/v1/golf/courses/A'), 'MISS');
  cacheIs(await sample(app), 'MISS');
  cacheIs(await data(app, '/api/v1/golf/courses/A'), 'HIT');
  errorIs(await data(app, '/api/v1/golf/courses/absent', { headers: { 'x-cache-only': 'true' } }), 404, 'cache_miss');
  const beforeRestart = await overview(app, '?days=0');
  trafficIs(beforeRestart, { requests: 4, completed: 4, cacheHits: 1, fetched: 2, errors: 1, upstreamCalls: 2 });
  await f.close(app);
  f.advance(DAY);
  app = await f.open({ GOLF_API_ENABLED: 'false', GPXZ_API_ENABLED: 'false', GOLF_API_KEY: '', GPXZ_API_KEY: '' });
  const restarted = await overview(app, '?days=0');
  assert.equal(restarted.trackingStartedAt, beforeRestart.trackingStartedAt);
  assert.equal(restarted.trackingStartedAt, new Date(EPOCH).toISOString());
  assert.deepEqual(restarted.traffic, beforeRestart.traffic);
  assert.deepEqual(restarted.inventory, beforeRestart.inventory);
  assert.ok(restarted.providers.every(provider => !provider.enabled && provider.todayCalls === 0));
  trafficIs(await overview(app, '?days=1'));
  cacheIs(await data(app, '/api/v1/golf/courses/A'), 'HIT');
  cacheIs(await sample(app), 'HIT');
  errorIs(await data(app, '/api/v1/golf/courses/new'), 503, 'provider_disabled');
  trafficIs(await overview(app, '?days=1'), { requests: 3, completed: 3, cacheHits: 2, errors: 1 });
  assert.equal(f.calls.length, 2);
});

test('pre-admin Cache upgrade retains historical attempts, estimates legacy lengths, and does not invent requests/ownership', async t => {
  const f = await fixture(t);
  const legacy = elevation();
  legacy.note = 'legacy raw data: å⛳';
  f.time(EPOCH - 100 * DAY);
  f.seed(cache => {
    cache.reserve('golf', 1000);
    cache.reserve('golf', 1000);
    cache.put('golf:v1:detail:old', 'golf', { body: { courseID: 'old', courseName: 'Old Links' } });
    cache.put(LEGACY_KEY, 'gpxz', { body: legacy });
    assert.equal(cache.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'admin_requests'").get().n, 0);
  });
  f.time(EPOCH - DAY);
  f.seed(cache => cache.reserve('gpxz', 1000));
  f.time(EPOCH);
  let app = await f.open();
  const snapshot = await overview(app, '?days=0');
  trafficIs(snapshot, { upstreamCalls: 3 });
  assert.equal(snapshot.trackingStartedAt, new Date(EPOCH).toISOString());
  assert.equal(snapshot.daily.length, 30);
  assert.equal(snapshot.daily.reduce((sum, row) => sum + row.upstreamCalls, 0), 1);
  assert.equal(snapshot.inventory.courseCount, 1);
  assert.equal(snapshot.inventory.elevationProfiles, 1);
  assert.equal(snapshot.inventory.elevationSamples, 3);
  assert.equal(snapshot.inventory.elevationBytes, Buffer.byteLength(JSON.stringify(legacy)));
  const chords = distance(legacy.results[0], legacy.results[1]) + distance(legacy.results[1], legacy.results[2]);
  assert.equal(snapshot.inventory.elevationLengthMeters, chords);
  assert.equal(snapshot.inventory.lengthEstimated, true);
  assert.equal(snapshot.inventory.unassignedProfiles, 1);
  assert.deepEqual(snapshot.unassigned.items, [{ key: LEGACY_KEY, samples: 3,
    bytes: Buffer.byteLength(JSON.stringify(legacy)), lengthMeters: chords, lengthEstimated: true,
    fetchedAt: new Date(EPOCH - 100 * DAY).toISOString(), start: PATH[0], end: PATH[1] }]);
  assert.equal(snapshot.courses.items[0].elevation.profiles, 0);
  assert.ok(!JSON.stringify(snapshot).includes(legacy.note));
  trafficIs(await overview(app, '?days=7'), { upstreamCalls: 1 });
  trafficIs(await overview(app, '?days=1'));
  await f.close(app);
  f.advance(DAY);
  app = await f.open();
  const restarted = await overview(app, '?days=0');
  assert.equal(restarted.trackingStartedAt, snapshot.trackingStartedAt);
  assert.deepEqual(restarted.inventory, snapshot.inventory);
  assert.deepEqual(restarted.unassigned, snapshot.unassigned);
  assert.equal(f.calls.length, 0);
});

test('optional elevation courseID is metadata only: untagged and multiple tags share one fetched profile', async t => {
  const f = await fixture(t);
  let app = await f.open();
  const first = await sample(app);
  cacheIs(first, 'MISS');
  const unassigned = await overview(app);
  assert.equal(unassigned.inventory.courseCount, 0);
  assert.equal(unassigned.unassigned.total, 1);
  const key = unassigned.unassigned.items[0].key;
  assert.match(key, /^gpxz:sample:v1:[a-f0-9]{64}$/);
  for (const courseID of ['tag-A', 'tag-B', 'tag-A']) {
    const tagged = await sample(app, { path: PATH, samples: 3, courseID });
    cacheIs(tagged, 'HIT');
    assert.deepEqual(tagged.json(), first.json());
    assert.equal(tagged.headers['x-fetched-at'], first.headers['x-fetched-at']);
    assert.equal(tagged.json().courseID, undefined);
  }
  const linked = await overview(app);
  trafficIs(linked, { requests: 4, completed: 4, fetched: 1, cacheHits: 3, upstreamCalls: 1 });
  assert.equal(linked.inventory.courseCount, 2);
  assert.equal(linked.inventory.elevationProfiles, 1);
  assert.equal(linked.inventory.elevationSamples, 3);
  assert.equal(linked.inventory.elevationBytes, Buffer.byteLength(JSON.stringify(first.json())));
  assert.equal(linked.inventory.elevationLengthMeters, distance(PATH[0], PATH[1]));
  assert.equal(linked.inventory.lengthEstimated, false);
  assert.equal(linked.unassigned.total, 0);
  for (const item of linked.courses.items) {
    assert.equal(item.name, `Course ${item.id}`);
    assert.equal(item.hasDetail, false);
    assert.equal(item.hasCoordinates, false);
    assert.equal(item.coordinateCount, 0);
    assert.equal(item.numHoles, null);
    assert.equal(item.detailFetchedAt, null);
    assert.equal(item.coordinatesFetchedAt, null);
    assert.equal(item.elevation.profiles, 1);
    assert.equal(item.elevation.samples, 3);
    assert.equal(item.elevation.lengthMeters, linked.inventory.elevationLengthMeters);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(new URLSearchParams(f.calls[0].options.body).has('courseID'), false);
  await f.close(app);
  app = await f.open();
  assert.deepEqual((await overview(app)).inventory, linked.inventory);
  assert.deepEqual((await overview(app)).courses, linked.courses);
});

test('assignment is authenticated, schema protected, local, idempotent and limited to existing profiles/known courses', async t => {
  const f = await fixture(t);
  f.seed(cache => {
    cache.put(LEGACY_KEY, 'gpxz', { body: elevation() });
    cache.put(SECOND_KEY, 'gpxz', { body: elevation(PATH, 4) });
  });
  const app = await f.open();
  cacheIs(await data(app, '/api/v1/golf/courses?name=Links'), 'MISS');
  errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'search-only' }), 404, 'cached_data_not_found');
  cacheIs(await data(app, '/api/v1/golf/courses/detail'), 'MISS');
  cacheIs(await data(app, '/api/v1/golf/coordinates/coords'), 'MISS');
  const beforeAssign = await overview(app);
  const callsBefore = f.calls.length;
  for (const headers of [{}, AUTH]) {
    errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'detail' }, headers), 401, 'unauthorized');
  }
  for (const payload of [{}, { key: LEGACY_KEY }, { courseID: 'detail' },
    { key: 'bad', courseID: 'detail' }, { key: LEGACY_KEY, courseID: '../detail' },
    { key: LEGACY_KEY, courseID: '' }, { key: LEGACY_KEY, courseID: 1 },
    { key: LEGACY_KEY, courseID: 'detail', fetch: true },
    { key: 'golf:v1:detail:detail', courseID: 'detail' }]) {
    errorIs(await assign(app, payload), 400, 'invalid_request');
  }
  errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'detail' }, ADMIN_AUTH,
    '/api/admin/elevation/assign?refresh=true'), 400, 'invalid_request');
  errorIs(await assign(app, { key: `gpxz:sample:v1:${'c'.repeat(64)}`, courseID: 'detail' }), 404, 'cached_data_not_found');
  errorIs(await assign(app, { key: LEGACY_KEY, courseID: 'unknown' }), 404, 'cached_data_not_found');
  assert.equal((await overview(app)).unassigned.total, 2, 'rejected assignments must not mutate links');
  for (const [key, courseID] of [[LEGACY_KEY, 'detail'], [LEGACY_KEY, 'detail'],
    [LEGACY_KEY, 'coords'], [SECOND_KEY, 'coords']]) {
    const response = await assign(app, { key, courseID });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true });
  }
  const afterAssign = await overview(app);
  assert.deepEqual(afterAssign.traffic, beforeAssign.traffic, 'admin mutations and failures are not client traffic');
  assert.equal(afterAssign.inventory.elevationProfiles, 2);
  assert.equal(afterAssign.inventory.elevationSamples, 7);
  assert.equal(afterAssign.inventory.unassignedProfiles, 0);
  assert.equal(afterAssign.inventory.lengthEstimated, true, 'assignment must not relabel legacy length as exact');
  assert.equal(afterAssign.unassigned.total, 0);
  assert.equal(afterAssign.courses.items.find(item => item.id === 'detail').elevation.profiles, 1);
  assert.equal(afterAssign.courses.items.find(item => item.id === 'coords').elevation.profiles, 2);
  assert.equal(f.calls.length, callsBefore, 'assignments never contact either provider');
});

test('course inventory counts detail/coordinates, enriches missing metadata, and excludes search-only downloads', async t => {
  const f = await fixture(t);
  const app = await f.open();
  cacheIs(await data(app, '/api/v1/golf/courses?name=Links'), 'MISS');
  cacheIs(await data(app, '/api/v1/golf/clubs?name=Links'), 'MISS');
  const searchOnly = await overview(app);
  assert.equal(searchOnly.inventory.courseCount, 0);
  assert.equal(searchOnly.courses.total, 0);
  assert.deepEqual(searchOnly.courseOptions, []);
  cacheIs(await data(app, '/api/v1/golf/coordinates/coords'), 'MISS');
  cacheIs(await data(app, '/api/v1/golf/courses/detail'), 'MISS');
  cacheIs(await data(app, '/api/v1/golf/coordinates/detail'), 'MISS');
  const snapshot = await overview(app);
  assert.equal(snapshot.inventory.courseCount, 2, 'detail + coordinates is one course, not two downloads');
  const coordinates = snapshot.courses.items.find(item => item.id === 'coords');
  assert.equal(coordinates.name, 'Search Coordinates Links');
  assert.equal(coordinates.clubName, 'Search Club');
  assert.equal(coordinates.country, 'NO');
  assert.equal(coordinates.hasDetail, false);
  assert.equal(coordinates.hasCoordinates, true);
  assert.equal(coordinates.coordinateCount, 2);
  assert.equal(coordinates.numHoles, null);
  assert.equal(coordinates.detailFetchedAt, null);
  assert.equal(coordinates.coordinatesFetchedAt, new Date(EPOCH).toISOString());
  const detail = snapshot.courses.items.find(item => item.id === 'detail');
  assert.equal(detail.hasDetail, true);
  assert.equal(detail.hasCoordinates, true);
  assert.equal(detail.coordinateCount, 2);
  assert.equal(detail.numHoles, 18);
  assert.equal(detail.detailFetchedAt, new Date(EPOCH).toISOString());
  assert.equal(snapshot.inventory.elevationProfiles, 0);
  assert.equal(snapshot.courses.items.some(item => item.id === 'search-only' || item.id === 'club-search-only'), false);
  assert.equal(f.calls.length, 5);
});

test('overview period/search/pagination validate inputs, filter traffic only by period and keep global inventory', async t => {
  const f = await fixture(t);
  f.time(EPOCH - 40 * DAY);
  f.seed(cache => {
    cache.reserve('golf', 1000);
    for (let i = 0; i < 31; i++) {
      const id = String(i).padStart(3, '0');
      cache.put(`golf:v1:detail:${id}`, 'golf', { body: { courseID: id, courseName: `Links ${id}`,
        clubName: i === 30 ? '100%_ Club' : 'Fixture Club', country: i === 30 ? 'NO' : 'SE' } });
    }
  });
  f.time(EPOCH - DAY);
  const app = await f.open();
  cacheIs(await data(app, '/api/v1/golf/courses/000'), 'HIT');
  f.time(EPOCH);
  errorIs(await sample(app, { path: PATH, samples: 1 }), 400, 'invalid_samples');
  const today = await overview(app, '?days=1');
  trafficIs(today, { requests: 1, completed: 1, errors: 1 });
  assert.deepEqual(today.period, { days: 1, label: 'Today' });
  assert.equal(today.daily.length, 1);
  const week = await overview(app);
  trafficIs(week, { requests: 2, completed: 2, cacheHits: 1, errors: 1 });
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily.at(-2).requests, 1);
  assert.equal(week.daily.at(-2).cacheHits, 1);
  assert.equal(week.daily.at(-1).errors, 1);
  assert.equal(week.courses.total, 31);
  assert.equal(week.courses.pageSize, 25);
  assert.equal(week.courses.items.length, 25);
  assert.equal(week.courses.items[0].id, '000');
  const second = await overview(app, '?page=2&days=30');
  assert.deepEqual(second.period, { days: 30, label: 'Last 30 days' });
  assert.equal(second.daily.length, 30);
  assert.deepEqual(second.courses.items.map(item => item.id), ['025', '026', '027', '028', '029', '030']);
  const all = await overview(app, '?days=0');
  trafficIs(all, { requests: 2, completed: 2, cacheHits: 1, errors: 1, upstreamCalls: 1 });
  assert.deepEqual(all.period, { days: 0, label: 'All time' });
  assert.equal(all.daily.length, 30);
  assert.equal(all.daily.reduce((sum, day) => sum + day.upstreamCalls, 0), 0);
  for (const search of ['030', 'links 030', '100%_', ' no ']) {
    const filtered = await overview(app, `?search=${encodeURIComponent(search)}`);
    assert.equal(filtered.courses.total, 1);
    assert.equal(filtered.courses.items[0].id, '030');
    assert.deepEqual(filtered.inventory, week.inventory);
    assert.equal(filtered.courseOptions.length, 31, 'assignment options must not inherit table search');
    assert.deepEqual(filtered.traffic, week.traffic);
  }
  const absent = await overview(app, '?search=absent');
  assert.equal(absent.courses.total, 0);
  assert.deepEqual(absent.courses.items, []);
  assert.equal(absent.inventory.courseCount, 31);
  assert.deepEqual((await overview(app, '?page=999999')).courses.items, []);
  for (const query of ['days=2', 'days=-1', 'days=365', 'page=0', 'page=01', 'page=1000000',
    `search=${'x'.repeat(201)}`, 'refresh=true']) {
    errorIs(await app.inject({ url: `/api/admin/overview?${query}`, headers: ADMIN_AUTH }), 400, 'invalid_request');
  }
  assert.deepEqual((await overview(app)).traffic, week.traffic, 'invalid admin polls must not count');
  assert.equal(f.calls.length, 0);
});