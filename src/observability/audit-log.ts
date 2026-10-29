import { appendFile } from 'node:fs/promises';

export interface AuditEvent {
  ts: string;
  type: string;
  requestId?: string;
  [k: string]: unknown;
}

const SECRET_KEYS = /^(x-payment|authorization|api[_-]?key|signature|private[_-]?key)$/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(val, depth + 1);
    return out;
  }
  return v;
}

/** Append-only JSONL audit log; keeps the last N events in memory for tests and reports. */
export class AuditLog {
  readonly recent: AuditEvent[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string, private readonly keep = 1000) {}

  record(type: string, data: Record<string, unknown> = {}): void {
    const ev = redact({ ts: new Date().toISOString(), type, ...data }) as AuditEvent;
    this.recent.push(ev);
    if (this.recent.length > this.keep) this.recent.shift();
    if (this.path) {
      const line = JSON.stringify(ev) + '\n';
      this.chain = this.chain.then(() => appendFile(this.path!, line)).catch(() => undefined);
    }
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
