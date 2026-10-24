import Fastify from 'fastify';
import { APIError } from './errors.js';
import { ConfigurationError } from './config.js';
import { registerAdmin } from './admin.js';
import { SupabaseMetrics } from './supabase-metrics.js';
import { SupabaseRPC } from './supabase-rpc.js';

export async function buildApp(config, { fetchImpl, supabaseFetchImpl = fetchImpl, now } = {}) {
  if (!['127.0.0.1', '::1'].includes(config.host)
      || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ConfigurationError('Configure a loopback HOST and valid PORT');
  }
  // Never log request URLs, bodies, credentials or transport exceptions.
  const app = Fastify({ logger: false, bodyLimit: 8192, trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    requestTimeout: 20000, connectionTimeout: 20000 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    const reject = () => { throw new APIError(403, 'local_request_required', 'Request rejected by local admin security.'); };
    // Inspect the socket, never forwarded headers or a proxy-derived request IP.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.raw.socket.remoteAddress)) reject();
    const port = app.server.address()?.port ?? config.port;
    const literal = config.host === '::1' ? '[::1]' : config.host;
    const hosts = [`${literal}:${port}`, `localhost:${port}`];
    const host = request.headers.host;
    if (!hosts.includes(host)) reject();
    // Reject duplicate Host headers as well as malformed/normalized aliases.
    const raw = request.raw.rawHeaders;
    if (raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) reject();
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) reject();
    if (request.headers['sec-fetch-site'] === 'cross-site') reject();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-local-admin'] !== '1') reject();
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof APIError;
    const status = known ? error.statusCode : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: { code: known ? error.code : status === 500 ? 'internal_error' : 'invalid_request',
      message: known ? error.message : status === 500 ? 'Local admin could not complete the request.' : 'Request rejected.' } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } }));
  try {
    await registerAdmin(app, new SupabaseRPC(config.supabaseMetrics, { fetchImpl: supabaseFetchImpl }),
      new SupabaseMetrics(config.supabaseMetrics, { fetchImpl: supabaseFetchImpl, now }));
    app.get('/healthz', async () => ({ status: 'ok', service: 'local-admin' }));
    await app.ready();
    return app;
  } catch (error) { await app.close(); throw error; }
}