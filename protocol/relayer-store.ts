import { fromJson, openSqlite, toJson, type SqliteDb } from '../src/storage/sqlite.js';
import type { HistoryEntry, TransferState } from './state-machine.js';

export interface StoredRecord<T> {
  id: string;
  state: TransferState;
  attempts: number;
  history: HistoryEntry[];
  payload: T;
  /** Monotonic version for optimistic concurrency (set by the store). */
  version?: number;
}

/** A write was based on an outdated version: another relayer advanced the record first. */
export class StaleRecordError extends Error {
  constructor(public readonly id: string, public readonly expected: number, public readonly actual: number | undefined) {
    super(`stale write for ${id}: expected version ${expected}, store has ${actual}`);
    this.name = 'StaleRecordError';
  }
}

/**
 * Durable relayer state: transfer records, per-chain scan checkpoints and per-record LEASES.
 * Several relayer instances may share one store: a record is only worked on by the instance that
 * holds its lease, and that instance always reloads the latest state before acting. On-chain
 * processed() still prevents double execution if two instances ever overlap; leases prevent the
 * wasted duplicate transactions and state races.
 */
export interface RelayerStore<T> {
  /** True only if state survives a process restart. Production relayers require it. */
  readonly durable: boolean;
  loadAll(): StoredRecord<T>[];
  load(id: string): StoredRecord<T> | undefined;
  /**
   * Compare-and-swap save: succeeds only if the stored version equals `rec.version`
   * (undefined = unconditional overwrite). Returns the new version; throws StaleRecordError.
   */
  save(rec: StoredRecord<T>): number;
  /** Insert only if no record with this id exists (another relayer may already be ahead). */
  insertIfAbsent(rec: StoredRecord<T>): boolean;
  getCheckpoint(chainId: bigint): bigint | undefined;
  /** Monotonic: never moves a checkpoint backwards. */
  setCheckpoint(chainId: bigint, block: bigint): void;
  /** Acquire or renew the lease on `id` for `owner` until now+ttl. Atomic. */
  tryLease(id: string, owner: string, ttlMs: number, nowMs: number): boolean;
  releaseLease(id: string, owner: string): void;
}

export class MemoryRelayerStore<T> implements RelayerStore<T> {
  readonly durable = false;
  private recs = new Map<string, string>();
  private cps = new Map<string, bigint>();
  private leases = new Map<string, { owner: string; until: number }>();
  loadAll() {
    return [...this.recs.values()].map((s) => fromJson<StoredRecord<T>>(s));
  }
  load(id: string) {
    const s = this.recs.get(id);
    return s ? fromJson<StoredRecord<T>>(s) : undefined;
  }
  save(rec: StoredRecord<T>) {
    const cur = this.load(rec.id);
    const curV = cur?.version ?? 0;
    if (rec.version !== undefined && cur && curV !== rec.version) throw new StaleRecordError(rec.id, rec.version, curV);
    const next = curV + 1;
    this.recs.set(rec.id, toJson({ ...rec, version: next }));
    return next;
  }
  insertIfAbsent(rec: StoredRecord<T>) {
    if (this.recs.has(rec.id)) return false;
    this.recs.set(rec.id, toJson({ ...rec, version: 1 }));
    return true;
  }
  getCheckpoint(c: bigint) {
    return this.cps.get(c.toString());
  }
  setCheckpoint(c: bigint, b: bigint) {
    const cur = this.cps.get(c.toString());
    if (cur === undefined || b > cur) this.cps.set(c.toString(), b);
  }
  tryLease(id: string, owner: string, ttlMs: number, nowMs: number) {
    const l = this.leases.get(id);
    if (l && l.owner !== owner && l.until > nowMs) return false;
    this.leases.set(id, { owner, until: nowMs + ttlMs });
    return true;
  }
  releaseLease(id: string, owner: string) {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id);
  }
}

export class SqliteRelayerStore<T> implements RelayerStore<T> {
  private db: SqliteDb;
  readonly durable: boolean;
  constructor(path: string) {
    this.durable = path !== ':memory:' && !path.startsWith('file::memory:');
    this.db = openSqlite(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relayer_records (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS relayer_records_state ON relayer_records(state);
      CREATE TABLE IF NOT EXISTS relayer_checkpoints (chain_id TEXT PRIMARY KEY, block TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relayer_leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL);
    `);
    try {
      this.db.exec('ALTER TABLE relayer_records ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
    } catch {
      /* column exists */
    }
  }
  loadAll() {
    return this.db.prepare('SELECT data, version FROM relayer_records').all().map((r) => ({ ...fromJson<StoredRecord<T>>(String(r.data)), version: Number(r.version) }));
  }
  load(id: string) {
    const r = this.db.prepare('SELECT data, version FROM relayer_records WHERE id = ?').get(id);
    return r ? { ...fromJson<StoredRecord<T>>(String(r.data)), version: Number(r.version) } : undefined;
  }
  save(rec: StoredRecord<T>) {
    const { version, ...body } = rec;
    if (version === undefined) {
      this.db
        .prepare('INSERT INTO relayer_records (id, state, data, updated_at, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at, version=relayer_records.version + 1')
        .run(rec.id, rec.state, toJson(body), Date.now());
      return Number(this.db.prepare('SELECT version FROM relayer_records WHERE id = ?').get(rec.id)!.version);
    }
    // Atomic compare-and-swap on the version column.
    const changes = Number(
      this.db.prepare('UPDATE relayer_records SET state = ?, data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?').run(rec.state, toJson(body), Date.now(), rec.id, version).changes,
    );
    if (changes !== 1) {
      const cur = this.db.prepare('SELECT version FROM relayer_records WHERE id = ?').get(rec.id);
      throw new StaleRecordError(rec.id, version, cur ? Number(cur.version) : undefined);
    }
    return version + 1;
  }
  insertIfAbsent(rec: StoredRecord<T>) {
    const { version: _v, ...body } = rec;
    return Number(this.db.prepare('INSERT OR IGNORE INTO relayer_records (id, state, data, updated_at, version) VALUES (?, ?, ?, ?, 1)').run(rec.id, rec.state, toJson(body), Date.now()).changes) === 1;
  }
  getCheckpoint(chainId: bigint) {
    const r = this.db.prepare('SELECT block FROM relayer_checkpoints WHERE chain_id = ?').get(chainId.toString());
    return r ? BigInt(String(r.block)) : undefined;
  }
  setCheckpoint(chainId: bigint, block: bigint) {
    // Stored as TEXT; compare numerically via CAST to keep it monotonic across relayers.
    this.db
      .prepare('INSERT INTO relayer_checkpoints (chain_id, block) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET block=excluded.block WHERE CAST(excluded.block AS INTEGER) > CAST(relayer_checkpoints.block AS INTEGER)')
      .run(chainId.toString(), block.toString());
  }
  tryLease(id: string, owner: string, ttlMs: number, nowMs: number) {
    const changes = this.db
      .prepare('INSERT INTO relayer_leases (id, owner, until) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, until=excluded.until WHERE relayer_leases.owner = excluded.owner OR relayer_leases.until <= ?')
      .run(id, owner, nowMs + ttlMs, nowMs).changes;
    return Number(changes) === 1;
  }
  releaseLease(id: string, owner: string) {
    this.db.prepare('DELETE FROM relayer_leases WHERE id = ? AND owner = ?').run(id, owner);
  }
  close() {
    this.db.close();
  }
}
