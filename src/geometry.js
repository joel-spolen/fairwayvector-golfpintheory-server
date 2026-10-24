import { APIError } from './errors.js';

export const validPoint = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const radians = x => x * Math.PI / 180;
export function distance(a, b) {
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function profileRequest(body) {
  const bad = () => { throw new APIError(400, 'invalid_path', 'Supply 2–5000 valid lat/lon points or a latlons string; path length must be 0–20 km, nonzero.'); };
  let path;
  if (typeof body.latlons === 'string' && body.path === undefined) {
    path = body.latlons.split('|').map(pair => {
      const fields = pair.split(',');
      if (fields.length !== 2 || fields.some(v => !v.trim())) bad();
      return { lat: Number(fields[0]), lon: Number(fields[1]) };
    });
  } else if (Array.isArray(body.path) && body.latlons === undefined) {
    path = body.path;
  } else bad();
  if (path.length < 2 || path.length > 5000 || !path.every(validPoint)) bad();
  // Remove exact repeated points only; never round GPS coordinates or merge nearby paths.
  path = path.map(p => ({ lat: p.lat === 0 ? 0 : p.lat, lon: p.lon === 0 ? 0 : p.lon }))
    .filter((p, i, all) => i === 0 || p.lat !== all[i - 1].lat || p.lon !== all[i - 1].lon);
  const chainages = [0];
  for (let i = 1; i < path.length; i++) chainages.push(chainages.at(-1) + distance(path[i - 1], path[i]));
  const length = chainages.at(-1);
  if (!Number.isFinite(length) || length <= 0 || length > 20000) bad();
  const samples = body.samples === undefined ? Math.min(512, Math.max(2, Math.ceil(length) + 1)) : Number(body.samples);
  if (!Number.isInteger(samples) || samples < 2 || samples > 512) {
    throw new APIError(400, 'invalid_samples', 'samples must be an integer from 2 through 512.');
  }
  if ((body.interpolation !== undefined && body.interpolation !== 'bilinear')
      || (body.bathymetry !== undefined && body.bathymetry !== false && body.bathymetry !== 'false')) {
    throw new APIError(400, 'invalid_options', 'Only bilinear interpolation and bathymetry=false are supported.');
  }
  return { path, samples, length, chainages };
}

export function pointAt(profile, distanceMeters) {
  const { path, chainages } = profile;
  if (distanceMeters <= 0) return path[0];
  if (distanceMeters >= chainages.at(-1)) return path.at(-1);
  for (let i = 1; i < path.length; i++) {
    if (distanceMeters <= chainages[i]) {
      const fraction = (distanceMeters - chainages[i - 1]) / (chainages[i] - chainages[i - 1]);
      const longitudeDelta = ((path[i].lon - path[i - 1].lon + 540) % 360) - 180;
      const longitude = path[i - 1].lon + longitudeDelta * fraction;
      return { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * fraction,
        lon: ((longitude + 540) % 360) - 180 };
    }
  }
  return path.at(-1);
}