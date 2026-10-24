import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { profileRequest, pointAt, distance } from '../src/geometry.js';

// Never inherit process.env (or load .env); all credentials below are fake.
const TOKEN = 'offline-regression-token-not-a-secret-0123456789';
const GOLF_KEY = 'fake-offline-golf-key';
const GPXZ_KEY = 'fake-offline-gpxz-key';
const EPOCH = Date.parse('2026-10-23T12:00:00.000Z');
const PATH = [{ lat: 57, lon: 12 }, { lat: 57.001, lon: 12.002 }];
const AUTH = { authorization: `Bearer ${TOKEN}` };
const originalFetch = globalThis.fetch;
let defaultFetchCalls = 0;
before(() => {
  globalThis.fetch = () => {
    defaultFetchCalls++;
    throw new Error('OFFLINE TEST: default fetch must never be used');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(defaultFetchCalls, 0, 'a test escaped its injected transport');
});

function environment(dataDir, overrides = {}) {
  return { SERVER_API_TOKEN: TOKEN, DATA_DIR: dataDir,
    GOLF_API_ENABLED: 'true', GOLF_API_KEY: GOLF_KEY,
    GPXZ_API_ENABLED: 'true', GPXZ_API_KEY: GPXZ_KEY,
    GOLF_API_DAILY_LIMIT: '1000', GPXZ_DAILY_LIMIT: '1000',
    FAILURE_COOLDOWN_SECONDS: '5', RATE_LIMIT_PER_MINUTE: '10000', ...overrides };
}

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
}

function coordinates(id = 'course-1') {
  return { courseID: id, coordinates: [
    { poi: '1', hole: '1', latitude: '57', longitude: '12' }
  ], apiRequestsLeft: 987 };
}

function elevation(path = PATH, samples = 3) {
  // Independent fixture interpolation for a straight path; do not generate
  // provider coordinates using the production pointAt validator.
  assert.equal(path.length, 2);
  return { status: 'OK', results: Array.from({ length: samples }, (_, i) => ({
    lat: path[0].lat + (path[1].lat - path[0].lat) * i / (samples - 1),
    lon: path[0].lon + (path[1].lon - path[0].lon) * i / (samples - 1),
    elevation: 100 + i, resolution: 30, data_source: 'offline-fixture-2026'
  })) };
}

function providerReply(url, options) {
  const parsed = new URL(url);
  if (parsed.hostname === 'api.gpxz.io') {
    const form = new URLSearchParams(options.body);
    const path = form.get('latlons').split('|').map(pair => {
      const [lat, lon] = pair.split(',').map(Number);
      return { lat, lon };
    });
    return json(elevation(path, Number(form.get('samples'))), { 'x-dataset-version': 'fixture-2026.1' });
  }
  assert.equal(parsed.hostname, 'golfapi.io');
  const parts = parsed.pathname.split('/');
  const id = parts.at(-1);
  if (parts.at(-2) === 'coordinates') return json(coordinates(id));
  if (parts.at(-2) === 'courses') return json({ courseID: id, courseName: 'Offline Links', apiRequestsLeft: 987 });
  const kind = id;
  assert.ok(['clubs', 'courses'].includes(kind), `unexpected fixture URL: ${parsed}`);
  return json({ [kind]: [kind === 'clubs'
    ? { clubID: 'club-1', clubName: 'Offline Club' }
    : { courseID: 'course-1', courseName: 'Offline Links' }], apiRequestsLeft: 987 });
}

async function fixture(t, overrides = {}, respond = providerReply) {
  const dir = await mkdtemp(join(tmpdir(), 'fairwayvector-offline-'));
  const calls = [];
  const apps = new Set();
  let clock = EPOCH;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return respond(url, options, calls.length);
  };
  t.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  const open = async (changes = {}) => {
    const app = await buildApp(loadConfig(environment(dir, { ...overrides, ...changes })), {
      fetchImpl, now: () => clock, logger: false
    });
    apps.add(app);
    return app;
  };
  const close = async app => { await app.close(); apps.delete(app); };
  return { dir, calls, open, close, advance: ms => { clock += ms; },
    rows(table) {
      assert.ok(['responses', 'failures', 'usage'].includes(table));
      const db = new DatabaseSync(join(dir, 'cache.sqlite'), { readOnly: true });
      try { return db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
      finally { db.close(); }
    } };
}

