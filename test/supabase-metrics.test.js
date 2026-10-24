import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupabaseMetrics } from '../src/supabase-metrics.js';
import { loadConfig, ConfigurationError } from '../src/config.js';
import { buildApp } from '../src/app.js';

const TOKEN = 'offline-client-token-not-real-0123456789';
const ADMIN = 'offline-admin-token-not-real-9876543210';
const KEY = 'eyJoffline_service_role_fixture';
const URL_ROOT = 'https://offline-project.supabase.co';
const EPOCH = Date.parse('2026-10-24T12:00:00Z');
const AUTH = { authorization: `Bearer ${ADMIN}` };
const settings = { url: URL_ROOT, key: KEY };
const originalFetch = globalThis.fetch;
let unexpectedCalls = 0;
before(() => {
  globalThis.fetch = () => { unexpectedCalls++; throw new Error('No network allowed'); };
});
after(() => { globalThis.fetch = originalFetch; assert.equal(unexpectedCalls, 0); });
function payload() {
  return { schemaVersion: 1, generatedAt: '2026-10-24T12:00:00.123456Z',
    trackingStartedAt: '2026-10-23T00:00:00.000000Z', historyComplete: false,
    activityDefinition: 'signed_in_last_30_days',
    users: { current: '3', active30d: '2', knownRegistrations: '5', knownDeletions: '1' },
    storage: { currentUserSyncBytes: '12', recordsBytes: '6', historyBytes: '4', receiptsBytes: '2',
      averageBytesPerUser: '4', maxBytesPerUser: '8', syncPhysicalBytes: '8192', databaseBytes: '16384',
      objectStorageBytes: null } };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function client(fetchImpl, config = settings) {
  let clock = EPOCH;
  const metrics = new SupabaseMetrics(config, { fetchImpl, now: () => clock });
  return { metrics, advance(ms) { clock += ms; } };
}
function env(overrides = {}) {
  return { SERVER_API_TOKEN: TOKEN, ADMIN_API_TOKEN: ADMIN,
    SUPABASE_URL: URL_ROOT, SUPABASE_SERVICE_ROLE_KEY: KEY, ...overrides };
}
function safeUnavailable(result) {
  assert.deepEqual(result, { status: 'unavailable', fetchedAt: null, data: null,
    message: 'Account metrics are temporarily unavailable.' });
}

test('optional config is disabled only with both values blank; valid custom HTTPS roots and opaque keys', () => {
  assert.equal(loadConfig(env({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' })).supabaseMetrics, null);
  assert.equal(loadConfig({ SERVER_API_TOKEN: TOKEN }).supabaseMetrics, null);
  for (const key of [KEY, 'sb_secret_fixture', 'eyJfixture.header.signature']) {
    assert.deepEqual(loadConfig(env({ SUPABASE_URL: 'https://metrics.example.com/',
      SUPABASE_SERVICE_ROLE_KEY: key })).supabaseMetrics, { url: 'https://metrics.example.com', key });
  }
});

test('unsafe configuration always throws a fixed ConfigurationError, never values', () => {
  const anon = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"anon"}').toString('base64url')}.fixture`;
  const invalid = [
    ...['', 'http://example.com', 'https://user:private@example.com', 'https://example.com/path',
      'https://example.com/?secret', 'https://example.com?', 'https://example.com#',
      'https://example.com/#secret', ' https://example.com', 'https://example.com\n',
      'https://example.com/..', 'https://example.com\\', 'https://localhost',
      'https://host.local', 'https://127.0.0.1', 'https://10.1.2.3', 'https://[::1]',
      'https://2130706433', 'https://host.internal', 'https://example..com',
      'https://example.com:99999'].map(SUPABASE_URL => ({ SUPABASE_URL })),
    ...['', 'anon', 'sb_publishable_fixture', anon, 'sb_secret_', 'sb_secret_fixture\r\nHeader:secret',
      'sb_secret_ fixture', ' sb_secret_fixture', 'sb_secret_fixture\t', 'sb_secret_å',
      `sb_secret_${'a'.repeat(8192)}`].map(SUPABASE_SERVICE_ROLE_KEY => ({ SUPABASE_SERVICE_ROLE_KEY }))
  ];
  for (const override of invalid) assert.throws(() => loadConfig(env(override)), error => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.message, 'Configure a valid HTTPS Supabase root URL and server-only service key together');
    return true;
  });
});

test('disabled client never dispatches and has the exact envelope', async () => {
  const f = client(() => assert.fail('disabled dispatch'), null);
  assert.deepEqual(await f.metrics.get(), { status: 'disabled', fetchedAt: null, data: null,
    message: 'Account metrics are not configured.' });
});

test('fixed POST RPC, secret gateway versus JWT headers, and explicit PII-free normalization', async () => {
  for (const key of [KEY, 'sb_secret_fixture']) {
    let calls = 0;
    const raw = payload();
    raw.email = 'private@example.com'; raw.users.identities = [{ id: 'private-user-id' }];
    raw.storage.secret = key;
    const f = client(async (url, options) => {
      calls++;
      assert.equal(url, `${URL_ROOT}/rest/v1/rpc/pintheory_admin_account_metrics`);
      assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
      assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(options.headers, { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json',
        ...(key === KEY ? { Authorization: `Bearer ${key}` } : {}) });
      return json(raw);
    }, { url: URL_ROOT, key });
    assert.equal(calls, 0);
    const result = await f.metrics.get();
    const expected = payload();
    for (const section of ['users', 'storage']) for (const [name, value] of Object.entries(expected[section])) {
      if (value !== null) expected[section][name] = Number(value);
    }
    assert.deepEqual(result, { status: 'ready', fetchedAt: new Date(EPOCH).toISOString(), data: expected,
      message: 'Account metrics are ready.' });
    assert.equal(calls, 1);
    for (const secret of [key, 'private@example.com', 'private-user-id', 'apikey', 'Authorization']) {
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  }
});

test('success singleflight, exactly 60s TTL, defensive copies, and completion-based expiry', async () => {
  const gate = deferred();
  let calls = 0;
  const f = client(async () => { calls++; await gate.promise; return json(payload()); });
  const pending = Array.from({ length: 8 }, () => f.metrics.get());
  assert.equal(calls, 1);
  f.advance(5000); gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results[0].fetchedAt, new Date(EPOCH + 5000).toISOString());
  results[0].data.users.current = 999;
  assert.equal(results[1].data.users.current, 3);
  f.advance(59999);
  assert.equal((await f.metrics.get()).data.users.current, 3); assert.equal(calls, 1);
  f.advance(1); await f.metrics.get(); assert.equal(calls, 2);
});

test('failure singleflight, 15s cooldown, recovery and stale original timestamp', async () => {
  let calls = 0;
  let fail = true;
  let gate = deferred();
  const f = client(async () => { calls++; await gate.promise;
    if (fail) throw new Error(`${KEY} private upstream body headers URL`);
    return json(payload());
  });
  const pending = [f.metrics.get(), f.metrics.get()];
  assert.equal(calls, 1); gate.resolve();
  for (const result of await Promise.all(pending)) safeUnavailable(result);
  f.advance(14999); safeUnavailable(await f.metrics.get()); assert.equal(calls, 1);
  f.advance(1); fail = false;
  const ready = await f.metrics.get(); assert.equal(ready.status, 'ready'); assert.equal(calls, 2);
  f.advance(60000); fail = true; gate = deferred();
  const staleRequests = [f.metrics.get(), f.metrics.get()];
  assert.equal(calls, 3); gate.resolve();
  const stale = (await Promise.all(staleRequests))[0];
  assert.equal(stale.status, 'unavailable'); assert.deepEqual(stale.data, ready.data);
  assert.equal(stale.fetchedAt, ready.fetchedAt); assert.match(stale.message, /stale/);
  f.advance(14999); assert.deepEqual(await f.metrics.get(), stale); assert.equal(calls, 3);
  f.advance(1); fail = false;
  assert.equal((await f.metrics.get()).status, 'ready'); assert.equal(calls, 4);
});

test('strict contract rejects malformed fields, unsafe counters, dates and inconsistent totals', async () => {
  const mutations = [
    raw => { raw.schemaVersion = '1'; }, raw => { raw.historyComplete = 'false'; },
    raw => { raw.activityDefinition = 'recent'; }, raw => { delete raw.users; },
    raw => { raw.storage = []; }, raw => { raw.generatedAt = '2026-02-30T12:00:00Z'; },
    raw => { raw.generatedAt = 'yesterday'; }, raw => { raw.trackingStartedAt = '2027-01-01T00:00:00Z'; },
    raw => { raw.users.active30d = '4'; }, raw => { raw.users.knownRegistrations = '2'; },
    raw => { raw.storage.currentUserSyncBytes = '13'; }, raw => { raw.storage.objectStorageBytes = '0'; },
    raw => { raw.storage.averageBytesPerUser = '3'; }, raw => { raw.storage.maxBytesPerUser = '13'; },
    raw => { raw.storage.maxBytesPerUser = '3'; }, raw => { raw.users.current = '0'; raw.users.active30d = '0'; }
  ];
  for (const section of ['users', 'storage']) {
    for (const field of Object.keys(payload()[section]).filter(field => field !== 'objectStorageBytes')) {
      for (const value of [undefined, null, 2, '-1', '1.2', '1e3', ' 1', '01', '', '9007199254740992']) {
        mutations.push(raw => { raw[section][field] = value; });
      }
    }
  }
  for (const mutate of mutations) {
    const raw = payload(); mutate(raw);
    safeUnavailable(await client(async () => json(raw)).metrics.get());
  }
  for (const raw of [null, [], 'private@example.com', {}, { ...payload(), historyComplete: true }]) {
    const result = await client(async () => json(raw)).metrics.get();
    if (raw?.historyComplete === true) assert.equal(result.status, 'ready');
    else safeUnavailable(result);
  }
  const zero = payload();
  for (const field of Object.keys(zero.users)) zero.users[field] = '0';
  for (const field of Object.keys(zero.storage)) if (field !== 'objectStorageBytes') zero.storage[field] = '0';
  assert.equal((await client(async () => json(zero)).metrics.get()).status, 'ready');
});

test('HTTP, redirect, JSON and stream errors are redacted, do not retry and cancel bodies', async () => {
  for (const status of [301, 401, 403, 404, 429, 500]) {
    let cancelled = false;
    let calls = 0;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = client(async () => { calls++; return new Response(body, { status }); });
    safeUnavailable(await f.metrics.get());
    assert.equal(cancelled, true); assert.equal(calls, 1);
  }
  for (const fetchImpl of [
    async () => { throw new Error(`${KEY} https://user:password@example.com raw response`); },
    async () => new Response(`not-json-${KEY}`),
    async () => new Response(new Uint8Array([0xff])),
    async () => { const response = json(payload()); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(KEY)); } }))
  ]) safeUnavailable(await client(fetchImpl).metrics.get());
});

