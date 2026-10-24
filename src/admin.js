import { readFile } from 'node:fs/promises';
import { APIError } from './errors.js';

export async function registerAdmin(app, store, config) {
  // Fixed allowlist: no filesystem path is ever constructed from a user URL.
  for (const [route, file, type] of [
    ['/admin', 'admin.html', 'text/html; charset=utf-8'],
    ['/admin/', 'admin.html', 'text/html; charset=utf-8'],
    ['/admin/admin.css', 'admin.css', 'text/css; charset=utf-8'],
    ['/admin/admin.js', 'admin.js', 'text/javascript; charset=utf-8']
  ]) {
    const content = await readFile(new URL(`../public/${file}`, import.meta.url));
    app.get(route, async (request, reply) => {
      reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Frame-Options', 'DENY');
      return reply.type(type).send(content);
    });
  }
  app.get('/api/admin/overview', { schema: { querystring: { type: 'object', additionalProperties: false,
    properties: { days: { type: 'string', enum: ['0', '1', '7', '30'] },
      search: { type: 'string', maxLength: 200 }, page: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } }
  } } }, async request => {
    const snapshot = store.snapshot({ days: Number(request.query.days ?? 7),
      search: request.query.search ?? '', page: Number(request.query.page ?? 1) });
    for (const provider of snapshot.providers) {
      provider.enabled = config.providers[provider.id].enabled;
      provider.dailyLimit = config.providers[provider.id].dailyLimit;
      provider.cooldownSeconds = store.cache.blocked(`provider:${provider.id}`);
    }
    return snapshot;
  });
  app.post('/api/admin/elevation/assign', { schema: {
    querystring: { type: 'object', additionalProperties: false },
    body: { type: 'object', additionalProperties: false, required: ['key', 'courseID'], properties: {
      key: { type: 'string', pattern: '^gpxz:sample:v1:[a-f0-9]{64}$' },
      courseID: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' }
    } }
  } }, async request => {
    if (!store.assignElevation(request.body.key, request.body.courseID)) {
      throw new APIError(404, 'cached_data_not_found', 'Choose an existing cached elevation profile and course.');
    }
    return { ok: true };
  });
}