function request(app, url, extra = {}) {
  return app.inject({ method: 'GET', url, ...extra, headers: { ...AUTH, ...extra.headers } });
}
function sample(app, payload = { path: PATH, samples: 3 }, extra = {}) {
  return request(app, '/api/v1/elevation/sample', { method: 'POST', payload, ...extra });
}
function errorIs(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['x-cache'], undefined);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('loadConfig accepts explicit fake configuration and rejects unsafe settings', () => {
  const config = loadConfig(environment('/tmp/offline-config-only'));
  assert.equal(config.token, TOKEN);
  assert.equal(config.providers.golf.enabled, true);
  assert.equal(config.providers.gpxz.enabled, true);
  assert.equal(config.providers.golf.key, GOLF_KEY);
  assert.equal(config.providers.gpxz.key, GPXZ_KEY);
  assert.equal(config.host, '127.0.0.1');
  for (const token of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + ' ', 'x'.repeat(32) + '\n', 'é'.repeat(32)]) {
    assert.throws(() => loadConfig(environment('/tmp/offline-config-only', { SERVER_API_TOKEN: token })), /SERVER_API_TOKEN/);
  }
  for (const name of ['GOLF_API_ENABLED', 'GPXZ_API_ENABLED']) {
    assert.throws(() => loadConfig(environment('/tmp/offline-config-only', { [name]: 'TRUE' })), /Invalid/);
  }
  for (const name of ['GOLF_API_KEY', 'GPXZ_API_KEY']) {
    for (const key of ['', 'YOUR_KEY', '${KEY}', '$(command)', '<placeholder>', 'fake\nkey']) {
      assert.throws(() => loadConfig(environment('/tmp/offline-config-only', { [name]: key })), /provider key/);
    }
  }
  for (const [name, value] of [['PORT', '0'], ['PORT', '65536'], ['MAX_UPSTREAM_CONCURRENCY', '0'],
    ['MAX_UPSTREAM_CONCURRENCY', '33'], ['FAILURE_COOLDOWN_SECONDS', '0'], ['RATE_LIMIT_PER_MINUTE', '0'],
    ['GPXZ_DAILY_LIMIT', '-1'], ['GOLF_API_DAILY_LIMIT', '1.5'], ['PORT', 'NaN']]) {
    assert.throws(() => loadConfig(environment('/tmp/offline-config-only', { [name]: value })), /Invalid/);
  }
  const disabled = loadConfig({ SERVER_API_TOKEN: TOKEN });
  assert.equal(disabled.providers.golf.enabled, false);
  assert.equal(disabled.providers.gpxz.enabled, false);
});

