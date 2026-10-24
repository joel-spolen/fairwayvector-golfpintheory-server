import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig, ConfigurationError } from '../src/config.js';
import { SupabaseRPC } from '../src/supabase-rpc.js';
import { normalizeOverview } from '../src/admin-overview.js';

const HOST = '127.0.0.1:8080';
const KEY = 'sb_secret_offline_fixture';
const ROOT = 'https://offline-project.supabase.co';
const PROFILE = `gpxz:sample:v1:${'a'.repeat(64)}`;
const DATE = '2026-10-24T12:00:00.000Z';
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => assert.fail('Unexpected real network request'); });
after(() => { globalThis.fetch = originalFetch; });
const config = overrides => loadConfig({ SUPABASE_URL: ROOT, SUPABASE_SERVICE_ROLE_KEY: KEY, ...overrides });
const json = value => new Response(JSON.stringify(value));
function overview() {
  return {
    generatedAt: DATE, trackingStartedAt: DATE, period: { days: 7, label: 'Last 7 days' },
    traffic: { requests: 0, completed: 0, cacheHits: 0, fetched: 0, coalesced: 0, errors: 0, upstreamCalls: 0, cacheHitRate: null },
    providers: ['golf', 'gpxz'].map(id => ({ id, name: id === 'golf' ? 'GolfAPI' : 'GPXZ',
      enabled: false, dailyLimit: 100, cooldownSeconds: 0, upstreamCalls: 0, todayCalls: 0 })),
    daily: [{ day: '2026-10-24', requests: 0, cacheHits: 0, coalesced: 0, upstreamCalls: 0, errors: 0 }],
    inventory: { courseCount: 1, elevationProfiles: 1, elevationSamples: 2, elevationBytes: 200,
      elevationLengthMeters: 100.5, lengthEstimated: false, unassignedProfiles: 1 },
    courses: { total: 1, page: 1, pageSize: 25, items: [{ id: 'A', name: 'Offline links', clubName: 'Club', country: 'SE',
      hasDetail: true, hasCoordinates: false, coordinateCount: 0, numHoles: 18, detailFetchedAt: DATE, coordinatesFetchedAt: null,
      elevation: { profiles: 0, samples: 0, bytes: 0, lengthMeters: 0, lengthEstimated: false, lastFetchedAt: null } }] },
    unassigned: { total: 1, items: [{ key: PROFILE, samples: 2, bytes: 200, lengthMeters: 100.5,
      lengthEstimated: false, fetchedAt: DATE, start: { lat: 57, lon: 12 }, end: { lat: 57.001, lon: 12 } }] },
    courseOptions: [{ id: 'A', name: 'Offline links' }]
  };
}
async function fixture(t, settings = config(), reply = () => json(overview())) {
  const calls = [];
  const app = await buildApp(settings, { fetchImpl: async (url, options) => { calls.push({ url, options }); return reply(url, options); } });
  t.after(() => app.close());
  const inject = (url, extra = {}) => app.inject({ url, ...extra, headers: { host: HOST, ...extra.headers } });
  return { app, calls, inject };
}

test('token-free config ignores deprecated settings and binds only explicit loopback', async () => {
  const settings = loadConfig({ SERVER_API_TOKEN: 'bad', ADMIN_API_TOKEN: 'bad', DATA_DIR: '/unused',
    GOLF_API_ENABLED: 'INVALID', GPXZ_API_KEY: 'unused', PORT: '0' });
  assert.deepEqual(settings, { host: '127.0.0.1', port: 0, supabaseMetrics: null });
  assert.equal(loadConfig({}).port, 8080);
  for (const host of ['', 'localhost', '0.0.0.0', '::', '192.168.1.2', '127.0.0.2', '[::1]', 'evil.example']) {
    assert.throws(() => loadConfig({ HOST: host }), ConfigurationError);
    await assert.rejects(buildApp({ host, port: 8080 }), ConfigurationError);
  }
  assert.equal(loadConfig({ HOST: '::1' }).host, '::1');
  for (const port of ['-1', '65536', '1.5', 'NaN']) assert.throws(() => loadConfig({ PORT: port }), ConfigurationError);
});

