import { APIError } from './errors.js';
import { distance, pointAt, validPoint } from './geometry.js';

const invalid = () => {
  const error = new APIError(502, 'invalid_provider_response', 'Provider returned invalid data.');
  error.providerWide = false;
  throw error;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' || typeof value === 'number') && String(value).length > 0;
const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value));

export function validateGolf(body, kind, id) {
  if (!object(body)) invalid();
  if (kind === 'clubs' || kind === 'courses') {
    if (!Array.isArray(body[kind]) || !body[kind].every(object)) invalid();
    for (const item of body[kind]) {
      if (!text(item[kind === 'clubs' ? 'clubID' : 'courseID'])
          || !text(item[kind === 'clubs' ? 'clubName' : 'courseName'])) invalid();
    }
  } else {
    if (!text(body.courseID) || String(body.courseID) !== id) invalid();
    if (kind === 'detail' && !text(body.courseName)) invalid();
    if (kind === 'coordinates') {
      if (!Array.isArray(body.coordinates) || body.coordinates.length === 0) invalid();
      for (const point of body.coordinates) {
        if (!object(point) || !numeric(point.poi) || !numeric(point.hole)
            || !numeric(point.latitude) || !numeric(point.longitude)
            || !validPoint({ lat: Number(point.latitude), lon: Number(point.longitude) })) invalid();
      }
    }
  }
  // Account-wide remaining credit must not leak to clients or become stale cache metadata.
  const { apiRequestsLeft, ...data } = body;
  return data;
}

export function validateElevation(body, profile) {
  if (!object(body) || typeof body.status !== 'string' || body.status.toUpperCase() !== 'OK'
      || !Array.isArray(body.results) || body.results.length !== profile.samples) invalid();
  const tolerance = Math.min(Math.max(0.5, profile.length * 0.00001), profile.length / (profile.samples - 1) * 0.4);
  body.results.forEach((result, i) => {
    if (!object(result) || !validPoint(result) || !Number.isFinite(result.elevation)
        || !Number.isFinite(result.resolution) || result.resolution <= 0
        || typeof result.data_source !== 'string' || !result.data_source.trim()
        || distance(result, pointAt(profile, i * profile.length / (profile.samples - 1))) > tolerance) invalid();
    if ((i === 0 || i === profile.samples - 1)
        && distance(result, i === 0 ? profile.path[0] : profile.path.at(-1)) > 0.02) invalid();
  });
  return body;
}

export class Providers {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(url, options) {
    try {
      const response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry)
          : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        await response.body?.cancel();
        const error = new APIError(502, 'provider_unavailable', 'Provider could not complete the request.',
          Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : undefined);
        error.providerWide = [401, 403, 429].includes(response.status) || response.status >= 500;
        throw error;
      }
      // Bound streaming reads, including chunked responses without Content-Length.
      if (Number(response.headers.get('content-length')) > 4000000) {
        await response.body?.cancel();
        invalid();
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 4000000) invalid();
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const version = response.headers.get('x-dataset-version');
      return { body, datasetVersion: version && /^[\x20-\x7e]{1,200}$/.test(version) ? version : null };
    } catch (error) {
      if (error instanceof APIError) throw error;
      // Never echo exceptions, URLs, credentials, headers or provider error bodies.
      throw new APIError(502, 'provider_unavailable', 'Provider could not complete the request.');
    }
  }

  async golf(path, query, kind, id) {
    const url = new URL(`https://golfapi.io/api/v2.3${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const result = await this.request(url, { headers: {
      Authorization: `Bearer ${this.config.providers.golf.key}`, Accept: 'application/json'
    } });
    return { ...result, body: validateGolf(result.body, kind, id) };
  }

  async elevation(profile) {
    const form = new URLSearchParams({
      latlons: profile.path.map(p => `${p.lat},${p.lon}`).join('|'), samples: String(profile.samples),
      interpolation: 'bilinear', bathymetry: 'false'
    });
    const result = await this.request('https://api.gpxz.io/v1/elevation/sample', {
      method: 'POST', headers: { 'x-api-key': this.config.providers.gpxz.key,
        'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
    });
    return { ...result, body: validateElevation(result.body, profile) };
  }
}