test('health is public; all provider routes require exact bearer authentication', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const health = await app.inject('/healthz');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  for (const url of ['/api/v1/golf/clubs?name=Links', '/api/v1/golf/courses?country=SE',
    '/api/v1/golf/courses/course-1', '/api/v1/golf/coordinates/course-1', '/api/v1/elevation/sample']) {
    for (const authorization of [undefined, 'Basic abc', `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, 'Bearer ']) {
      const response = await app.inject({ url, method: url.includes('elevation') ? 'POST' : 'GET',
        headers: authorization === undefined ? {} : { authorization },
        ...(url.includes('elevation') ? { payload: { path: PATH } } : {}) });
      errorIs(response, 401, 'unauthorized');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.ok(!response.body.includes(TOKEN));
    }
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows('usage'), []);
});

test('invalid search, identifiers, and unsupported refresh queries never dispatch', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const urls = ['/api/v1/golf/clubs', '/api/v1/golf/courses?name=%20%20',
    '/api/v1/golf/clubs?page=1', '/api/v1/golf/clubs?name=x&page=0',
    '/api/v1/golf/clubs?name=x&page=01', '/api/v1/golf/clubs?name=x&page=10000',
    `/api/v1/golf/clubs?name=${'x'.repeat(201)}`, '/api/v1/golf/courses?name=x&refresh=true',
    '/api/v1/golf/courses/course-1?refresh=true', '/api/v1/golf/coordinates/course-1?refresh=true',
    '/api/v1/golf/courses/bad.id', '/api/v1/golf/coordinates/bad%20id',
    `/api/v1/golf/courses/${'x'.repeat(101)}`];
  for (const url of urls) {
    const response = await request(app, url);
    assert.ok([400, 414].includes(response.statusCode), `${url}: ${response.body}`);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows('usage'), []);
  assert.deepEqual(f.rows('responses'), []);
});

test('invalid profile bodies, samples, coordinates and options never dispatch', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const bodies = [{}, { path: [] }, { path: [PATH[0]] }, { path: PATH, latlons: '57,12|57.001,12.002' },
    { path: [PATH[0], PATH[0]] }, { path: [{ lat: 91, lon: 0 }, PATH[1]] },
    { path: [{ lat: 0, lon: -181 }, PATH[1]] }, { path: [{ lat: '57', lon: 12 }, PATH[1]] },
    { path: [{ lat: 57 }, PATH[1]] }, { path: [{ ...PATH[0], elevation: 2 }, PATH[1]] },
    { path: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }, { path: Array(5001).fill(PATH[0]) },
    ...['', '57,12|', '57,12|57,', '57,12,1|57,13', 'NaN,12|57,13'].map(latlons => ({ latlons })),
    ...[0, 1, 513, -1, 2.5, '2.5', 'abc', null, true].map(samples => ({ path: PATH, samples })),
    { path: PATH, interpolation: 'nearest' }, { path: PATH, bathymetry: true },
    { path: PATH, bathymetry: 'true' }, { path: PATH, refresh: true }];
  for (const payload of bodies) {
    const response = await sample(app, payload);
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload).slice(0, 150)}: ${response.body}`);
  }
  const malformed = await sample(app, '{broken', { headers: { 'content-type': 'application/json' } });
  errorIs(malformed, 400, 'invalid_request');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows('usage'), []);
});

