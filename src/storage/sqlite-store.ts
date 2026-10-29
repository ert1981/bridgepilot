import { fromJson, openSqlite, toJson, type SqliteDb } from './sqlite.js';
import type { PreparedRecord, ProviderCallRecord, Store } from './store.js';

/**
 * Durable API store (prepared transfers + provider call history). Safe for several processes on
 * one host. Updates are single-statement read-modify-write inside a transaction, so concurrent
 * status polls cannot lose each other's changes.
 */
export class SqliteStore implements Store {
  readonly db: SqliteDb;

  constructor(path: string) {
    this.db = openSqlite(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prepared (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_calls (provider TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS provider_calls_at ON provider_calls(at);
    `);
  }

  async savePrepared(r: PreparedRecord): Promise<void> {
    this.db.prepare('INSERT INTO prepared (id, created_at, data) VALUES (?, ?, ?)').run(r.id, r.createdAt, toJson(r));
  }

  async getPrepared(id: string): Promise<PreparedRecord | undefined> {
    const row = this.db.prepare('SELECT data FROM prepared WHERE id = ?').get(id);
    return row ? fromJson<PreparedRecord>(String(row.data)) : undefined;
  }

  async updatePrepared(id: string, patch: Partial<PreparedRecord>): Promise<PreparedRecord | undefined> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = await this.getPrepared(id);
      if (!cur) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const next = { ...cur, ...patch, id: cur.id };
      this.db.prepare('UPDATE prepared SET data = ? WHERE id = ?').run(toJson(next), id);
      this.db.exec('COMMIT');
      return next;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async listPrepared(): Promise<PreparedRecord[]> {
    return this.db.prepare('SELECT data FROM prepared ORDER BY created_at').all().map((r) => fromJson<PreparedRecord>(String(r.data)));
  }

  async recordProviderCall(r: ProviderCallRecord): Promise<void> {
    this.db.prepare('INSERT INTO provider_calls (provider, at, data) VALUES (?, ?, ?)').run(r.provider, r.at, toJson(r));
  }

  async providerCalls(sinceMs = 0): Promise<ProviderCallRecord[]> {
    return this.db.prepare('SELECT data FROM provider_calls WHERE at >= ? ORDER BY at').all(sinceMs).map((r) => fromJson<ProviderCallRecord>(String(r.data)));
  }

  /** Retention: drop history older than `beforeMs`. */
  prune(beforeMs: number): void {
    this.db.prepare('DELETE FROM provider_calls WHERE at < ?').run(beforeMs);
  }
}
