import { APIError } from './errors.js';

const fail = () => { throw new APIError(503, 'admin_unavailable', 'Supabase administration is unavailable. Check local setup and deployed migrations.'); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value; };
const count = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
const positive = value => { count(value); if (!value) fail(); return value; };
const number = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(); return value; };
const bool = value => { if (typeof value !== 'boolean') fail(); return value; };
const text = (value, max = 500) => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) fail(); return value; };
const id = value => { text(value, 100); if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(); return value; };
const key = value => { if (typeof value !== 'string' || !/^gpxz:sample:v1:[a-f0-9]{64}$/.test(value)) fail(); return value; };
const date = value => { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)
  || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) fail(); return value; };
const nullableDate = value => value === null ? null : date(value);
const list = (value, max, normalize) => { if (!Array.isArray(value) || value.length > max) fail(); return value.map(normalize); };
const fields = (raw, names, convert = count) => Object.fromEntries(names.map(name => [name, convert(object(raw)[name])]));
const point = value => {
  if (value === null) return null;
  object(value);
  if (!Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180) fail();
  return { lat: value.lat, lon: value.lon };
};
const elevation = raw => ({ ...fields(raw, ['profiles', 'samples', 'bytes']), lengthMeters: number(raw.lengthMeters),
  lengthEstimated: bool(raw.lengthEstimated), lastFetchedAt: nullableDate(raw.lastFetchedAt) });

/** Reconstruct every nested field; raw provider responses and unknown fields never escape. */
export function normalizeOverview(raw) {
  object(raw); object(raw.period); object(raw.traffic); object(raw.inventory); object(raw.courses); object(raw.unassigned);
  const days = raw.period.days;
  if (![0, 1, 7, 30].includes(days)) fail();
  const rate = raw.traffic.cacheHitRate;
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1)) fail();
  const pageSize = positive(raw.courses.pageSize);
  if (pageSize > 100) fail();
  const providers = list(raw.providers, 2, provider => {
    object(provider);
    if (!['golf', 'gpxz'].includes(provider.id)) fail();
    return { id: provider.id, name: provider.id === 'golf' ? 'GolfAPI' : 'GPXZ',
      ...fields(provider, ['upstreamCalls', 'todayCalls', 'dailyLimit', 'cooldownSeconds']), enabled: bool(provider.enabled) };
  });
  if (new Set(providers.map(provider => provider.id)).size !== 2) fail();
  return {
    generatedAt: date(raw.generatedAt), trackingStartedAt: date(raw.trackingStartedAt),
    period: { days, label: days === 0 ? 'All time' : days === 1 ? 'Today' : `Last ${days} days` },
    traffic: { ...fields(raw.traffic, ['requests', 'completed', 'cacheHits', 'fetched', 'coalesced', 'errors', 'upstreamCalls']), cacheHitRate: rate },
    providers,
    daily: list(raw.daily, 366, day => {
      object(day);
      if (typeof day.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(day.day)
          || !Number.isFinite(Date.parse(day.day)) || new Date(day.day).toISOString().slice(0, 10) !== day.day) fail();
      return { day: day.day, ...fields(day, ['requests', 'cacheHits', 'coalesced', 'upstreamCalls', 'errors']) };
    }),
    inventory: { ...fields(raw.inventory, ['courseCount', 'elevationProfiles', 'elevationSamples', 'elevationBytes', 'unassignedProfiles']),
      elevationLengthMeters: number(raw.inventory.elevationLengthMeters), lengthEstimated: bool(raw.inventory.lengthEstimated) },
    courses: { page: positive(raw.courses.page), pageSize, total: count(raw.courses.total),
      items: list(raw.courses.items, pageSize, course => {
        object(course);
        return { id: id(course.id), name: text(course.name), clubName: text(course.clubName), country: text(course.country),
          hasDetail: bool(course.hasDetail), hasCoordinates: bool(course.hasCoordinates), coordinateCount: count(course.coordinateCount),
          numHoles: course.numHoles === null ? null : count(course.numHoles), detailFetchedAt: nullableDate(course.detailFetchedAt),
          coordinatesFetchedAt: nullableDate(course.coordinatesFetchedAt), elevation: elevation(object(course.elevation)) };
      }) },
    unassigned: { total: count(raw.unassigned.total), items: list(raw.unassigned.items, 50, profile => {
      object(profile);
      return { key: key(profile.key), ...fields(profile, ['samples', 'bytes']), lengthMeters: number(profile.lengthMeters),
        lengthEstimated: bool(profile.lengthEstimated), fetchedAt: date(profile.fetchedAt), start: point(profile.start), end: point(profile.end) };
    }) },
    courseOptions: list(raw.courseOptions, 1000, course => ({ id: id(object(course).id), name: text(course.name) }))
  };
}