for (const kind of ['clubs', 'courses']) {
  test(`${kind} search canonicalizes NFC, whitespace, order and default page across restart`, async t => {
    const f = await fixture(t);
    let app = await f.open();
    const query = new URLSearchParams({ name: '  A\u030are  ', country: ' SE ', state: ' ', timestampUpdated: ' 2026-01-01 ' });
    const first = await request(app, `/api/v1/golf/${kind}?${query}`);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['x-cache'], 'MISS');
    assert.equal(first.headers['x-fetched-at'], new Date(EPOCH).toISOString());
    assert.equal(first.json().apiRequestsLeft, undefined);
    const outgoing = new URL(f.calls[0].url);
    assert.equal(outgoing.origin, 'https://golfapi.io');
    assert.equal(outgoing.pathname, `/api/v2.3/${kind}`);
    assert.deepEqual(Object.fromEntries(outgoing.searchParams), {
      name: 'Åre', country: 'SE', timestampUpdated: '2026-01-01', page: '1'
    });
    assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${GOLF_KEY}`);
    const canonical = `/api/v1/golf/${kind}?page=1&timestampUpdated=2026-01-01&country=SE&name=${encodeURIComponent('Åre')}`;
    assert.equal((await request(app, canonical)).headers['x-cache'], 'HIT');
    await f.close(app);
    f.advance(3600000);
    app = await f.open();
    const restarted = await request(app, canonical);
    assert.equal(restarted.headers['x-cache'], 'HIT');
    assert.equal(restarted.headers['x-fetched-at'], first.headers['x-fetched-at']);
    assert.deepEqual(restarted.json(), first.json());
    assert.equal(f.calls.length, 1);
    // Case is meaningful, unlike surrounding whitespace and Unicode composition.
    assert.equal((await request(app, canonical.replace('name=%C3%85re', 'name=are'))).headers['x-cache'], 'MISS');
    assert.equal(f.calls.length, 2);
  });
}

test('course and coordinate caches use separate exact IDs and survive disabled restart', async t => {
  const f = await fixture(t);
  let app = await f.open();
  const urls = ['/api/v1/golf/courses/course-1', '/api/v1/golf/coordinates/course-1',
    '/api/v1/golf/courses/course-2', '/api/v1/golf/clubs?name=Links'];
  const bodies = [];
  for (const url of urls) {
    const response = await request(app, url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-cache'], 'MISS');
    assert.equal(response.json().apiRequestsLeft, undefined);
    bodies.push(response.json());
  }
  assert.equal(f.calls.length, 4);
  await f.close(app);
  app = await f.open({ GOLF_API_ENABLED: 'false', GPXZ_API_ENABLED: 'false', GOLF_API_DAILY_LIMIT: '0' });
  for (const [i, url] of urls.entries()) {
    const response = await request(app, url);
    assert.equal(response.headers['x-cache'], 'HIT');
    assert.deepEqual(response.json(), bodies[i]);
  }
  errorIs(await request(app, '/api/v1/golf/courses/missing'), 503, 'provider_disabled');
  errorIs(await sample(app), 503, 'provider_disabled');
  assert.equal(f.calls.length, 4);
});

test('cache-only misses and hits do not reserve budget, even with providers disabled', async t => {
  const f = await fixture(t, { GOLF_API_DAILY_LIMIT: '1', GPXZ_DAILY_LIMIT: '1' });
  let app = await f.open();
  const headers = { 'x-cache-only': 'true' };
  errorIs(await request(app, '/api/v1/golf/courses/course-1', { headers }), 404, 'cache_miss');
  errorIs(await sample(app, undefined, { headers }), 404, 'cache_miss');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows('usage'), []);
  await request(app, '/api/v1/golf/courses/course-1');
  await sample(app);
  const usage = f.rows('usage');
  await f.close(app);
  app = await f.open({ GOLF_API_ENABLED: 'false', GPXZ_API_ENABLED: 'false' });
  assert.equal((await request(app, '/api/v1/golf/courses/course-1', { headers })).headers['x-cache'], 'HIT');
  assert.equal((await sample(app, undefined, { headers })).headers['x-cache'], 'HIT');
  errorIs(await request(app, '/api/v1/golf/courses/uncached', { headers }), 404, 'cache_miss');
  errorIs(await sample(app, { path: PATH, samples: 4 }, { headers }), 404, 'cache_miss');
  assert.deepEqual(f.rows('usage'), usage);
  assert.equal(f.calls.length, 2);
});

for (const target of ['golf', 'gpxz']) {
  test(`${target} concurrent identical requests single-flight; unrelated work is concurrency-limited`, { timeout: 10000 }, async t => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, { MAX_UPSTREAM_CONCURRENCY: '1' }, async (url, options) => {
      entered.resolve();
      await release.promise;
      return providerReply(url, options);
    });
    const app = await f.open();
    const invoke = () => target === 'golf' ? request(app, '/api/v1/golf/courses/course-1') : sample(app);
    // Start injection immediately (inject's thenable is lazy until consumed).
    const first = Promise.resolve(invoke());
    await Promise.race([entered.promise, first.then(response => {
      throw new Error(`request finished before injected fetch was entered: ${response.body}`);
    })]);
    try {
      const followers = Array.from({ length: 5 }, () => Promise.resolve(invoke()));
      // Drain runnable injection callbacks while the upstream remains gated;
      // this is an event-loop barrier, not an elapsed-time sleep.
      await nextTurn();
      errorIs(await request(app, '/api/v1/golf/courses/unrelated'), 503, 'server_busy');
      assert.equal(f.calls.length, 1);
      assert.equal(f.rows('usage')[0].attempts, 1);
      release.resolve();
      const replies = await Promise.all([first, ...followers]);
      assert.equal(replies[0].headers['x-cache'], 'MISS');
      assert.ok(replies.slice(1).every(r => ['COALESCED', 'HIT'].includes(r.headers['x-cache'])));
      for (const response of replies) {
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), replies[0].json());
      }
      assert.equal((await invoke()).headers['x-cache'], 'HIT');
      assert.equal(f.calls.length, 1);
    } finally { release.resolve(); await first; }
  });
}

test('coalesced failures share one reservation and release the flight after cooldown', { timeout: 10000 }, async t => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {}, async (url, options, count) => {
    if (count === 1) {
      entered.resolve();
      await release.promise;
      return new Response('offline failure', { status: 503 });
    }
    return providerReply(url, options);
  });
  const app = await f.open();
  const invoke = () => request(app, '/api/v1/golf/courses/course-1');
  const first = Promise.resolve(invoke());
  await Promise.race([entered.promise, first.then(response => {
    throw new Error(`request finished before injected fetch was entered: ${response.body}`);
  })]);
  try {
    const second = Promise.resolve(invoke());
    await nextTurn();
    assert.equal(f.calls.length, 1);
    release.resolve();
    for (const response of await Promise.all([first, second])) errorIs(response, 502, 'provider_unavailable');
    assert.equal(f.rows('usage')[0].attempts, 1);
    errorIs(await invoke(), 503, 'provider_cooldown');
    f.advance(5001);
    assert.equal((await invoke()).headers['x-cache'], 'MISS');
    assert.equal(f.calls.length, 2);
    assert.equal(f.rows('usage')[0].attempts, 2);
  } finally { release.resolve(); await first; }
});

test('GPXZ sends exact form options and sample count; normalized profiles persist dataset metadata', async t => {
  const f = await fixture(t);
  let app = await f.open();
  const first = await sample(app, { path: [PATH[0], PATH[0], PATH[1]], samples: '003',
    interpolation: 'bilinear', bathymetry: 'false' });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['x-cache'], 'MISS');
  assert.equal(first.headers['x-dataset-version'], 'fixture-2026.1');
  const { url, options } = f.calls[0];
  assert.equal(url, 'https://api.gpxz.io/v1/elevation/sample');
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { 'x-api-key': GPXZ_KEY, 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(options.body, 'latlons=57%2C12%7C57.001%2C12.002&samples=3&interpolation=bilinear&bathymetry=false');
  const equivalent = { latlons: ' 57,12 |57.001,12.002 ', samples: 3 };
  assert.equal((await sample(app, equivalent)).headers['x-cache'], 'HIT');
  await f.close(app);
  f.advance(100000);
  app = await f.open({ GPXZ_API_ENABLED: 'false', GPXZ_DAILY_LIMIT: '0' });
  const cached = await sample(app, equivalent);
  assert.equal(cached.headers['x-cache'], 'HIT');
  assert.equal(cached.headers['x-fetched-at'], first.headers['x-fetched-at']);
  assert.equal(cached.headers['x-dataset-version'], 'fixture-2026.1');
  assert.deepEqual(cached.json(), first.json());
  assert.equal(f.calls.length, 1);
});

test('form-encoded profile input and JSON input share cache; reversed paths and sample counts do not', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const form = new URLSearchParams({ latlons: '57,12|57.001,12.002', samples: '3',
    interpolation: 'bilinear', bathymetry: 'false' }).toString();
  const first = await sample(app, form, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['x-cache'], 'MISS');
  assert.equal((await sample(app)).headers['x-cache'], 'HIT');
  assert.equal((await sample(app, { path: [...PATH].reverse(), samples: 3 })).headers['x-cache'], 'MISS');
  assert.equal((await sample(app, { path: PATH, samples: 4 })).headers['x-cache'], 'MISS');
  assert.equal(f.calls.length, 3);
  assert.equal(f.rows('responses').length, 3);
});

test('profile defaults cap at 512, accept 2 and 512, and preserve nearby distinct coordinates', async t => {
  const f = await fixture(t);
  const app = await f.open();
  for (const samples of [2, 512]) {
    const response = await sample(app, { path: PATH, samples });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().results.length, samples);
  }
  const longer = [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 }];
  const capped = await sample(app, { path: longer });
  assert.equal(capped.statusCode, 200, capped.body);
  assert.equal(capped.json().results.length, 512);
  const short = [{ lat: 0, lon: 0 }, { lat: 0.00001, lon: 0 }];
  const automatic = await sample(app, { path: short });
  assert.equal(automatic.statusCode, 200, automatic.body);
  assert.equal(automatic.json().results.length, 3);
  const nearby = [{ ...PATH[0], lat: PATH[0].lat + 0.0000001 }, PATH[1]];
  assert.equal((await sample(app, { path: nearby, samples: 2 })).headers['x-cache'], 'MISS');
  assert.equal(f.calls.length, 5);
});

const badGolf = [
  ['wrong detail ID', '/api/v1/golf/courses/course-1', { courseID: 'other', courseName: 'Wrong' }],
  ['missing detail name', '/api/v1/golf/courses/course-1', { courseID: 'course-1' }],
  ['wrong coordinate ID', '/api/v1/golf/coordinates/course-1', coordinates('other')],
  ['empty coordinates', '/api/v1/golf/coordinates/course-1', { courseID: 'course-1', coordinates: [] }],
  ['out-of-range coordinates', '/api/v1/golf/coordinates/course-1', { courseID: 'course-1',
    coordinates: [{ poi: 1, hole: 1, latitude: 91, longitude: 12 }] }],
  ['nonnumeric coordinates', '/api/v1/golf/coordinates/course-1', { courseID: 'course-1',
    coordinates: [{ poi: 'x', hole: 1, latitude: 57, longitude: 12 }] }],
  ['missing search array', '/api/v1/golf/clubs?name=Links', {}],
  ['missing club ID', '/api/v1/golf/clubs?name=Links', { clubs: [{ clubName: 'Links' }] }],
  ['missing course name', '/api/v1/golf/courses?name=Links', { courses: [{ courseID: 'course-1' }] }],
  ['nonobject search item', '/api/v1/golf/courses?name=Links', { courses: [null] }],
  ['array root', '/api/v1/golf/courses/course-1', []]
];
for (const [name, url, body] of badGolf) {
  test(`invalid GolfAPI response is never cached: ${name}`, async t => {
    const f = await fixture(t, {}, () => json(body));
    let app = await f.open();
    errorIs(await request(app, url), 502, 'invalid_provider_response');
    assert.deepEqual(f.rows('responses'), []);
    assert.equal(f.rows('usage')[0].attempts, 1);
    await f.close(app);
    app = await f.open();
    errorIs(await request(app, url, { headers: { 'x-cache-only': 'true' } }), 404, 'cache_miss');
    errorIs(await request(app, url), 503, 'provider_cooldown');
    assert.equal(f.calls.length, 1);
  });
}

const badElevation = [
  ['wrong status', body => { body.status = 'ERROR'; }],
  ['wrong count', body => { body.results.pop(); }],
  ['string elevation', body => { body.results[1].elevation = '100'; }],
  ['null elevation', body => { body.results[1].elevation = null; }],
  ['zero resolution', body => { body.results[1].resolution = 0; }],
  ['missing source', body => { body.results[1].data_source = ' '; }],
  ['out-of-range location', body => { body.results[1].lat = 91; }],
  ['wrong interior location', body => { body.results[1].lat += 0.001; }],
  ['endpoint shifted beyond 2cm', body => { body.results[0].lat += 0.000001; }]
];
for (const [name, corrupt] of badElevation) {
  test(`invalid GPXZ response is never cached: ${name}`, async t => {
    const body = elevation();
    corrupt(body);
    const f = await fixture(t, {}, () => json(body));
    const app = await f.open();
    errorIs(await sample(app), 502, 'invalid_provider_response');
    errorIs(await sample(app, undefined, { headers: { 'x-cache-only': 'true' } }), 404, 'cache_miss');
    assert.deepEqual(f.rows('responses'), []);
    assert.equal(f.rows('usage')[0].attempts, 1);
    assert.equal(f.calls.length, 1);
  });
}

test('429 Retry-After creates provider-wide durable cooldown without retrying or billing cache misses', async t => {
  const f = await fixture(t, {}, (url, options, count) => count === 1
    ? new Response('private provider quota details', { status: 429, headers: { 'retry-after': '120' } })
    : providerReply(url, options));
  let app = await f.open();
  const response = await request(app, '/api/v1/golf/courses/course-1');
  errorIs(response, 502, 'provider_unavailable');
  assert.equal(response.headers['retry-after'], '120');
  assert.ok(!response.body.includes('private'));
  await f.close(app);
  f.advance(30000);
  app = await f.open();
  const blocked = await request(app, '/api/v1/golf/coordinates/another');
  errorIs(blocked, 503, 'provider_cooldown');
  assert.equal(blocked.headers['retry-after'], '90');
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows('usage').find(r => r.provider === 'golf').attempts, 1);
  // GPXZ has its own cooldown and usage ledger.
  assert.equal((await sample(app)).statusCode, 200);
  f.advance(90001);
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).headers['x-cache'], 'MISS');
  assert.equal(f.calls.length, 3);
});

for (const [retry, expected] of [['999999999', 86400], ['0', 1], ['invalid-date', undefined]]) {
  test(`Retry-After ${retry} is bounded and never causes an automatic retry`, async t => {
    const f = await fixture(t, {}, () => new Response('offline quota details', {
      status: 429, headers: { 'retry-after': retry }
    }));
    const app = await f.open();
    const response = await sample(app);
    errorIs(response, 502, 'provider_unavailable');
    assert.equal(response.headers['retry-after'], expected === undefined ? undefined : String(expected));
    const blocked = await sample(app, { path: PATH, samples: 4 });
    errorIs(blocked, 503, 'provider_cooldown');
    assert.equal(blocked.headers['retry-after'], String(Math.max(5, expected ?? 0)));
    assert.equal(f.calls.length, 1);
    assert.equal(f.rows('usage')[0].attempts, 1);
  });
}

for (const provider of ['golf', 'gpxz']) {
  test(`${provider} failed attempts consume persistent budget; UTC next day resets allowance`, async t => {
    const limits = { [provider === 'golf' ? 'GOLF_API_DAILY_LIMIT' : 'GPXZ_DAILY_LIMIT']: '1' };
    const f = await fixture(t, limits, (url, options, count) => {
      if (count === 1) throw new Error('fake timeout containing fake-offline-provider-secret');
      return providerReply(url, options);
    });
    let app = await f.open();
    const invoke = () => provider === 'golf' ? request(app, '/api/v1/golf/courses/course-1') : sample(app);
    errorIs(await invoke(), 502, 'provider_unavailable');
    f.advance(5001);
    await f.close(app);
    app = await f.open();
    errorIs(await invoke(), 503, 'daily_budget_exhausted');
    assert.equal(f.calls.length, 1);
    assert.equal(f.rows('usage').find(r => r.provider === provider).attempts, 1);
    f.advance(86400000);
    const success = await invoke();
    assert.equal(success.statusCode, 200, success.body);
    assert.equal(success.headers['x-cache'], 'MISS');
    assert.equal((await invoke()).headers['x-cache'], 'HIT');
    assert.deepEqual(f.rows('usage').filter(r => r.provider === provider).map(r => r.attempts), [1, 1]);
    assert.equal(f.calls.length, 2);
  });
}

test('successful calls exhaust budget, but cached hits remain available', async t => {
  const f = await fixture(t, { GOLF_API_DAILY_LIMIT: '1', GPXZ_DAILY_LIMIT: '0' });
  const app = await f.open();
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).statusCode, 200);
  errorIs(await request(app, '/api/v1/golf/courses/course-2'), 503, 'daily_budget_exhausted');
  errorIs(await sample(app), 503, 'daily_budget_exhausted');
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).headers['x-cache'], 'HIT');
  assert.equal(f.calls.length, 1);
});

test('SQLite directory lock is exclusive and released on close without losing cache', async t => {
  const f = await fixture(t);
  let app = await f.open();
  await request(app, '/api/v1/golf/courses/course-1');
  const lock = join(f.dir, 'server.lock');
  assert.ok(existsSync(lock));
  assert.equal(statSync(lock).mode & 0o777, 0o600);
  await assert.rejects(f.open(), /Data directory is locked/);
  assert.ok(existsSync(lock), 'failed second instance must not unlink the owner lock');
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).headers['x-cache'], 'HIT');
  await f.close(app);
  assert.equal(existsSync(lock), false);
  app = await f.open();
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).headers['x-cache'], 'HIT');
  assert.equal(f.calls.length, 1);
});

for (const failure of ['exception', 'http body', 'redirect', 'invalid JSON', 'oversized declared', 'oversized streamed']) {
  test(`provider errors are redacted and uncached: ${failure}`, async t => {
    const secret = `${TOKEN} ${GOLF_KEY} ${GPXZ_KEY} https://private.invalid/?key=fake-sensitive`;
    const f = await fixture(t, {}, () => {
      if (failure === 'exception') throw new Error(secret);
      if (failure === 'http body') return new Response(secret, { status: 500 });
      if (failure === 'redirect') return new Response(secret, { status: 302, headers: { location: 'https://private.invalid/' } });
      if (failure === 'invalid JSON') return new Response(secret);
      if (failure === 'oversized declared') return new Response('{}', { headers: { 'content-length': '4000001' } });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(2000001));
        controller.enqueue(new Uint8Array(2000001));
        controller.close();
      } }));
    });
    const app = await f.open();
    const response = await request(app, '/api/v1/golf/courses/course-1');
    errorIs(response, 502, failure.startsWith('oversized') ? 'invalid_provider_response' : 'provider_unavailable');
    for (const value of [TOKEN, GOLF_KEY, GPXZ_KEY, 'private.invalid', 'fake-sensitive']) {
      assert.ok(!response.body.includes(value));
    }
    assert.equal(f.calls.length, 1, 'must not retry or follow redirects');
    assert.equal(f.calls[0].options.redirect, 'error');
    assert.deepEqual(f.rows('responses'), []);
  });
}

