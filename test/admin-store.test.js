import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../src/cache.js';
import { AdminStore } from '../src/admin-store.js';
import { distance } from '../src/geometry.js';

const EPOCH = Date.parse('2026-10-23T12:00:00.000Z');
const DAY = 86400000;
const profile = length => ({ length });
const elevation = () => ({ status: 'OK', results: [
  { lat: 57, lon: 12, elevation: 100, data_source: 'fixture', resolution: 30 },
  { lat: 57.001, lon: 12.001, elevation: 101, data_source: 'fixture', resolution: 30 }
] });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fairwayvector-admin-'));
  let now = EPOCH;
  let cache = new Cache(directory, { now: () => now });
  t.after(() => { cache.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get cache() { return cache; },
    time(value) { now = value; },
    reopen() { cache.close(); cache = new Cache(directory, { now: () => now }); return new AdminStore(cache); },
    put(key, provider, body) { return cache.put(key, provider, { body }); }
  };
}

test('empty snapshot has the exact contract, zero-filled days and no raw provider data', t => {
  const f = fixture(t);
  const store = new AdminStore(f.cache);
  const snapshot = store.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['generatedAt', 'trackingStartedAt', 'period', 'traffic',
    'providers', 'daily', 'inventory', 'courses', 'unassigned', 'courseOptions'].sort());
  assert.equal(snapshot.generatedAt, new Date(EPOCH).toISOString());
  assert.equal(snapshot.trackingStartedAt, snapshot.generatedAt);
  assert.deepEqual(snapshot.period, { days: 7, label: 'Last 7 days' });
  assert.deepEqual(snapshot.traffic, { requests: 0, completed: 0, cacheHits: 0, fetched: 0,
    coalesced: 0, errors: 0, upstreamCalls: 0, cacheHitRate: null });
  assert.deepEqual(snapshot.providers, [
    { id: 'golf', name: 'GolfAPI', upstreamCalls: 0, todayCalls: 0 },
    { id: 'gpxz', name: 'GPXZ', upstreamCalls: 0, todayCalls: 0 }
  ]);
  assert.deepEqual(snapshot.inventory, { courseCount: 0, elevationProfiles: 0, elevationSamples: 0,
    elevationBytes: 0, elevationLengthMeters: 0, lengthEstimated: false, unassignedProfiles: 0 });
  assert.deepEqual(snapshot.courses, { items: [], total: 0, page: 1, pageSize: 25 });
  assert.deepEqual(snapshot.unassigned, { items: [], total: 0 });
  assert.deepEqual(snapshot.courseOptions, []);
  assert.equal(snapshot.daily.length, 7);
  assert.equal(snapshot.daily[0].day, '2026-10-17');
  assert.deepEqual(snapshot.daily.at(-1), { day: '2026-10-23', requests: 0,
    cacheHits: 0, coalesced: 0, upstreamCalls: 0, errors: 0 });
});

test('durable request counters use completion day; upstream counts come only from historical usage', t => {
  const f = fixture(t);
  f.time(EPOCH - 100 * DAY);
  f.cache.reserve('golf', 100);
  f.cache.reserve('golf', 100);
  f.time(Date.parse('2026-10-22T23:59:59.000Z'));
  f.cache.reserve('gpxz', 100);
  const store = new AdminStore(f.cache);
  const started = store.trackingStartedAt;
  store.received('golf');
  f.time(EPOCH);
  store.completed('golf', 'HIT');
  for (const outcome of ['MISS', 'COALESCED', 'ERROR', undefined]) {
    store.received('gpxz');
    store.completed('gpxz', outcome);
  }
  f.cache.reserve('golf', 100);
  const today = store.snapshot({ days: 1 });
  assert.deepEqual(today.traffic, { requests: 4, completed: 5, cacheHits: 1, fetched: 1,
    coalesced: 1, errors: 2, upstreamCalls: 1, cacheHitRate: 0.2 });
  assert.equal(today.providers[0].todayCalls, 1);
  assert.equal(today.providers[1].upstreamCalls, 0);
  const week = store.snapshot();
  assert.equal(week.traffic.requests, 5);
  assert.equal(week.traffic.upstreamCalls, 2);
  assert.equal(week.daily.at(-2).requests, 1);
  assert.equal(week.daily.at(-2).cacheHits, 0);
  assert.equal(week.daily.at(-1).cacheHits, 1);
  f.time(EPOCH + DAY);
  const reopened = f.reopen();
  assert.equal(reopened.trackingStartedAt, started);
  const all = reopened.snapshot({ days: 0 });
  assert.equal(all.traffic.requests, 5);
  assert.equal(all.traffic.upstreamCalls, 4);
  assert.equal(all.providers[0].upstreamCalls, 3);
  assert.equal(all.providers[1].upstreamCalls, 1);
  assert.equal(all.daily.length, 30);
  assert.equal(all.daily.reduce((sum, row) => sum + row.upstreamCalls, 0), 2);
  assert.equal(all.providers[0].todayCalls, 0);
  assert.equal(reopened.snapshot({ days: 400 }).daily.length, 366);
  assert.equal(reopened.snapshot({ days: 400 }).traffic.upstreamCalls, 4);
});

