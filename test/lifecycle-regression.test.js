import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Explicit fake configuration only: never load .env or inherit provider keys.
const TOKEN = 'offline-lifecycle-token-not-a-secret-0123456789';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const EPOCH = Date.parse('2026-10-23T12:00:00.000Z');
const DAY = 86400000;
const PATH = [{ lat: 57, lon: 12 }, { lat: 57.001, lon: 12.002 }];
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
  assert.equal(defaultFetchCalls, 0, 'all upstream work must use the fake transport');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function providerReply(url, options) {
  const parsed = new URL(url);
  if (parsed.hostname === 'api.gpxz.io') {
    const form = new URLSearchParams(options.body);
    const endpoints = form.get('latlons').split('|').map(pair => pair.split(',').map(Number));
    assert.equal(endpoints.length, 2);
    const samples = Number(form.get('samples'));
    return json({ status: 'OK', results: Array.from({ length: samples }, (_, i) => ({
      lat: endpoints[0][0] + (endpoints[1][0] - endpoints[0][0]) * i / (samples - 1),
      lon: endpoints[0][1] + (endpoints[1][1] - endpoints[0][1]) * i / (samples - 1),
      elevation: 100 + i, resolution: 30, data_source: 'offline-lifecycle-fixture'
    })) });
  }
  assert.equal(parsed.hostname, 'golfapi.io');
  const parts = parsed.pathname.split('/');
  const id = parts.at(-1);
  if (parts.at(-2) === 'coordinates') return json({ courseID: id, coordinates: [
    { poi: '1', hole: '1', latitude: '57', longitude: '12' }
  ] });
  if (parts.at(-2) === 'courses') return json({ courseID: id, courseName: 'Offline Links' });
  assert.ok(['clubs', 'courses'].includes(id));
  return json({ [id]: [id === 'clubs'
    ? { clubID: 'club-1', clubName: 'Offline Club' }
    : { courseID: 'course-1', courseName: 'Offline Links' }] });
}

async function fixture(t, respond = providerReply) {
  const dir = await mkdtemp(join(tmpdir(), 'fairwayvector-lifecycle-'));
  const apps = new Set();
  const calls = [];
  let clock = EPOCH;
  t.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  return {
    dir, calls,
    advance(ms) { clock += ms; },
    async open(overrides = {}) {
      const config = loadConfig({
        SERVER_API_TOKEN: TOKEN, DATA_DIR: dir,
        GOLF_API_ENABLED: 'true', GOLF_API_KEY: 'fake-lifecycle-golf-key',
        GPXZ_API_ENABLED: 'true', GPXZ_API_KEY: 'fake-lifecycle-gpxz-key',
        GOLF_API_DAILY_LIMIT: '1000', GPXZ_DAILY_LIMIT: '1000',
        FAILURE_COOLDOWN_SECONDS: '5', RATE_LIMIT_PER_MINUTE: '10000', ...overrides
      });
      const app = await buildApp(config, { now: () => clock, logger: false,
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
    async close(app) { await app.close(); apps.delete(app); },
    rows(table) {
      assert.ok(['responses', 'failures', 'usage'].includes(table));
      const db = new DatabaseSync(join(dir, 'cache.sqlite'), { readOnly: true });
      try { return db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
      finally { db.close(); }
    }
  };
}

function request(app, url, headers = {}) {
  return app.inject({ method: 'GET', url, headers: { ...AUTH, ...headers } });
}
function sample(app, samples = 3, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/elevation/sample',
    headers: { ...AUTH, ...headers }, payload: { path: PATH, samples } });
}
function errorIs(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['x-cache'], undefined);
}
function hitIs(response, expected) {
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-cache'], 'HIT');
  assert.deepEqual(response.json(), expected.json());
  assert.equal(response.headers['x-fetched-at'], expected.headers['x-fetched-at']);
}

for (const kind of ['clubs', 'courses']) {
  test(`${kind} timestampUpdated probes expire at 24h, including empty results across restart`, async t => {
    const f = await fixture(t, (url, options, count) => count === 1
      ? json({ [kind]: [] }) : providerReply(url, options));
    const url = `/api/v1/golf/${kind}?country=Sweden&name=Links&timestampUpdated=123`;
    let app = await f.open();
    const first = await request(app, url);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['x-cache'], 'MISS');
    assert.deepEqual(first.json(), { [kind]: [] });
    await f.close(app);
    f.advance(DAY - 1);
    app = await f.open();
    hitIs(await request(app, url), first);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    hitIs(await request(app, url, { 'x-cache-only': 'true' }), first);
    await f.close(app);
    app = await f.open({ GOLF_API_ENABLED: 'false', GOLF_API_KEY: '' });
    hitIs(await request(app, url), first);
    assert.equal(f.calls.length, 1, 'stale read-only probes must not spend');
    await f.close(app);
    app = await f.open();
    const refreshed = await request(app, url);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.headers['x-cache'], 'MISS');
    assert.equal(refreshed.json()[kind].length, 1);
    assert.equal(refreshed.headers['x-fetched-at'], new Date(EPOCH + DAY).toISOString());
    assert.equal(f.calls.length, 2);
    hitIs(await request(app, url), refreshed);
    const rows = f.rows('responses');
    assert.equal(rows.length, 1, 'refresh replaces the same canonical probe key');
    assert.equal(rows[0].fetched_at, EPOCH + DAY);
    assert.deepEqual(JSON.parse(rows[0].body), refreshed.json());
    assert.equal(f.rows('usage').reduce((sum, row) => sum + row.attempts, 0), 2);
  });
}