test('startup is side-effect-free, optional setup is visible, shell is login-free and fixed files only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'local-admin-no-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, loadConfig({ DATA_DIR: join(dir, 'absent') }));
  assert.equal(f.calls.length, 0);
  for (const url of ['/', '/admin', '/admin/', '/admin/admin.js', '/admin/admin.css', '/healthz']) {
    const result = await f.inject(url);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    if (url !== '/healthz') {
      assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal(result.headers['x-frame-options'], 'DENY');
    }
  }
  const html = (await f.inject('/admin')).body;
  assert.doesNotMatch(html, /type="password"|login-form|admin-token|logout|Authentication required/);
  const js = (await f.inject('/admin/admin.js')).body;
  assert.match(js, /X-Local-Admin/); assert.match(js, /DOMContentLoaded/);
  assert.doesNotMatch(js, /Authorization|ADMIN_API_TOKEN|localStorage|sessionStorage/);
  assert.equal((await f.inject('/api/admin/overview')).statusCode, 503);
  assert.equal((await f.inject('/api/admin/accounts')).json().status, 'disabled');
  for (const url of ['/.env', '/data/cache.sqlite', '/src/config.js', '/admin/config.js']) {
    assert.equal((await f.inject(url)).statusCode, 404);
  }
  assert.deepEqual(await readdir(dir), []);
  assert.equal(f.calls.length, 0);
});

