import type { PreparedTx } from '../providers/provider-interface.js';

export type PreparedState =
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTED'
  | 'PENDING'
  | 'DONE'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIAL'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface PreparedRecord {
  id: string;
  requestId: string;
  provider: string;
  tool?: string;
  sourceChainId: number;
  destinationChainId: number;
  sender: string;
  recipient: string;
  sourceToken: string;
  destinationToken: string;
  inputAmount: string;
  expectedOutput: string;
  minOutput: string | null;
  estimatedTimeSeconds: number | null;
  netUsdMicro: string | null;
  createdAt: number;
  expiresAt: number;
  state: PreparedState;
  txHash?: string;
  destinationTxHash?: string;
  receivedAmount?: string;
  lastCheckedAt?: number;
  transactions: { approvals: PreparedTx[]; main: PreparedTx };
  ownerId: string;
  /** Actual vs expected output in bps once the transfer completes (positive = received less). */
  outputDeviationBps?: number;
}

export interface ProviderCallRecord {
  provider: string;
  at: number;
  latencyMs: number;
  outcome: 'ok' | 'error';
  errorCode?: string;
  quotes: number;
  rejectedCodes: string[];
}

/** Storage interface; the in-memory implementation is the default. */
export interface Store {
  savePrepared(r: PreparedRecord): Promise<void>;
  getPrepared(id: string): Promise<PreparedRecord | undefined>;
  updatePrepared(id: string, patch: Partial<PreparedRecord>): Promise<PreparedRecord | undefined>;
  listPrepared(): Promise<PreparedRecord[]>;
  recordProviderCall(r: ProviderCallRecord): Promise<void>;
  providerCalls(sinceMs?: number): Promise<ProviderCallRecord[]>;
}

export class MemoryStore implements Store {
  private prepared = new Map<string, PreparedRecord>();
  private calls: ProviderCallRecord[] = [];
  constructor(private readonly maxCalls = 50_000, private readonly maxPrepared = 100_000) {}

  async savePrepared(r: PreparedRecord) {
    if (this.prepared.size >= this.maxPrepared) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    this.prepared.set(r.id, structuredClone(r));
  }
  async getPrepared(id: string) {
    const r = this.prepared.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async updatePrepared(id: string, patch: Partial<PreparedRecord>) {
    const r = this.prepared.get(id);
    if (!r) return undefined;
    const next = { ...r, ...patch, id: r.id };
    this.prepared.set(id, next);
    return structuredClone(next);
  }
  async listPrepared() {
    return [...this.prepared.values()].map((r) => structuredClone(r));
  }
  async recordProviderCall(r: ProviderCallRecord) {
    this.calls.push(r);
    if (this.calls.length > this.maxCalls) this.calls.splice(0, this.calls.length - this.maxCalls);
  }
  async providerCalls(sinceMs = 0) {
    return this.calls.filter((c) => c.at >= sinceMs);
  }
}