test('streaming cap is 256 KiB, ignores Content-Length and cancels on overflow', async () => {
  for (const declared of ['1', '99999999']) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
      cancel() { cancelled = true; }
    });
    safeUnavailable(await client(async () => new Response(body, { headers: { 'content-length': declared } })).metrics.get());
    assert.equal(cancelled, true);
  }
  for (const size of [256 * 1024, 256 * 1024 + 1]) {
    const text = JSON.stringify(payload());
    const response = new Response(text + ' '.repeat(size - Buffer.byteLength(text)));
    const result = await client(async () => response).metrics.get();
    assert.equal(result.status, size === 256 * 1024 ? 'ready' : 'unavailable');
  }
});

test('10 second deadline covers ignored fetch abort and stalled streamed body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const f = client(async (url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = f.metrics.get();
  t.mock.timers.tick(9999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); safeUnavailable(await pending); assert.equal(signal.aborted, true);
  let cancelled = false;
  const started = deferred();
  const stalled = client(async () => new Response(new ReadableStream({
    pull() { started.resolve(); }, cancel() { cancelled = true; }
  })));
  const reading = stalled.metrics.get();
  await started.promise;
  t.mock.timers.tick(10000); safeUnavailable(await reading); assert.equal(cancelled, true);
});

test('admin-only route is isolated, validates queries before dispatch, and never persists aggregates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'offline-supabase-metrics-'));
  const apps = new Set();
  t.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  let calls = 0;
  const app = await buildApp(loadConfig(env({ DATA_DIR: dir })), {
    now: () => EPOCH,
    fetchImpl: () => assert.fail('Supabase must not use the paid-provider fetch'),
    supabaseFetchImpl: async () => { calls++; return json(payload()); }
  });
  apps.add(app);
  assert.equal(calls, 0);
  for (const url of ['/healthz', '/admin', '/api/admin/overview']) {
    assert.equal((await app.inject({ url, headers: AUTH })).statusCode, 200);
  }
  for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }, { authorization: 'Bearer wrong' }]) {
    assert.equal((await app.inject({ url: '/api/admin/accounts', headers })).statusCode, 401);
  }
  assert.equal((await app.inject({ url: '/api/admin/accounts?refresh=true', headers: AUTH })).statusCode, 400);
  assert.equal(calls, 0);
  const response = await app.inject({ url: '/api/admin/accounts', headers: AUTH });
  assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'ready'); assert.equal(calls, 1);
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const secret of [KEY, URL_ROOT, ADMIN, TOKEN, 'apikey', 'Authorization']) assert.ok(!response.body.includes(secret));
  const overview = await app.inject({ url: '/api/admin/overview', headers: AUTH });
  assert.equal(overview.statusCode, 200); assert.equal(overview.json().accounts, undefined); assert.equal(calls, 1);
  await app.close();
  apps.delete(app);
  // New instance has no metrics cache on disk: next explicit account GET must fetch.
  const reopened = await buildApp(loadConfig(env({ DATA_DIR: dir })), {
    supabaseFetchImpl: async () => { calls++; throw new Error(KEY); }
  });
  apps.add(reopened);
  assert.equal(calls, 1);
  const unavailable = await reopened.inject({ url: '/api/admin/accounts', headers: AUTH });
  assert.equal(unavailable.statusCode, 200); safeUnavailable(unavailable.json()); assert.equal(calls, 2);
  assert.equal((await reopened.inject({ url: '/api/admin/overview', headers: AUTH })).statusCode, 200);
  assert.equal(calls, 2);
});

test('disabled metrics return HTTP 200; disabled admin still blocks all dispatch', async t => {
  for (const adminEnabled of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), 'offline-disabled-metrics-'));
    const app = await buildApp(loadConfig(env({ DATA_DIR: dir, ADMIN_API_TOKEN: adminEnabled ? ADMIN : '',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' })), {
      supabaseFetchImpl: () => assert.fail('disabled request')
    });
    t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
    const response = await app.inject({ url: '/api/admin/accounts', headers: AUTH });
    assert.equal(response.statusCode, adminEnabled ? 200 : 503);
    if (adminEnabled) assert.deepEqual(response.json(), { status: 'disabled', fetchedAt: null,
      data: null, message: 'Account metrics are not configured.' });
  }
});