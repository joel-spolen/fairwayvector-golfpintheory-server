import { APIError } from './errors.js';

const LIMIT = 4 * 1024 * 1024;
const METHODS = new Set(['pintheory_data_admin_overview', 'pintheory_data_admin_assign']);
const unavailable = () => new APIError(503, 'admin_unavailable', 'Supabase administration is unavailable. Check local setup and deployed migrations.');

/** Fixed service RPC transport. No request-supplied URL or RPC name is accepted. */
export class SupabaseRPC {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async call(method, parameters) {
    if (!this.config || !METHODS.has(method)) throw unavailable();
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 15000);
    });
    const work = async () => {
      const { url, key } = this.config;
      const headers = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' };
      if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
      const response = await this.fetch(`${url}/rest/v1/rpc/${method}`, {
        method: 'POST', headers, body: JSON.stringify(parameters), redirect: 'error', signal: controller.signal
      });
      if (!response.ok || response.redirected || !response.body || controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > LIMIT || controller.signal.aborted) throw unavailable();
          chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
      }
    };
    try { return await Promise.race([work(), deadline]); }
    catch { throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}