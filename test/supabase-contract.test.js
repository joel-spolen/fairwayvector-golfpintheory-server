import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { normalizeOverview } from '../src/admin-overview.js';

const config = () => loadConfig({ SUPABASE_URL: 'https://offline-contract.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_offline_contract' });
const key = `gpxz:sample:v1:${'a'.repeat(64)}`;

test('assignment accepts only the SQL boolean contract, not a legacy object envelope', async t => {
  for (const [result, status] of [[true, 200], [false, 404], [{ ok: true }, 404], [null, 404]]) {
    const app = await buildApp(config(), { fetchImpl: async () => new Response(JSON.stringify(result)) });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/admin/elevation/assign',
        headers: { host: '127.0.0.1:8080', 'x-local-admin': '1' }, payload: { key, courseID: 'A' } });
      assert.equal(response.statusCode, status, JSON.stringify(result));
      if (result === true) assert.deepEqual(response.json(), { ok: true });
    } finally { await app.close(); }
  }
});

// Explicit opt-in ONLY to the SQL agent's disposable Unix-socket cluster. Never
// consume DATABASE_URL/PGHOST or a hosted project. Every fixture rolls back.
const socket = process.env.PINTHEORY_CONTRACT_SQL_SOCKET;
test('actual local SQL overview/assign/claim contracts cross the Node HTTP bridge', { skip: !socket }, async () => {
  const path = realpathSync(socket);
  assert.match(path, /^\/(?:private\/)?tmp\/pintheory-cache-sql\.[A-Za-z0-9]+$/);
  const psql = process.env.PINTHEORY_CONTRACT_PSQL || '/opt/homebrew/opt/postgresql@17/bin/psql';
  const args = ['-X', '-qAt', '-h', path, '-p', '55439', '-U', 'postgres', '-d', 'full_cache_test', '-v', 'ON_ERROR_STOP=1'];
  const run = input => {
    const result = spawnSync(psql, args, { input, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PGCONNECT_TIMEOUT: '3', PSQL_PAGER: '' }, maxBuffer: 8000000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const [directory] = run("select to_json(current_setting('data_directory'));");
  assert.equal(realpathSync(directory), `${path}/db`, 'Refuse any other local database');
  const uid = randomUUID();
  const course = `Contract_${uid.replaceAll('-', '')}`;
  const profile = `gpxz:sample:v1:${createHash('sha256').update(uid).digest('hex')}`;
  const paidKey = `golf:v1:detail:${course}_paid`;
  const [before, assigned, missing, after, claimed, unknown, failed, retry] = run(`
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
set local request.jwt.claims = '{"role":"service_role"}';
insert into auth.users(id,is_anonymous) values ('${uid}',false);
insert into pintheory_data.responses(key,provider,body,fetched_at,metadata) values
 ('golf:v1:detail:${course}','golf','{"courseID":"${course}","courseName":"${course}","numHoles":"18"}',
  '2026-10-24T12:00:00.123456Z','{}'),
 ('${profile}','gpxz','{"status":"OK","results":[{"lat":57,"lon":12,"elevation":1},{"lat":57.001,"lon":12,"elevation":2}]}',
  clock_timestamp(),'{"profileLengthMeters":111.25}');
select public.pintheory_data_admin_overview(7,'${course}',1);
select to_json(public.pintheory_data_admin_assign('${profile}','${course}'));
select to_json(public.pintheory_data_admin_assign('${profile}','Missing_${course}'));
select public.pintheory_data_admin_overview(7,'${course}',1);
update pintheory_data.settings set enabled=true,daily_limit=1000000,cooldown_until=null;
select public.pintheory_data_claim('${uid}','${paidKey}','golf',false);
update pintheory_data.jobs set until=clock_timestamp()-interval '1 second' where key='${paidKey}';
select public.pintheory_data_claim('${uid}','${paidKey}','golf',false);
select to_json(public.pintheory_data_fail('${paidKey}',(select token from pintheory_data.jobs where key='${paidKey}'),false,300));
update pintheory_data.jobs set until=clock_timestamp()-interval '1 second' where key='${paidKey}';
select public.pintheory_data_claim('${uid}','${paidKey}','golf',false);
rollback;
`);
  assert.equal(assigned, true);
  assert.equal(missing, false);
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(unknown.status, 'UNKNOWN', 'TTL expiry must not authorize redispatch');
  assert.equal(failed, true);
  assert.equal(retry.status, 'CLAIMED', 'Explicit fail is retryable: never use it for an ambiguous timeout');
  assert.notEqual(retry.token, claimed.token);
  for (const raw of [before, after]) {
    const normalized = normalizeOverview(raw);
    assert.match(normalized.generatedAt, /\.\d{6}Z$/);
    assert.equal(normalized.courses.items[0].detailFetchedAt, '2026-10-24T12:00:00.123456Z');
    assert.equal(normalized.courses.items[0].id, course);
    assert.equal(normalized.courses.items[0].numHoles, 18);
  }
  assert.equal(before.courses.items[0].elevation.profiles, 0);
  assert.equal(after.courses.items[0].elevation.profiles, 1);
  assert.ok(before.unassigned.items.some(item => item.key === profile));
  assert.ok(!after.unassigned.items.some(item => item.key === profile));
  const replies = [before, assigned, after, missing];
  const methods = [];
  const app = await buildApp(config(), { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    methods.push(url.split('/').at(-1));
    return new Response(JSON.stringify(replies.shift()));
  } });
  try {
    const inject = (url, extra = {}) => app.inject({ url, headers: { host: '127.0.0.1:8080', 'x-local-admin': '1' }, ...extra });
    for (const raw of [before, after]) {
      const response = await inject(`/api/admin/overview?search=${course}`);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), normalizeOverview(raw));
      const assignment = await inject('/api/admin/elevation/assign', { method: 'POST', payload: { key: profile, courseID: course } });
      assert.equal(assignment.statusCode, raw === before ? 200 : 404);
    }
    assert.deepEqual(methods, ['pintheory_data_admin_overview', 'pintheory_data_admin_assign',
      'pintheory_data_admin_overview', 'pintheory_data_admin_assign']);
  } finally { await app.close(); }
});