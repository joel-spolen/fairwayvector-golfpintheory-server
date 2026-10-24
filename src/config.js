import { resolve } from 'node:path';
import { isIP } from 'node:net';

// Only fixed, value-free validation messages may be shown during startup.
export class ConfigurationError extends Error {}

function metricsConfig(env) {
  const url = env.SUPABASE_URL ?? '';
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url === '' && key === '') return null;
  const invalid = () => { throw new ConfigurationError('Configure a valid HTTPS Supabase root URL and server-only service key together'); };
  if (typeof url !== 'string' || typeof key !== 'string' || !url || !key) invalid();
  let parsed;
  try { parsed = new URL(url); } catch { invalid(); }
  // Trusted deployment configuration only, never a request-supplied destination.
  // Require a DNS host, not loopback/private IP literals or local host names.
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/.test(url)
      || parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.pathname !== '/'
      || isIP(parsed.hostname) || !parsed.hostname.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(parsed.hostname)
      || !parsed.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  // Treat keys as opaque credentials, not locally verified JWTs. Never trim a key.
  if (key.length < 8 || key.length > 8192 || !/^[\x21-\x7e]+$/.test(key)
      || !/^(?:eyJ[A-Za-z0-9_.-]+|sb_secret_[A-Za-z0-9_-]+)$/.test(key)) invalid();
  // Recognizable public JWTs are an obvious configuration mistake (not JWT verification).
  if (key.startsWith('eyJ')) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { /* Opaque fixture/key. */ }
    if (claims?.role === 'anon' || claims?.role === 'authenticated') invalid();
  }
  return { url: parsed.origin, key };
}

export function loadConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigurationError(`Invalid ${name}`);
    }
    return value;
  };
  const enabled = name => {
    const value = env[name] ?? 'false';
    if (!['true', 'false'].includes(value)) throw new ConfigurationError(`Invalid ${name}`);
    return value === 'true';
  };
  const token = env.SERVER_API_TOKEN ?? '';
  if (token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new ConfigurationError('SERVER_API_TOKEN must be a printable, non-space secret of 32–512 characters');
  }
  const adminToken = env.ADMIN_API_TOKEN ?? '';
  if (adminToken && (adminToken.length < 32 || adminToken.length > 512
      || !/^[\x21-\x7e]+$/.test(adminToken) || adminToken === token)) {
    throw new ConfigurationError('ADMIN_API_TOKEN must be a distinct printable secret of 32–512 characters');
  }
  const providers = {
    golf: { enabled: enabled('GOLF_API_ENABLED'), key: (env.GOLF_API_KEY ?? '').trim(),
      dailyLimit: integer('GOLF_API_DAILY_LIMIT', 100, 0, 1000000) },
    gpxz: { enabled: enabled('GPXZ_API_ENABLED'), key: (env.GPXZ_API_KEY ?? '').trim(),
      dailyLimit: integer('GPXZ_DAILY_LIMIT', 100, 0, 1000000) }
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.enabled && (!provider.key || /[\r\n]|YOUR_|\$\(|\$\{|[<>]/.test(provider.key))) {
      throw new ConfigurationError(`Configure a valid ${name} provider key before enabling paid fetching`);
    }
  }
  return {
    host: env.HOST || '127.0.0.1', port: integer('PORT', 8080, 1, 65535), token, adminToken,
    dataDir: resolve(env.DATA_DIR || './data'), providers, supabaseMetrics: metricsConfig(env),
    maxConcurrency: integer('MAX_UPSTREAM_CONCURRENCY', 4, 1, 32),
    failureCooldown: integer('FAILURE_COOLDOWN_SECONDS', 300, 1, 86400),
    rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120, 1, 10000)
  };
}