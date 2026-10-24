import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  };
  const enabled = name => {
    const value = env[name] ?? 'false';
    if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}`);
    return value === 'true';
  };
  const token = env.SERVER_API_TOKEN ?? '';
  if (token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('SERVER_API_TOKEN must be a printable, non-space secret of 32–512 characters');
  }
  const adminToken = env.ADMIN_API_TOKEN ?? '';
  if (adminToken && (adminToken.length < 32 || adminToken.length > 512
      || !/^[\x21-\x7e]+$/.test(adminToken) || adminToken === token)) {
    throw new Error('ADMIN_API_TOKEN must be a distinct printable secret of 32–512 characters');
  }
  const providers = {
    golf: { enabled: enabled('GOLF_API_ENABLED'), key: (env.GOLF_API_KEY ?? '').trim(),
      dailyLimit: integer('GOLF_API_DAILY_LIMIT', 100, 0, 1000000) },
    gpxz: { enabled: enabled('GPXZ_API_ENABLED'), key: (env.GPXZ_API_KEY ?? '').trim(),
      dailyLimit: integer('GPXZ_DAILY_LIMIT', 100, 0, 1000000) }
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.enabled && (!provider.key || /[\r\n]|YOUR_|\$\(|\$\{|[<>]/.test(provider.key))) {
      throw new Error(`Configure a valid ${name} provider key before enabling paid fetching`);
    }
  }
  return {
    host: env.HOST || '127.0.0.1', port: integer('PORT', 8080, 1, 65535), token, adminToken,
    dataDir: resolve(env.DATA_DIR || './data'), providers,
    maxConcurrency: integer('MAX_UPSTREAM_CONCURRENCY', 4, 1, 32),
    failureCooldown: integer('FAILURE_COOLDOWN_SECONDS', 300, 1, 86400),
    rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120, 1, 10000)
  };
}