test('exact Host and Origin plus direct loopback socket guard all routes before remote work', async t => {
  const f = await fixture(t);
  for (const host of ['evil.example:8080', 'localhost', 'localhost:9999', '127.0.0.1', '127.0.0.2:8080',
    '127.1:8080', '2130706433:8080', 'localhost.:8080', 'LOCALHOST:8080', 'localhost:08080', '127.0.0.1:8080.evil.example', '[::1]:8080']) {
    for (const url of ['/admin', '/healthz', '/api/admin/overview', '/api/admin/accounts']) {
      assert.equal((await f.inject(url, { headers: { host } })).statusCode, 403, host);
    }
  }
  for (const origin of ['null', 'https://localhost:8080', 'http://evil.example', 'http://localhost:8080',
    'http://127.0.0.1:9999', 'http://127.0.0.1:8080/']) {
    assert.equal((await f.inject('/api/admin/overview', { headers: { origin } })).statusCode, 403);
  }
  for (const remoteAddress of ['10.0.0.1', '192.168.1.4', '::ffff:10.0.0.1', '2001:db8::1']) {
    assert.equal((await f.inject('/api/admin/overview', { remoteAddress, headers: { 'x-forwarded-for': '127.0.0.1' } })).statusCode, 403);
  }
  for (const url of ['/admin', '/api/admin/overview', '/api/admin/accounts']) {
    assert.equal((await f.inject(url, { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  }
  assert.equal(f.calls.length, 0);
  for (const host of [HOST, 'localhost:8080']) {
    assert.equal((await f.inject('/api/admin/overview', { headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } })).statusCode, 200);
  }
  // A spoofed proxy header cannot override the actual local request or its Host.
  assert.equal((await f.inject('/healthz', { headers: { 'x-forwarded-host': 'evil.example' } })).statusCode, 200);
});

test('POST custom header and same-origin checks reject CSRF before remote dispatch; no CORS', async t => {
  const f = await fixture(t, config(), () => json(true));
  const body = { key: PROFILE, courseID: 'A' };
  for (const headers of [{}, { 'x-local-admin': '0' }, { 'x-local-admin': '1', origin: 'http://evil.example' },
    { 'x-local-admin': '1', 'sec-fetch-site': 'cross-site' }, { 'x-local-admin': '1', host: 'evil.example:8080' }]) {
    assert.equal((await f.inject('/api/admin/elevation/assign', { method: 'POST', payload: body, headers })).statusCode, 403);
  }
  assert.equal((await f.inject('/api/admin/elevation/assign', { method: 'OPTIONS', headers: {
    origin: 'http://evil.example', 'access-control-request-headers': 'x-local-admin' } })).statusCode, 403);
  assert.equal(f.calls.length, 0);
  const result = await f.inject('/api/admin/elevation/assign', { method: 'POST', payload: body,
    headers: { 'x-local-admin': '1', origin: `http://${HOST}` } });
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { ok: true });
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { p_key: PROFILE, p_course_id: 'A' });
  assert.equal(f.calls[0].url, `${ROOT}/rest/v1/rpc/pintheory_data_admin_assign`);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
});

test('removed client APIs return 404 without any provider fallback', async t => {
  const f = await fixture(t);
  for (const url of ['/api/v1/golf/clubs?name=Links', '/api/v1/golf/courses', '/api/v1/golf/courses/A',
    '/api/v1/golf/coordinates/A', '/api/signup', '/api/users']) {
    assert.equal((await f.inject(url)).statusCode, 404);
  }
  assert.equal((await f.inject('/api/v1/elevation/sample', { method: 'POST', payload: {}, headers: { 'x-local-admin': '1' } })).statusCode, 404);
  assert.equal(f.calls.length, 0);
});

test('fixed overview POST uses selected arguments, headers and narrow nested output', async t => {
  const raw = overview();
  raw.rawProvider = { secret: KEY }; raw.inventory.payload = { results: [1, 2] };
  raw.courses.items[0].coordinates = [{ raw: 'private' }]; raw.courses.items[0].elevation.secret = KEY;
  raw.unassigned.items[0].start.secret = KEY; raw.courseOptions[0].secret = KEY;
  const f = await fixture(t, config(), () => json(raw));
  assert.equal(f.calls.length, 0);
  const response = await f.inject('/api/admin/overview?days=7&search=Links&page=2');
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), overview());
  const { url, options } = f.calls[0];
  assert.equal(url, `${ROOT}/rest/v1/rpc/pintheory_data_admin_overview`);
  assert.deepEqual(JSON.parse(options.body), { p_days: 7, p_search: 'Links', p_page: 2 });
  assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { apikey: KEY, 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.doesNotMatch(response.body, /sb_secret_|supabase\.co|rawProvider|coordinates":\[|private/);
});

test('invalid local queries/body never dispatch, and malformed remote contracts fail closed', async t => {
  const f = await fixture(t);
  for (const query of ['days=2', 'page=0', 'page=01', 'refresh=true', `search=${'x'.repeat(201)}`]) {
    assert.equal((await f.inject(`/api/admin/overview?${query}`)).statusCode, 400);
  }
  for (const payload of [{}, { key: PROFILE, courseID: '../A' }, { key: PROFILE, courseID: 'A', url: ROOT }]) {
    assert.equal((await f.inject('/api/admin/elevation/assign', { method: 'POST', payload, headers: { 'x-local-admin': '1' } })).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
  for (const mutate of [r => { delete r.traffic; }, r => { r.inventory.elevationBytes = '200'; },
    r => { r.courses.items[0].elevation.samples = -1; }, r => { r.providers[0].enabled = 'false'; },
    r => { r.courseOptions = Array(1001).fill(r.courseOptions[0]); }, r => { r.providers[1].id = 'golf'; },
    r => { r.unassigned.items[0].start.lat = 91; }, r => { r.generatedAt = '2026-02-30T12:00:00Z'; },
    r => { r.traffic.cacheHitRate = 1.1; }, r => { r.courses.items[0].name = {}; }]) {
    const raw = overview(); mutate(raw);
    assert.throws(() => normalizeOverview(raw));
  }
  const bad = await fixture(t, config(), () => json({ raw: KEY, results: [] }));
  assert.equal((await bad.inject('/api/admin/overview')).statusCode, 503);
});

test('RPC transport redacts remote failures, cancels streams and caps responses at 4 MiB', async () => {
  for (const fetchImpl of [async () => { throw new Error(`${KEY} ${ROOT}`); },
    async () => new Response(KEY, { status: 500 }), async () => new Response(KEY, { status: 302 }),
    async () => new Response(KEY), async () => { const r = json({}); Object.defineProperty(r, 'redirected', { value: true }); return r; }]) {
    const rpc = new SupabaseRPC(config().supabaseMetrics, { fetchImpl });
    await assert.rejects(rpc.call('pintheory_data_admin_overview', {}), error => {
      assert.equal(error.statusCode, 503); assert.ok(!error.message.includes(KEY)); assert.ok(!error.message.includes(ROOT)); return true;
    });
  }
  for (const size of [4 * 1024 * 1024, 4 * 1024 * 1024 + 1]) {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}' + ' '.repeat(size - 2))); }, cancel() { cancelled = true; } });
    // An exact-limit closed response succeeds; overflow must cancel without EOF.
    const rpc = new SupabaseRPC(config().supabaseMetrics, { fetchImpl: async () => size > 4 * 1024 * 1024
      ? new Response(body) : new Response('{}' + ' '.repeat(size - 2)) });
    if (size > 4 * 1024 * 1024) { await assert.rejects(rpc.call('pintheory_data_admin_overview', {})); assert.equal(cancelled, true); }
    else assert.deepEqual(await rpc.call('pintheory_data_admin_overview', {}), {});
  }
  let calls = 0;
  const rpc = new SupabaseRPC(config().supabaseMetrics, { fetchImpl: () => { calls++; } });
  await assert.rejects(rpc.call('arbitrary_rpc', {})); assert.equal(calls, 0);
});

test('15 second RPC deadline covers ignored abort and stalled body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const rpc = new SupabaseRPC(config().supabaseMetrics, { fetchImpl: async (url, options) => {
    signal = options.signal; return new Promise(() => {});
  } });
  const pending = rpc.call('pintheory_data_admin_overview', {});
  t.mock.timers.tick(14999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await assert.rejects(pending); assert.equal(signal.aborted, true);
  let cancelled = false;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const stalled = new SupabaseRPC(config().supabaseMetrics, { fetchImpl: async () => new Response(new ReadableStream({
    pull() { entered(); }, cancel() { cancelled = true; }
  })) });
  const reading = stalled.call('pintheory_data_admin_overview', {});
  await started; t.mock.timers.tick(15000); await assert.rejects(reading); assert.equal(cancelled, true);
});

