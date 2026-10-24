import { distance, validPoint } from './geometry.js';

const DAY = 86400000;
const DETAIL = 'golf:v1:detail:';
const COORDINATES = 'golf:v1:coordinates:';
const iso = value => value == null ? null : new Date(value).toISOString();
const dayOf = value => new Date(value).toISOString().slice(0, 10);
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const emptyElevation = () => ({ profiles: 0, samples: 0, bytes: 0, lengthMeters: 0,
  lengthEstimated: false, lastFetchedAt: null });

// Count each cached response once, irrespective of how many courses link to it.
// Length is path length, not surveyed area or deduplicated spatial coverage.
const elevationSQL = `WITH elevations AS (
  SELECT r.key, r.fetched_at,
    COALESCE(json_array_length(r.body, '$.results'), 0) AS samples,
    length(CAST(r.body AS BLOB)) AS bytes,
    COALESCE(m.length_meters, 0) AS length_meters,
    COALESCE(m.length_estimated, 1) AS length_estimated
  FROM responses r LEFT JOIN elevation_metadata m ON m.response_key = r.key
  WHERE r.provider = 'gpxz'
)`;

/** Local cache administration only: no transport, billing, credentials or request logs.
 * Request counters begin at trackingStartedAt; upstream counts include older usage.
 * Received and completed events use their own UTC day (including across midnight).
 * Hit rate is cache hits / completed requests, or null before any completion.
 * All-time summaries include all usage; their daily trend shows the last 30 days.
 * Other daily trends are capped at 366 days without truncating summary totals.
 * Course options are a deterministic, unfiltered list capped at 1,000 entries.
 */