test('ordinary searches, detail, coordinates and elevation remain durable beyond 24h and restart', async t => {
  const f = await fixture(t);
  let app = await f.open();
  const urls = ['/api/v1/golf/clubs?country=Sweden&name=Links',
    '/api/v1/golf/courses?country=Sweden&name=Links',
    '/api/v1/golf/courses/course-1', '/api/v1/golf/coordinates/course-1'];
  const saved = [];
  for (const url of urls) saved.push(await request(app, url));
  saved.push(await sample(app));
  for (const response of saved) {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['x-cache'], 'MISS');
  }
  const rows = f.rows('responses');
  const usage = f.rows('usage');
  await f.close(app);
  f.advance(365 * DAY);
  app = await f.open();
  for (const [i, url] of urls.entries()) hitIs(await request(app, url), saved[i]);
  hitIs(await sample(app), saved.at(-1));
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.rows('responses'), rows);
  assert.deepEqual(f.rows('usage'), usage, 'durable hits must not reserve a new-day budget');
});

for (const provider of ['golf', 'gpxz']) {
  for (const failure of ['404', 'invalid data']) {
    test(`${provider} ${failure} persists only a per-key lock, not a provider-wide lock`, async t => {
      const f = await fixture(t, (url, options, count) => count === 1
        ? failure === '404' ? new Response('offline missing resource', { status: 404 }) : json({})
        : providerReply(url, options));
      const invoke = (app, alternate = false) => provider === 'golf'
        ? request(app, `/api/v1/golf/courses/${alternate ? 'other' : 'missing'}`)
        : sample(app, alternate ? 4 : 3);
      let app = await f.open();
      errorIs(await invoke(app), 502, failure === '404' ? 'provider_unavailable' : 'invalid_provider_response');
      assert.deepEqual(f.rows('responses'), []);
      const locks = f.rows('failures');
      assert.equal(locks.length, 1);
      assert.ok(!locks[0].key.startsWith('provider:'));
      assert.equal(locks[0].until_ms, EPOCH + 5000);
      await f.close(app);
      app = await f.open();
      const blocked = await invoke(app);
      errorIs(blocked, 503, 'provider_cooldown');
      assert.equal(blocked.headers['retry-after'], '5');
      assert.equal(f.calls.length, 1);
      const unrelated = await invoke(app, true);
      assert.equal(unrelated.statusCode, 200, unrelated.body);
      assert.equal(unrelated.headers['x-cache'], 'MISS');
      assert.equal(f.calls.length, 2, 'an unrelated key must remain fetchable immediately');
      assert.deepEqual(f.rows('failures'), locks);
      assert.equal(f.rows('usage')[0].attempts, 2);
      f.advance(5000);
      const recovered = await invoke(app);
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.headers['x-cache'], 'MISS');
      assert.equal(f.calls.length, 3);
    });
  }

  test(`${provider} 429 persists a provider-wide lock but permits cached hits and the other provider`, async t => {
    const f = await fixture(t, (url, options, count) => count === 2
      ? new Response('offline quota exceeded', { status: 429, headers: { 'retry-after': '120' } })
      : providerReply(url, options));
    const invoke = (app, key) => provider === 'golf'
      ? request(app, `/api/v1/golf/courses/course-${key}`) : sample(app, key + 2);
    let app = await f.open();
    const saved = await invoke(app, 1);
    assert.equal(saved.statusCode, 200, saved.body);
    const failed = await invoke(app, 2);
    errorIs(failed, 502, 'provider_unavailable');
    assert.equal(failed.headers['retry-after'], '120');
    const locks = f.rows('failures');
    assert.equal(locks.length, 2);
    assert.equal(locks.find(row => row.key === `provider:${provider}`).until_ms, EPOCH + 120000);
    assert.equal(f.rows('usage').find(row => row.provider === provider).attempts, 2);
    await f.close(app);
    f.advance(30000);
    app = await f.open();
    for (const key of [2, 3]) {
      const blocked = await invoke(app, key);
      errorIs(blocked, 503, 'provider_cooldown');
      assert.equal(blocked.headers['retry-after'], '90');
    }
    hitIs(await invoke(app, 1), saved);
    assert.equal(f.calls.length, 2);
    const other = provider === 'golf' ? await sample(app) : await request(app, '/api/v1/golf/courses/other');
    assert.equal(other.statusCode, 200, other.body);
    assert.deepEqual(f.rows('failures'), locks);
    assert.equal(f.rows('usage').find(row => row.provider === provider).attempts, 2);
    f.advance(90000);
    const recovered = await invoke(app, 3);
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.headers['x-cache'], 'MISS');
    assert.equal(f.calls.length, 4, 'no automatic retry or blocked-key dispatch');
  });
}