test('invalid dataset version is omitted rather than persisted or reflected', async t => {
  const f = await fixture(t, {}, () => json(elevation(), { 'x-dataset-version': 'x'.repeat(201) }));
  const app = await f.open();
  const response = await sample(app);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-dataset-version'], undefined);
  assert.equal(f.rows('responses')[0].dataset_version, null);
});

test('online backup script captures committed WAL data, usage and cooldown while app stays open', async t => {
  const f = await fixture(t, {}, (url, options, count) => count === 2
    ? new Response('fake error', { status: 429, headers: { 'retry-after': '60' } })
    : providerReply(url, options));
  const app = await f.open();
  await request(app, '/api/v1/golf/courses/course-1');
  await request(app, '/api/v1/golf/courses/course-2');
  assert.ok(existsSync(join(f.dir, 'cache.sqlite-wal')));
  const destination = join(f.dir, 'backup', 'snapshot.sqlite');
  const script = fileURLToPath(new URL('../scripts/backup.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, destination], {
    // Explicit environment prevents accidental dotenv/preload or secret inheritance.
    env: { DATA_DIR: f.dir }, timeout: 15000
  });
  assert.match(stdout, /Database backup completed/);
  const backup = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    for (const table of ['responses', 'usage', 'failures']) {
      assert.deepEqual(backup.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })), f.rows(table));
    }
  } finally { backup.close(); }
  assert.equal((await request(app, '/api/v1/golf/courses/course-1')).headers['x-cache'], 'HIT');
  assert.equal(f.calls.length, 2);
});