test('real localhost listener uses actual ephemeral port and rejects malicious Host', async t => {
  const f = await fixture(t, loadConfig({ PORT: '0' }));
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const port = f.app.server.address().port;
  const get = host => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/healthz', headers: { host } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end();
  });
  assert.equal(await get(`127.0.0.1:${port}`), 200);
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get(`evil.example:${port}`), 403);
  assert.equal(await get('127.0.0.1:0'), 403);
});

test('IPv6 configured Host accepts only bracketed literal or localhost with configured port', async t => {
  const f = await fixture(t, loadConfig({ HOST: '::1' }));
  assert.equal((await f.inject('/healthz', { remoteAddress: '::1', headers: { host: '[::1]:8080', origin: 'http://[::1]:8080' } })).statusCode, 200);
  assert.equal((await f.inject('/healthz', { headers: { host: 'localhost:8080' } })).statusCode, 200);
  assert.equal((await f.inject('/healthz')).statusCode, 403);
});

test('startup rejection is fixed and does not print supplied secrets or remote URLs', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: { HOST: '0.0.0.0', SUPABASE_URL: ROOT, SUPABASE_SERVICE_ROLE_KEY: KEY }, encoding: 'utf8'
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /HOST must be/);
  assert.ok(!result.stderr.includes(KEY)); assert.ok(!result.stderr.includes(ROOT));
});

test('runtime has no SQLite/provider imports or old token requirement', async () => {
  for (const name of ['app.js', 'config.js', 'admin.js', 'index.js']) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:sqlite|from ['"].*(?:cache|providers|geometry|admin-store)\.js|config\.providers|config\.token/);
  }
});