test('oversized declared response cancels and awaits the unread body without caching or provider-wide blocking',
  { timeout: 10000 }, async t => {
  const cancelled = deferred();
  const releaseCancel = deferred();
  let bodyController;
  let cancellations = 0;
  // Release gates before fixture cleanup, even if an assertion fails.
  t.after(() => {
    releaseCancel.resolve();
    // If cancellation regresses, also finish a possible pending stream read so
    // app.close() in fixture cleanup cannot hang behind that broken behavior.
    if (bodyController && cancellations === 0) bodyController.close();
  });
  let pulls = 0;
  const f = await fixture(t, (url, options, count) => count === 1
    ? new Response(new ReadableStream({
      start(controller) { bodyController = controller; },
      pull() { pulls++; },
      cancel() { cancellations++; cancelled.resolve(); return releaseCancel.promise; }
    }, { highWaterMark: 0 }), { headers: { 'content-length': '4000001' } })
    : providerReply(url, options));
  const app = await f.open();
  let settled = false;
  const response = request(app, '/api/v1/golf/courses/oversized').then(value => {
    settled = true;
    return value;
  });
  await cancelled.promise;
  assert.equal(settled, false, 'request must await cancellation completion');
  assert.equal(cancellations, 1);
  assert.equal(pulls, 0, 'declared oversize must be rejected without reading any body');
  releaseCancel.resolve();
  errorIs(await response, 502, 'invalid_provider_response');
  assert.deepEqual(f.rows('responses'), []);
  assert.equal(f.rows('failures').length, 1);
  assert.ok(!f.rows('failures')[0].key.startsWith('provider:'));
  errorIs(await request(app, '/api/v1/golf/courses/oversized'), 503, 'provider_cooldown');
  const other = await request(app, '/api/v1/golf/courses/other');
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(f.calls.length, 2);
  assert.equal(f.rows('usage')[0].attempts, 2);
});

test('shutdown drains upstream work detached by a real localhost client abort before releasing the directory lock',
  { timeout: 10000 }, async t => {
    const entered = deferred();
    const release = deferred();
    const disconnected = deferred();
    const clientClosed = deferred();
    const serverClosed = deferred();
    let client;
    t.after(() => { release.resolve(); client?.destroy(); });
    const f = await fixture(t, async (url, options) => {
      entered.resolve();
      await release.promise;
      return providerReply(url, options);
    });
    const app = await f.open();
    app.server.once('connection', socket => socket.once('close', disconnected.resolve));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const clientErrors = [];
    client = get({ hostname: '127.0.0.1', port: app.server.address().port,
      path: '/api/v1/golf/courses/detached', headers: AUTH, agent: false });
    client.on('error', error => clientErrors.push(error));
    client.once('close', clientClosed.resolve);
    await entered.promise;
    client.destroy();
    await Promise.all([clientClosed.promise, disconnected.promise]);
    assert.ok(client.destroyed);
    assert.ok(clientErrors.every(error => error.code === 'ECONNRESET'));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.rows('responses'), []);
    assert.equal(f.rows('usage')[0].attempts, 1, 'detached work has already reserved its attempt');

    app.server.once('close', serverClosed.resolve);
    let closed = false;
    const closing = f.close(app).then(() => { closed = true; });
    // Observe rejection immediately; await the same promise below for assertion reporting.
    closing.catch(() => {});
    await serverClosed.promise;
    // One event-loop barrier after actual server close, not a sleep/poll loop:
    // Fastify has had a chance to run its onClose hooks while upstream is gated.
    await nextTurn();
    assert.equal(closed, false, 'close must wait even though the HTTP client is gone');
    const lock = join(f.dir, 'server.lock');
    assert.equal(existsSync(lock), true);
    await assert.rejects(f.open(), /Data directory is locked/);
    assert.equal(existsSync(lock), true, 'failed contender must not remove the owner lock');

    release.resolve();
    await closing;
    assert.equal(closed, true);
    assert.equal(existsSync(lock), false);
    const rows = f.rows('responses');
    assert.equal(rows.length, 1, 'detached success must commit before cache close');
    assert.equal(rows[0].key, 'golf:v1:detail:detached');
    assert.deepEqual(JSON.parse(rows[0].body), { courseID: 'detached', courseName: 'Offline Links' });
    assert.equal(rows[0].fetched_at, EPOCH);
    assert.deepEqual(f.rows('failures'), [], 'no write-after-close failure');
    const reopened = await f.open();
    const saved = await request(reopened, '/api/v1/golf/courses/detached', { 'x-cache-only': 'true' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.headers['x-cache'], 'HIT');
    assert.deepEqual(saved.json(), JSON.parse(rows[0].body));
    assert.equal(saved.headers['x-fetched-at'], new Date(EPOCH).toISOString());
    assert.equal(f.calls.length, 1, 'reopening must not fetch the detached result again');
    assert.equal(f.rows('usage')[0].attempts, 1);
    await f.close(reopened);
    assert.equal(existsSync(lock), false);
  });