export class AdminStore {
  constructor(cache) {
    this.cache = cache;
    this.db = cache.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_requests (
        day TEXT NOT NULL, provider TEXT NOT NULL,
        received INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        cache_hits INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL DEFAULT 0,
        coalesced INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day, provider)
      );
      CREATE TABLE IF NOT EXISTS elevation_metadata (
        response_key TEXT PRIMARY KEY, length_meters REAL NOT NULL,
        length_estimated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS elevation_courses (
        response_key TEXT NOT NULL, course_id TEXT NOT NULL,
        PRIMARY KEY(response_key, course_id)
      );
      CREATE INDEX IF NOT EXISTS elevation_courses_course_id ON elevation_courses(course_id);
    `);
    this.receive = this.db.prepare(`INSERT INTO admin_requests(day, provider, received)
      VALUES (?, ?, 1) ON CONFLICT(day, provider) DO UPDATE SET received = received + 1`);
    this.finish = this.db.prepare(`INSERT INTO admin_requests
      (day, provider, completed, cache_hits, fetched, coalesced, errors)
      VALUES (?, ?, 1, ?, ?, ?, ?) ON CONFLICT(day, provider) DO UPDATE SET
      completed = completed + 1, cache_hits = cache_hits + excluded.cache_hits,
      fetched = fetched + excluded.fetched, coalesced = coalesced + excluded.coalesced,
      errors = errors + excluded.errors`);
    this.saveElevation = this.db.prepare(`INSERT INTO elevation_metadata
      (response_key, length_meters, length_estimated)
      SELECT key, ?, 0 FROM responses WHERE key = ? AND provider = 'gpxz'
      ON CONFLICT(response_key) DO UPDATE SET
        length_meters = excluded.length_meters, length_estimated = 0`);
    this.linkElevation = this.db.prepare(`INSERT OR IGNORE INTO elevation_courses
      (response_key, course_id) SELECT key, ? FROM responses WHERE key = ? AND provider = 'gpxz'`);
    this.assign = this.db.prepare(`INSERT OR IGNORE INTO elevation_courses(response_key, course_id)
      SELECT key, ? FROM responses WHERE key = ? AND provider = 'gpxz' AND (
        EXISTS (SELECT 1 FROM responses WHERE provider = 'golf' AND key IN (?, ?))
        OR EXISTS (SELECT 1 FROM elevation_courses WHERE course_id = ?))`);
    this.hasAssignment = this.db.prepare(`SELECT 1 FROM elevation_courses c
      JOIN responses r ON r.key = c.response_key AND r.provider = 'gpxz'
      WHERE c.response_key = ? AND c.course_id = ?`);

    // Migration is additive and restart-safe. Sample-to-sample chords can understate
    // an original curved path: never label them exact or infer course ownership.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO admin_meta(key, value) VALUES (?, ?)')
        .run('trackingStartedAt', iso(cache.now()));
      const insert = this.db.prepare(`INSERT OR IGNORE INTO elevation_metadata
        (response_key, length_meters, length_estimated) VALUES (?, ?, 1)`);
      const legacy = this.db.prepare(`SELECT r.key, r.body FROM responses r
        LEFT JOIN elevation_metadata m ON m.response_key = r.key
        WHERE r.provider = 'gpxz' AND m.response_key IS NULL`);
      for (const row of legacy.iterate()) {
        const points = JSON.parse(row.body).results ?? [];
        let length = 0;
        for (let i = 1; i < points.length; i++) {
          if (validPoint(points[i - 1]) && validPoint(points[i])) {
            length += distance(points[i - 1], points[i]);
          }
        }
        insert.run(row.key, length);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.trackingStartedAt = this.db.prepare("SELECT value FROM admin_meta WHERE key = 'trackingStartedAt'").get().value;
  }

  received(provider) {
    this.receive.run(dayOf(this.cache.now()), provider);
  }

  completed(provider, outcome) {
    // Completion-day buckets deliberately do not move the original received event.
    this.finish.run(dayOf(this.cache.now()), provider, Number(outcome === 'HIT'),
      Number(outcome === 'MISS'), Number(outcome === 'COALESCED'),
      Number(!['HIT', 'MISS', 'COALESCED'].includes(outcome)));
  }

  recordElevation(key, profile, courseID) {
    // Callers validate the profile and optional tag. A missing cache entry can
    // never create phantom metadata/links; repeated HIT/COALESCED calls are safe.
    this.saveElevation.run(profile.length, key);
    if (courseID != null && String(courseID) !== '') this.linkElevation.run(String(courseID), key);
  }

  assignElevation(key, courseID) {
    if (courseID == null || String(courseID) === '') return false;
    const id = String(courseID);
    // Search-only IDs are not known cached courses. Previously tagged IDs remain
    // assignable when their detail has not arrived yet. This never fetches data.
    this.assign.run(id, key, DETAIL + id, COORDINATES + id, id);
    return Boolean(this.hasAssignment.get(key, id));
  }

  snapshot({ days = 7, search = '', page = 1 } = {}) {
    days = Number.isSafeInteger(days) && days >= 0 ? days : 7;
    page = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const now = this.cache.now();
    const today = dayOf(now);
    const midnight = Date.parse(`${today}T00:00:00.000Z`);
    const since = days === 0 ? '' : dayOf(midnight - (days - 1) * DAY);
    const totals = this.db.prepare(`SELECT COALESCE(SUM(received), 0) AS requests,
      COALESCE(SUM(completed), 0) AS completed, COALESCE(SUM(cache_hits), 0) AS cacheHits,
      COALESCE(SUM(fetched), 0) AS fetched, COALESCE(SUM(coalesced), 0) AS coalesced,
      COALESCE(SUM(errors), 0) AS errors FROM admin_requests WHERE day BETWEEN ? AND ?`).get(since, today);
    const usage = this.db.prepare(`SELECT provider, SUM(attempts) AS calls,
      SUM(CASE WHEN day = ? THEN attempts ELSE 0 END) AS todayCalls
      FROM usage WHERE day BETWEEN ? AND ? GROUP BY provider`).all(today, since, today);
    const usageByProvider = new Map(usage.map(row => [row.provider, row]));
    const providers = [['golf', 'GolfAPI'], ['gpxz', 'GPXZ']].map(([id, name]) => ({ id, name,
      upstreamCalls: usageByProvider.get(id)?.calls ?? 0,
      todayCalls: usageByProvider.get(id)?.todayCalls ?? 0 }));
    const traffic = { ...totals, upstreamCalls: usage.reduce((sum, row) => sum + row.calls, 0),
      cacheHitRate: totals.completed ? totals.cacheHits / totals.completed : null };

    const trendDays = days === 0 ? 30 : Math.min(days, 366);
    const trendSince = dayOf(midnight - (trendDays - 1) * DAY);
    const requestDays = new Map(this.db.prepare(`SELECT day, SUM(received) AS requests,
      SUM(cache_hits) AS cacheHits, SUM(coalesced) AS coalesced, SUM(errors) AS errors
      FROM admin_requests WHERE day BETWEEN ? AND ? GROUP BY day`).all(trendSince, today)
      .map(row => [row.day, row]));
    const usageDays = new Map(this.db.prepare(`SELECT day, SUM(attempts) AS calls FROM usage
      WHERE day BETWEEN ? AND ? GROUP BY day`).all(trendSince, today).map(row => [row.day, row.calls]));
    const daily = Array.from({ length: trendDays }, (_, i) => {
      const day = dayOf(midnight - (trendDays - i - 1) * DAY);
      const row = requestDays.get(day);
      return { day, requests: row?.requests ?? 0, cacheHits: row?.cacheHits ?? 0,
        coalesced: row?.coalesced ?? 0, upstreamCalls: usageDays.get(day) ?? 0, errors: row?.errors ?? 0 };
    });

    const inventory = this.db.prepare(`${elevationSQL} SELECT COUNT(*) AS elevationProfiles,
      COALESCE(SUM(samples), 0) AS elevationSamples, COALESCE(SUM(bytes), 0) AS elevationBytes,
      COALESCE(SUM(length_meters), 0) AS elevationLengthMeters,
      COALESCE(MAX(length_estimated), 0) AS lengthEstimated,
      COALESCE(SUM(NOT EXISTS (SELECT 1 FROM elevation_courses c WHERE c.response_key = e.key)), 0)
        AS unassignedProfiles FROM elevations e`).get();
    inventory.lengthEstimated = Boolean(inventory.lengthEstimated);

    const coursesByID = new Map();
    const course = id => {
      if (!coursesByID.has(id)) coursesByID.set(id, { id, name: '', clubName: '', country: '',
        hasDetail: false, hasCoordinates: false, coordinateCount: 0, numHoles: null,
        detailFetchedAt: null, coordinatesFetchedAt: null, elevation: emptyElevation() });
      return coursesByID.get(id);
    };
    // Extract only inventory fields in SQLite; never load provider bodies into the
    // snapshot or parse GPXZ JSON once per course/link. Exact prefixes exclude search.
    const cachedCourses = this.db.prepare(`SELECT key, fetched_at,
      json_extract(body, '$.courseName') AS name, json_extract(body, '$.clubName') AS clubName,
      json_extract(body, '$.country') AS country, json_extract(body, '$.numHoles') AS numHoles,
      COALESCE(json_array_length(body, '$.coordinates'), 0) AS coordinateCount
      FROM responses WHERE provider = 'golf'
      AND (key GLOB 'golf:v1:detail:*' OR key GLOB 'golf:v1:coordinates:*')
      ORDER BY CASE WHEN key GLOB 'golf:v1:detail:*' THEN 1 ELSE 0 END`).all();
    for (const row of cachedCourses) {
      const detail = row.key.startsWith(DETAIL);
      const item = course(row.key.slice(detail ? DETAIL.length : COORDINATES.length));
      for (const field of ['name', 'clubName', 'country']) if (text(row[field])) item[field] = text(row[field]);
      const holes = row.numHoles == null || row.numHoles === '' ? NaN : Number(row.numHoles);
      if (Number.isInteger(holes) && holes >= 0) item.numHoles = holes;
      if (detail) {
        item.hasDetail = true;
        item.detailFetchedAt = iso(row.fetched_at);
      } else {
        item.hasCoordinates = true;
        item.coordinateCount = row.coordinateCount;
        item.coordinatesFetchedAt = iso(row.fetched_at);
      }
    }
    const linked = this.db.prepare(`${elevationSQL} SELECT c.course_id AS id, COUNT(*) AS profiles,
      SUM(e.samples) AS samples, SUM(e.bytes) AS bytes, SUM(e.length_meters) AS lengthMeters,
      MAX(e.length_estimated) AS lengthEstimated, MAX(e.fetched_at) AS lastFetchedAt
      FROM elevation_courses c JOIN elevations e ON e.key = c.response_key GROUP BY c.course_id`).all();
    for (const row of linked) {
      const { id, ...stats } = row;
      course(id).elevation = { ...stats, lengthEstimated: Boolean(stats.lengthEstimated),
        lastFetchedAt: iso(stats.lastFetchedAt) };
    }
    // Include tagged-only IDs even if a stale link's response is no longer present.
    for (const row of this.db.prepare('SELECT DISTINCT course_id FROM elevation_courses').all()) course(row.course_id);

    if ([...coursesByID.values()].some(item => !item.name || !item.clubName || !item.country)) {
      // Search results enrich existing inventory IDs, but never create inventory.
      // Support both course searches and courses nested inside club search results.
      const metadata = this.db.prepare(`WITH searches AS (
        SELECT body, fetched_at FROM responses WHERE provider = 'golf'
        AND (key GLOB 'golf:v1:courses:*' OR key GLOB 'golf:v1:clubs:*')
      ), candidates AS (
        SELECT c.value AS body, NULL AS clubName, NULL AS country, s.fetched_at
        FROM searches s, json_each(s.body, '$.courses') c
        UNION ALL
        SELECT c.value, json_extract(b.value, '$.clubName'), json_extract(b.value, '$.country'), s.fetched_at
        FROM searches s, json_each(s.body, '$.clubs') b, json_each(b.value, '$.courses') c
      ) SELECT json_extract(body, '$.courseID') AS id, json_extract(body, '$.courseName') AS name,
        COALESCE(json_extract(body, '$.clubName'), clubName) AS clubName,
        COALESCE(json_extract(body, '$.country'), country) AS country
        FROM candidates ORDER BY fetched_at DESC`).iterate();
      for (const row of metadata) {
        const item = coursesByID.get(text(row.id));
        if (item) for (const field of ['name', 'clubName', 'country']) {
          if (!item[field]) item[field] = text(row[field]);
        }
      }
    }
    const allCourses = [...coursesByID.values()];
    for (const item of allCourses) item.name ||= `Course ${item.id}`;
    allCourses.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const needle = String(search).trim().toLocaleLowerCase();
    const matching = needle ? allCourses.filter(item => [item.id, item.name, item.clubName, item.country]
      .some(value => value.toLocaleLowerCase().includes(needle))) : allCourses;

    const unassigned = this.db.prepare(`${elevationSQL} SELECT e.key, e.samples, e.bytes,
      e.length_meters AS lengthMeters, e.length_estimated AS lengthEstimated, e.fetched_at AS fetchedAt,
      json_extract(r.body, '$.results[0].lat') AS startLat,
      json_extract(r.body, '$.results[0].lon') AS startLon,
      json_extract(r.body, '$.results[#-1].lat') AS endLat,
      json_extract(r.body, '$.results[#-1].lon') AS endLon
      FROM elevations e JOIN responses r ON r.key = e.key
      WHERE NOT EXISTS (SELECT 1 FROM elevation_courses c WHERE c.response_key = e.key)
      ORDER BY e.fetched_at DESC, e.key LIMIT 50`).all().map(row => {
      const start = { lat: row.startLat, lon: row.startLon };
      const end = { lat: row.endLat, lon: row.endLon };
      return { key: row.key, samples: row.samples, bytes: row.bytes, lengthMeters: row.lengthMeters,
        lengthEstimated: Boolean(row.lengthEstimated), fetchedAt: iso(row.fetchedAt),
        start: validPoint(start) ? start : null, end: validPoint(end) ? end : null };
    });
    return {
      generatedAt: iso(now), trackingStartedAt: this.trackingStartedAt,
      period: { days, label: days === 0 ? 'All time' : days === 1 ? 'Today' : `Last ${days} days` },
      traffic, providers, daily,
      inventory: { courseCount: allCourses.length, ...inventory },
      courses: { items: matching.slice((page - 1) * 25, page * 25), total: matching.length, page, pageSize: 25 },
      unassigned: { items: unassigned, total: inventory.unassignedProfiles },
      courseOptions: allCourses.slice(0, 1000).map(({ id, name }) => ({ id, name }))
    };
  }
}