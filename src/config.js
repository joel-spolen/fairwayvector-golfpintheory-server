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
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new ConfigurationError('HOST must be 127.0.0.1 or ::1');
  }
  // Old tokens, provider settings and DATA_DIR are intentionally ignored.
  return { host, port: integer('PORT', 8080, 0, 65535), supabaseMetrics: metricsConfig(env) };
}