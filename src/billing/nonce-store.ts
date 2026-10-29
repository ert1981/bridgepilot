import { openSqlite, type SqliteDb } from '../storage/sqlite.js';

/**
 * Atomic payment-nonce reservation. `reserve` must succeed for exactly ONE caller per key, across
 * all processes that share the store, until the key expires (after the authorization's validBefore,
 * a payment can no longer be settled, so the entry can be dropped).
 */
export interface NonceStore {
  reserve(key: string, expiresAtMs: number, nowMs: number): boolean;
  release(key: string): void;
}

export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();
  reserve(key: string, expiresAtMs: number, nowMs: number): boolean {
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > nowMs) return false;
    this.seen.set(key, expiresAtMs);
    if (this.seen.size > 50_000) for (const [k, e] of this.seen) if (e <= nowMs) this.seen.delete(k);
    return true;
  }
  release(key: string): void {
    this.seen.delete(key);
  }
}

/** Shared across every process using the same database file (SQLite serialises writers). */
export class SqliteNonceStore implements NonceStore {
  private db: SqliteDb;
  constructor(pathOrDb: string | SqliteDb) {
    this.db = typeof pathOrDb === 'string' ? openSqlite(pathOrDb) : pathOrDb;
    this.db.exec('CREATE TABLE IF NOT EXISTS payment_nonces (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  }
  reserve(key: string, expiresAtMs: number, nowMs: number): boolean {
    // Expired entries may be reclaimed; the INSERT is the atomic test-and-set.
    this.db.prepare('DELETE FROM payment_nonces WHERE key = ? AND expires_at <= ?').run(key, nowMs);
    return Number(this.db.prepare('INSERT OR IGNORE INTO payment_nonces (key, expires_at) VALUES (?, ?)').run(key, expiresAtMs).changes) === 1;
  }
  release(key: string): void {
    this.db.prepare('DELETE FROM payment_nonces WHERE key = ?').run(key);
  }
  prune(nowMs: number): void {
    this.db.prepare('DELETE FROM payment_nonces WHERE expires_at <= ?').run(nowMs);
  }
}
