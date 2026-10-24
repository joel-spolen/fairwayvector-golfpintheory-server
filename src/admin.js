import { readFile } from 'node:fs/promises';
import { APIError } from './errors.js';
import { normalizeOverview } from './admin-overview.js';

export async function registerAdmin(app, rpc, metrics) {
  for (const [route, file, type] of [
    ['/', 'admin.html', 'text/html; charset=utf-8'],
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
  app.get('/api/admin/accounts', { schema: {
    querystring: { type: 'object', additionalProperties: false }
  } }, async () => metrics.get());
  app.get('/api/admin/overview', { schema: { querystring: { type: 'object', additionalProperties: false,
    properties: { days: { type: 'string', enum: ['0', '1', '7', '30'] },
      search: { type: 'string', maxLength: 200 }, page: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } }
  } } }, async request => normalizeOverview(await rpc.call('pintheory_data_admin_overview', {
    p_days: Number(request.query.days ?? 7), p_search: request.query.search ?? '', p_page: Number(request.query.page ?? 1)
  })));
  app.post('/api/admin/elevation/assign', { schema: {
    querystring: { type: 'object', additionalProperties: false },
    body: { type: 'object', additionalProperties: false, required: ['key', 'courseID'], properties: {
      key: { type: 'string', pattern: '^gpxz:sample:v1:[a-f0-9]{64}$' },
      courseID: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' }
    } }
  } }, async request => {
    const result = await rpc.call('pintheory_data_admin_assign', { p_key: request.body.key, p_course_id: request.body.courseID });
    if (result !== true) {
      throw new APIError(404, 'cached_data_not_found', 'Choose an existing cached elevation profile and course.');
    }
    return { ok: true };
  });
}