const MAX_BYTES = 256 * 1024;
const MESSAGES = {
  ready: 'Account metrics are ready.',
  disabled: 'Account metrics are not configured.',
  unavailable: 'Account metrics are temporarily unavailable.',
  stale: 'Account metrics are temporarily unavailable; showing stale data.'
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValid(condition) {
  if (!condition) throw new Error('Invalid aggregate metrics.');
}
function count(value) {
  requireValid(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
  const result = Number(value);
  requireValid(Number.isSafeInteger(result));
  return result;
}
function date(value) {
  requireValid(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value));
  const parsed = new Date(value);
  requireValid(Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 19) === value.slice(0, 19));
  return value;
}
function normalize(raw) {
  requireValid(object(raw) && raw.schemaVersion === 1 && typeof raw.historyComplete === 'boolean'
    && raw.activityDefinition === 'signed_in_last_30_days' && object(raw.users) && object(raw.storage));
  const generatedAt = date(raw.generatedAt);
  const trackingStartedAt = date(raw.trackingStartedAt);
  requireValid(Date.parse(trackingStartedAt) <= Date.parse(generatedAt));
  const users = {};
  for (const field of ['current', 'active30d', 'knownRegistrations', 'knownDeletions']) users[field] = count(raw.users[field]);
  const storage = {};
  for (const field of ['currentUserSyncBytes', 'recordsBytes', 'historyBytes', 'receiptsBytes',
    'averageBytesPerUser', 'maxBytesPerUser', 'syncPhysicalBytes', 'databaseBytes']) storage[field] = count(raw.storage[field]);
  requireValid(raw.storage.objectStorageBytes === null);
  storage.objectStorageBytes = null;
  // Registrations include a baseline; deletions can include soft/anonymous events.
  // Do not assume registrations minus deletions equals current eligible users.
  requireValid(users.active30d <= users.current && users.knownRegistrations >= users.current);
  const total = BigInt(storage.recordsBytes) + BigInt(storage.historyBytes) + BigInt(storage.receiptsBytes);
  requireValid(total === BigInt(storage.currentUserSyncBytes));
  const average = users.current ? (total + BigInt(users.current) - 1n) / BigInt(users.current) : 0n;
  requireValid(BigInt(storage.averageBytesPerUser) === average
    && storage.maxBytesPerUser <= storage.currentUserSyncBytes
    && storage.maxBytesPerUser >= storage.averageBytesPerUser
    && (users.current !== 0 || total === 0n));
  // Construct the entire output explicitly: extra identities/provider fields never escape.
  return { schemaVersion: 1, generatedAt, trackingStartedAt, historyComplete: raw.historyComplete,
    activityDefinition: 'signed_in_last_30_days', users, storage };
}

async function readJSON(response, signal) {
  requireValid(response.ok && !response.redirected && response.body);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValid(size <= MAX_BYTES);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } finally {
    // Cancel even on parse/size/read failures; do not await an untrusted stream's cancel.
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export class SupabaseMetrics {
  #config;
  #fetch;
  #now;
  #inflight = null;
  #cached = null;
  #expiresAt = 0;
  #previous = null;

  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async get() {
    if (!this.#config) return { status: 'disabled', fetchedAt: null, data: null, message: MESSAGES.disabled };
    if (this.#inflight) return structuredClone(await this.#inflight);
    if (this.#cached && this.#now() < this.#expiresAt) return structuredClone(this.#cached);
    this.#inflight = this.#load();
    try { return structuredClone(await this.#inflight); }
    finally { this.#inflight = null; }
  }

  async #load() {
    const controller = new AbortController();
    let timer;
    // Race the entire operation (including streaming), even if an injected fetch ignores abort.
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Metrics request timed out.'));
      }, 10000);
    });
    const work = async () => {
      const { url, key } = this.#config;
      const headers = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' };
      if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
      const response = await this.#fetch(`${url}/rest/v1/rpc/pintheory_admin_account_metrics`, {
        method: 'POST', headers, body: '{}', redirect: 'error', signal: controller.signal
      });
      // Discard error/redirect bodies without reading or exposing their contents.
      if (!response.ok || response.redirected || controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Metrics request failed.');
      }
      return normalize(await readJSON(response, controller.signal));
    };
    try {
      const data = await Promise.race([work(), deadline]);
      this.#previous = { fetchedAt: new Date(this.#now()).toISOString(), data };
      this.#cached = { status: 'ready', ...this.#previous, message: MESSAGES.ready };
      this.#expiresAt = this.#now() + 60000;
    } catch {
      this.#cached = { status: 'unavailable', fetchedAt: this.#previous?.fetchedAt ?? null,
        data: this.#previous?.data ?? null, message: this.#previous ? MESSAGES.stale : MESSAGES.unavailable };
      this.#expiresAt = this.#now() + 15000;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return this.#cached;
  }
}