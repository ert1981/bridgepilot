import { createRequire } from 'node:module';

/**
 * Thin loader for Node's built-in SQLite (node:sqlite, Node >= 22.5). Loaded lazily so the
 * in-memory configuration never touches it. WAL mode + busy timeout make one database file safe
 * to share between several processes on the same host. For several HOSTS, implement the same
 * interfaces on PostgreSQL (see docs/operations.md); the semantics (atomic insert-or-ignore,
 * single-row updates) map 1:1.
 */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

export function openSqlite(path: string): SqliteDb {
  const require = createRequire(import.meta.url);
  const emit = process.emitWarning;
  // Silence the one-time "SQLite is experimental" warning only.
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(w).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDb };
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    return db;
  } finally {
    process.emitWarning = emit;
  }
}

/** JSON with bigint support (bigints are tagged so they round-trip exactly). */
export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
export const fromJson = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$big === 'string' && Object.keys(x).length === 1 ? BigInt(x.$big) : x)) as T;