test('legacy backfill estimates chords without links, preserves bytes, and can become exact', t => {
  const f = fixture(t);
  const body = elevation();
  body.note = 'Unicode: å⛳';
  f.put('gpxz:legacy', 'gpxz', body);
  const store = new AdminStore(f.cache);
  const expected = distance(body.results[0], body.results[1]);
  let snapshot = store.snapshot();
  assert.equal(snapshot.inventory.elevationProfiles, 1);
  assert.equal(snapshot.inventory.elevationSamples, 2);
  assert.equal(snapshot.inventory.elevationBytes, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(snapshot.inventory.elevationLengthMeters, expected);
  assert.equal(snapshot.inventory.lengthEstimated, true);
  assert.equal(snapshot.inventory.courseCount, 0);
  assert.deepEqual(snapshot.unassigned.items, [{ key: 'gpxz:legacy', samples: 2,
    bytes: Buffer.byteLength(JSON.stringify(body)), lengthMeters: expected, lengthEstimated: true,
    fetchedAt: new Date(EPOCH).toISOString(), start: { lat: 57, lon: 12 }, end: { lat: 57.001, lon: 12.001 } }]);
  store.recordElevation('gpxz:legacy', profile(expected + 50));
  store.recordElevation('missing', profile(10), 'phantom');
  snapshot = f.reopen().snapshot();
  assert.equal(snapshot.inventory.elevationLengthMeters, expected + 50);
  assert.equal(snapshot.inventory.lengthEstimated, false);
  assert.equal(snapshot.inventory.courseCount, 0);
  assert.equal(f.cache.db.prepare('SELECT COUNT(*) AS n FROM elevation_metadata').get().n, 1);
  assert.ok(!JSON.stringify(snapshot).includes('Unicode'));
});

test('multiple course links never duplicate global profile totals; assignment is local and restricted', t => {
  const f = fixture(t);
  const store = new AdminStore(f.cache);
  f.put('gpxz:one', 'gpxz', elevation());
  f.put('gpxz:two', 'gpxz', elevation());
  f.put('golf:v1:detail:A', 'golf', { courseID: 'A', courseName: 'Å Links', clubName: 'Club A',
    country: 'SE', numHoles: '18', secretFixture: 'do-not-return' });
  f.put('golf:v1:coordinates:B', 'golf', { courseID: 'B', coordinates: [{ latitude: 57, longitude: 12 }] });
  f.put('golf:v1:courses:search', 'golf', { courses: [
    { courseID: 'B', courseName: 'Bee Course', clubName: 'Bee Club', country: 'NO' },
    { courseID: 'search-only', courseName: 'Not cached' }
  ] });
  f.put('golf:v1:detail:wrong-provider', 'gpxz', elevation());
  store.recordElevation('gpxz:one', profile(123.45), 'tagged');
  store.recordElevation('gpxz:one', profile(123.45), 'tagged');
  store.recordElevation('gpxz:two', profile(50));
  store.recordElevation('golf:v1:detail:wrong-provider', profile(1));
  assert.equal(store.assignElevation('gpxz:one', 'A'), true);
  assert.equal(store.assignElevation('gpxz:one', 'A'), true);
  assert.equal(store.assignElevation('gpxz:one', 'B'), true);
  assert.equal(store.assignElevation('gpxz:two', 'tagged'), true);
  assert.equal(store.assignElevation('gpxz:two', 'unknown'), false);
  assert.equal(store.assignElevation('gpxz:two', 'search-only'), false);
  assert.equal(store.assignElevation('gpxz:two', 'wrong-provider'), false);
  assert.equal(store.assignElevation('missing', 'A'), false);
  assert.equal(store.assignElevation('golf:v1:detail:A', 'B'), false);
  assert.equal(store.assignElevation('gpxz:one', null), false);
  const snapshot = store.snapshot();
  assert.equal(snapshot.inventory.courseCount, 3);
  assert.equal(snapshot.inventory.elevationProfiles, 3);
  assert.equal(snapshot.inventory.elevationSamples, 6);
  assert.equal(snapshot.inventory.elevationLengthMeters, 174.45);
  assert.equal(snapshot.inventory.unassignedProfiles, 1);
  const a = snapshot.courses.items.find(item => item.id === 'A');
  assert.deepEqual(a, { id: 'A', name: 'Å Links', clubName: 'Club A', country: 'SE', hasDetail: true,
    hasCoordinates: false, coordinateCount: 0, numHoles: 18,
    detailFetchedAt: new Date(EPOCH).toISOString(), coordinatesFetchedAt: null,
    elevation: { profiles: 1, samples: 2, bytes: Buffer.byteLength(JSON.stringify(elevation())),
      lengthMeters: 123.45, lengthEstimated: false, lastFetchedAt: new Date(EPOCH).toISOString() } });
  const b = snapshot.courses.items.find(item => item.id === 'B');
  assert.equal(b.name, 'Bee Course');
  assert.equal(b.clubName, 'Bee Club');
  assert.equal(b.country, 'NO');
  assert.equal(b.coordinateCount, 1);
  assert.equal(b.hasCoordinates, true);
  assert.equal(b.hasDetail, false);
  assert.equal(b.coordinatesFetchedAt, new Date(EPOCH).toISOString());
  const tagged = snapshot.courses.items.find(item => item.id === 'tagged');
  assert.equal(tagged.name, 'Course tagged');
  assert.equal(tagged.elevation.profiles, 2);
  assert.equal(tagged.elevation.lengthMeters, 173.45);
  assert.equal(tagged.hasDetail, false);
  assert.equal(tagged.hasCoordinates, false);
  assert.equal(snapshot.courses.items.some(item => item.id === 'search-only'), false);
  assert.ok(!JSON.stringify(snapshot).includes('do-not-return'));
  assert.equal(f.cache.db.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
  assert.equal(f.reopen().snapshot().courses.items.find(item => item.id === 'tagged').elevation.profiles, 2);
});

test('bounded pagination, literal search, newest unassigned and 1,000 course options', t => {
  const f = fixture(t);
  const store = new AdminStore(f.cache);
  f.cache.db.exec('BEGIN');
  for (let i = 0; i < 1005; i++) {
    const id = String(i).padStart(4, '0');
    f.put(`golf:v1:detail:${id}`, 'golf', { courseID: id, courseName: `Course ${id}`,
      clubName: i === 30 ? '100%_ Club' : 'Club', country: 'SE' });
  }
  for (let i = 0; i < 55; i++) {
    f.time(EPOCH + i);
    f.put(`gpxz:${String(i).padStart(2, '0')}`, 'gpxz', elevation());
    store.recordElevation(`gpxz:${String(i).padStart(2, '0')}`, profile(i + 1));
  }
  f.cache.db.exec('COMMIT');
  const snapshot = store.snapshot({ page: 2 });
  assert.equal(snapshot.courses.total, 1005);
  assert.equal(snapshot.courses.items.length, 25);
  assert.equal(snapshot.courses.items[0].id, '0025');
  assert.equal(snapshot.inventory.courseCount, 1005);
  assert.equal(snapshot.courseOptions.length, 1000);
  assert.equal(snapshot.unassigned.total, 55);
  assert.equal(snapshot.unassigned.items.length, 50);
  assert.equal(snapshot.unassigned.items[0].key, 'gpxz:54');
  assert.equal(snapshot.unassigned.items.at(-1).key, 'gpxz:05');
  assert.equal(snapshot.inventory.elevationProfiles, 55);
  assert.equal(store.snapshot({ search: '100%_' }).courses.items[0].id, '0030');
  assert.equal(store.snapshot({ search: ' se ' }).courses.total, 1005);
  assert.equal(store.snapshot({ search: 'nothing' }).courses.total, 0);
  assert.equal(store.snapshot({ search: 'nothing' }).inventory.courseCount, 1005);
  assert.equal(store.snapshot({ page: 100 }).courses.items.length, 0);
});

test('club search metadata enriches coordinate-only IDs, exact keys and null endpoints', t => {
  const f = fixture(t);
  f.put('golf:v1:coordinates:X', 'golf', { courseID: 'X', coordinates: [] });
  f.put('golf:v1:clubs:search', 'golf', { clubs: [{ clubID: 'club', clubName: 'Nested Club',
    country: 'DK', courses: [{ courseID: 'X', courseName: 'Nested Course' }] }] });
  f.put('ignored:golf:v1:detail:fake', 'golf', { courseID: 'fake', courseName: 'Not inventory' });
  f.put('gpxz:empty', 'gpxz', { status: 'OK', results: [] });
  const store = new AdminStore(f.cache);
  const snapshot = store.snapshot();
  assert.equal(snapshot.inventory.courseCount, 1);
  assert.equal(snapshot.courses.items[0].name, 'Nested Course');
  assert.equal(snapshot.courses.items[0].clubName, 'Nested Club');
  assert.equal(snapshot.courses.items[0].country, 'DK');
  assert.equal(snapshot.courses.items[0].numHoles, null);
  assert.equal(snapshot.unassigned.items[0].start, null);
  assert.equal(snapshot.unassigned.items[0].end, null);
  assert.equal(snapshot.inventory.lengthEstimated, true);
});