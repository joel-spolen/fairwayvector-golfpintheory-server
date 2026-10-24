import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Cache } from './cache.js';
import { Providers } from './providers.js';
import { profileRequest } from './geometry.js';
import { APIError } from './errors.js';
import { AdminStore } from './admin-store.js';
import { registerAdmin } from './admin.js';
import { SupabaseMetrics } from './supabase-metrics.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = { type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' } } };
const querySchema = { type: 'object', additionalProperties: false, properties: {
  country: { type: 'string', maxLength: 120 }, state: { type: 'string', maxLength: 120 },
  name: { type: 'string', maxLength: 200 }, page: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' },
  timestampUpdated: { type: 'string', maxLength: 100 }
} };

export async function buildApp(config, { fetchImpl, supabaseFetchImpl, now, logger = false } = {}) {
  const app = Fastify({ logger, bodyLimit: 300000, trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    requestTimeout: 40000, connectionTimeout: 45000 });
  const cache = new Cache(config.dataDir, { now });
  let adminStore;
  const providers = new Providers(config, { fetchImpl });
  const inflight = new Map();
  let active = 0;
  app.addHook('onClose', async () => {
    await Promise.allSettled([...inflight.values()]);
    cache.close();
  });
  try {
    adminStore = new AdminStore(cache);
    await app.register(formbody);
    await app.register(rateLimit, { max: config.rateLimit, timeWindow: '1 minute', hook: 'onRequest' });
    const tokenHash = hash(config.token);
    const adminHash = hash(config.adminToken ?? '');
    app.addHook('onResponse', async (request, reply) => {
      if (!request.dataProvider) return;
      const outcome = reply.statusCode >= 200 && reply.statusCode < 300 ? reply.getHeader('X-Cache') : 'ERROR';
      adminStore.completed(request.dataProvider, outcome);
    });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      const route = request.routeOptions.url ?? '';
      if (route === '/healthz' || ['/admin', '/admin/', '/admin/admin.css', '/admin/admin.js'].includes(route)) return;
      const isAdmin = route.startsWith('/api/admin/');
      if (isAdmin && !config.adminToken) throw new APIError(503, 'admin_disabled', 'Configure ADMIN_API_TOKEN to enable the admin dashboard.');
      const authorization = request.headers.authorization ?? '';
      const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!timingSafeEqual(Buffer.from(hash(candidate)), Buffer.from(isAdmin ? adminHash : tokenHash))) {
        throw new APIError(401, 'unauthorized', isAdmin ? 'Valid admin bearer token required.' : 'Valid server bearer token required.');
      }
      if (route.startsWith('/api/v1/golf/') || route === '/api/v1/elevation/sample') {
        request.dataProvider = route === '/api/v1/elevation/sample' ? 'gpxz' : 'golf';
        adminStore.received(request.dataProvider);
      }
    });
    app.setErrorHandler((error, request, reply) => {
      const known = error instanceof APIError;
      const status = known ? error.statusCode : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (known && error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
      reply.code(status).send({ error: {
        code: known ? error.code : status === 500 ? 'internal_error' : 'invalid_request',
        message: known ? error.message : status === 500 ? 'Server could not complete the request.' : 'Request rejected.'
      } });
    });

    async function readThrough(provider, key, cacheOnly, acquire, maxAge = Infinity) {
      const saved = cache.get(key);
      // Disabled/cache-only operation can still read an older update probe without spending.
      if (saved && (cacheOnly || !config.providers[provider].enabled || cache.now() - saved.fetchedAt < maxAge)) {
        return { ...saved, cacheStatus: 'HIT' };
      }
      if (cacheOnly) throw new APIError(404, 'cache_miss', 'Requested data has not been cached.');
      if (inflight.has(key)) return { ...await inflight.get(key), cacheStatus: 'COALESCED' };
      const settings = config.providers[provider];
      if (!settings.enabled) throw new APIError(503, 'provider_disabled', 'Fetching uncached provider data is disabled.');
      const blocked = Math.max(cache.blocked(key), cache.blocked(`provider:${provider}`));
      if (blocked) throw new APIError(503, 'provider_cooldown', 'Provider requests are temporarily paused.', blocked);
      if (active >= config.maxConcurrency) throw new APIError(503, 'server_busy', 'Too many provider requests are active.', 2);
      // Synchronous reservation and map insertion happen before another request can enter.
      cache.reserve(provider, settings.dailyLimit);
      active++;
      const work = (async () => {
        let result;
        try {
          result = await acquire();
        } catch (error) {
          const seconds = Math.max(config.failureCooldown, error.retryAfter ?? 0);
          cache.block(key, seconds);
          if (error.providerWide !== false) cache.block(`provider:${provider}`, seconds);
          throw error;
        }
        // A persistence failure must fail the request, not claim a cache write succeeded.
        try { return cache.put(key, provider, result); }
        catch (error) {
          cache.block(`provider:${provider}`, config.failureCooldown);
          throw error;
        }
      })();
      inflight.set(key, work);
      try { return { ...await work, cacheStatus: 'MISS' }; }
      finally { active--; inflight.delete(key); }
    }

    function send(reply, result) {
      reply.header('X-Cache', result.cacheStatus);
      reply.header('X-Fetched-At', new Date(result.fetchedAt).toISOString());
      if (result.datasetVersion) reply.header('X-Dataset-Version', result.datasetVersion);
      return result.body;
    }
    const only = request => request.headers['x-cache-only'] === 'true';
    await registerAdmin(app, adminStore, config,
      new SupabaseMetrics(config.supabaseMetrics, { fetchImpl: supabaseFetchImpl, now }));
    app.get('/healthz', async () => ({ status: 'ok' }));
    for (const kind of ['clubs', 'courses']) {
      app.get(`/api/v1/golf/${kind}`, { schema: { querystring: querySchema } }, async (request, reply) => {
        const query = Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, v.trim().normalize('NFC')]).filter(([, v]) => v));
        if (!query.country && !query.state && !query.name) throw new APIError(400, 'search_required', 'Supply country, state or name.');
        query.page ??= '1';
        const canonical = Object.keys(query).sort().map(k => [k, query[k]]);
        const key = `golf:v1:${kind}:${hash(JSON.stringify(canonical))}`;
        return send(reply, await readThrough('golf', key, only(request), () => providers.golf(`/${kind}`, query, kind),
          query.timestampUpdated ? 86400000 : Infinity));
      });
    }
    for (const [route, kind] of [['courses', 'detail'], ['coordinates', 'coordinates']]) {
      app.get(`/api/v1/golf/${route}/:id`, { schema: { params: identifier,
        querystring: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
        const { id } = request.params;
        return send(reply, await readThrough('golf', `golf:v1:${kind}:${id}`, only(request),
          () => providers.golf(`/${route}/${encodeURIComponent(id)}`, {}, kind, id)));
      });
    }
    app.post('/api/v1/elevation/sample', { schema: {
      querystring: { type: 'object', additionalProperties: false },
      body: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'array', minItems: 2, maxItems: 5000, items: { type: 'object',
        required: ['lat', 'lon'], additionalProperties: false, properties: { lat: { type: 'number' }, lon: { type: 'number' } } } },
      latlons: { type: 'string', maxLength: 250000 }, samples: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]{1,3}$' }] },
      courseID: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
      interpolation: { type: 'string' }, bathymetry: { anyOf: [{ type: 'boolean' }, { type: 'string' }] } }
    } } }, async (request, reply) => {
      const profile = profileRequest(request.body);
      const key = `gpxz:sample:v1:${hash(JSON.stringify({ path: profile.path, samples: profile.samples, interpolation: 'bilinear', bathymetry: false }))}`;
      const result = await readThrough('gpxz', key, only(request), () => providers.elevation(profile));
      // Association is metadata only: the global cache key and provider wire format are unchanged.
      adminStore.recordElevation(key, profile, request.body.courseID);
      return send(reply, result);
    });
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}