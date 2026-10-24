import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { APIError } from './errors.js';

// One process per data directory: single-flight is intentionally process-local.
export class Cache {
  constructor(directory, { now = Date.now } = {}) {
    this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(directory, 'server.lock');
    try {
      this.lock = openSync(this.lockPath, 'wx', 0o600);
    } catch {
      throw new Error('Data directory is locked. Stop the other server; after a crash, verify it is stopped before removing server.lock.');
    }
    try {
      this.db = new DatabaseSync(join(directory, 'cache.sqlite'));
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS responses (
          key TEXT PRIMARY KEY, provider TEXT NOT NULL, body TEXT NOT NULL,
          fetched_at INTEGER NOT NULL, dataset_version TEXT
        );
        CREATE TABLE IF NOT EXISTS failures (
          key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage (
          provider TEXT NOT NULL, day TEXT NOT NULL, attempts INTEGER NOT NULL,
          PRIMARY KEY(provider, day)
        );
      `);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get(key) {
    const row = this.db.prepare('SELECT * FROM responses WHERE key = ?').get(key);
    return row ? { body: JSON.parse(row.body), fetchedAt: row.fetched_at,
      datasetVersion: row.dataset_version } : null;
  }

  put(key, provider, result) {
    const fetchedAt = this.now();
    this.db.prepare(`INSERT OR REPLACE INTO responses
      (key, provider, body, fetched_at, dataset_version) VALUES (?, ?, ?, ?, ?)`).run(
      key, provider, JSON.stringify(result.body), fetchedAt, result.datasetVersion ?? null);
    return { ...result, fetchedAt };
  }

  blocked(key) {
    const until = this.db.prepare('SELECT until_ms FROM failures WHERE key = ?').get(key)?.until_ms ?? 0;
    return Math.max(0, Math.ceil((until - this.now()) / 1000));
  }

  block(key, seconds) {
    this.db.prepare(`INSERT INTO failures VALUES (?, ?) ON CONFLICT(key)
      DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)`).run(key, this.now() + seconds * 1000);
  }

  reserve(provider, limit) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    // Reservation committed BEFORE dispatch. Never refund a timeout or failed call.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare('SELECT attempts FROM usage WHERE provider = ? AND day = ?')
        .get(provider, day)?.attempts ?? 0;
      if (count >= limit) throw new APIError(503, 'daily_budget_exhausted', 'Server provider daily budget exhausted.');
      this.db.prepare(`INSERT INTO usage VALUES (?, ?, 1) ON CONFLICT(provider, day)
        DO UPDATE SET attempts = attempts + 1`).run(provider, day);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db?.close();
    this.db = null;
    if (this.lock !== undefined) {
      closeSync(this.lock);
      unlinkSync(this.lockPath);
      this.lock = undefined;
    }
  }
}