test('polyline chainages use total length, repeated points normalize and signed zero canonicalizes', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0.001, lon: 0 };
  const c = { lat: 0.001, lon: 0.002 };
  const profile = profileRequest({ path: [{ lat: -0, lon: -0 }, a, b, c], samples: 3 });
  assert.deepEqual(profile.path, [a, b, c]);
  assert.equal(profile.chainages.length, 3);
  assert.ok(Math.abs(profile.length - distance(a, b) - distance(b, c)) < 1e-8);
  assert.deepEqual(pointAt(profile, 0), a);
  assert.deepEqual(pointAt(profile, profile.chainages[1]), b);
  assert.deepEqual(pointAt(profile, profile.length), c);
  assert.ok(pointAt(profile, profile.length / 2).lon > 0);
});

// These are intended safety/geometry contracts, not snapshots of incorrect
// behavior. If they fail, report the implementation bug; do not weaken them.
test('unsupported elevation refresh query is rejected before any billable dispatch', async t => {
  const f = await fixture(t);
  const app = await f.open();
  const response = await sample(app, undefined, { url: '/api/v1/elevation/sample?refresh=true' });
  assert.equal(response.statusCode, 400, 'unknown query parameters must not silently trigger paid fetching');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows('usage'), []);
});

test('a short antimeridian-crossing profile accepts correctly located provider samples', async t => {
  const path = [{ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 }];
  const body = { status: 'OK', results: [path[0], { lat: 0, lon: 180 }, path[1]].map((p, i) => ({
    ...p, elevation: i, resolution: 30, data_source: 'offline-dateline-fixture'
  })) };
  const f = await fixture(t, {}, () => json(body));
  const app = await f.open();
  const response = await sample(app, { path, samples: 3 });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-cache'], 'MISS');
  assert.deepEqual(response.json(), body);
});