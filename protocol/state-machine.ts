/**
 * Transfer state machine (protocol spec §4).
 *
 *   CREATED -> SOURCE_PENDING -> SOURCE_FINALIZED -> PROOF_VERIFIED -> DESTINATION_PENDING -> COMPLETED
 *
 * Side states: REJECTED (terminal: proven that nothing was locked), PAUSED (resumable),
 * RECOVERY_REQUIRED (operator), CANCELLED (cancelled on the destination; refund in progress) -> REFUNDED.
 *
 * EXPIRED is NOT terminal: it only means the normal processing window passed while the source was
 * not final. The transfer keeps being watched; if the source later finalizes it continues normally,
 * if the source transaction is proven gone it is REJECTED. Time alone never authorises a refund —
 * a refund requires an on-chain cancellation proving the destination did not (and cannot) execute.
 *
 * A failure never leads to an unauthorised release or a double mint: execution and cancellation
 * share one processed[] slot on-chain, so a message is executed OR cancelled, never both, and a
 * refund exists only for a cancelled message.
 */
export type TransferState =
  | 'CREATED'
  | 'SOURCE_PENDING'
  | 'SOURCE_FINALIZED'
  | 'PROOF_VERIFIED'
  | 'DESTINATION_PENDING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'PAUSED'
  | 'EXPIRED'
  | 'RECOVERY_REQUIRED'
  | 'CANCELLED'
  | 'REFUNDED';

const ALLOWED: Record<TransferState, TransferState[]> = {
  CREATED: ['SOURCE_PENDING', 'REJECTED', 'EXPIRED'],
  SOURCE_PENDING: ['SOURCE_FINALIZED', 'REJECTED', 'EXPIRED'],
  EXPIRED: ['SOURCE_FINALIZED', 'REJECTED', 'RECOVERY_REQUIRED'],
  SOURCE_FINALIZED: ['PROOF_VERIFIED', 'REJECTED', 'RECOVERY_REQUIRED', 'CANCELLED'],
  PROOF_VERIFIED: ['DESTINATION_PENDING', 'COMPLETED', 'PAUSED', 'RECOVERY_REQUIRED', 'SOURCE_FINALIZED', 'CANCELLED'],
  DESTINATION_PENDING: ['COMPLETED', 'PAUSED', 'RECOVERY_REQUIRED', 'PROOF_VERIFIED', 'CANCELLED'],
  PAUSED: ['PROOF_VERIFIED', 'RECOVERY_REQUIRED', 'CANCELLED'],
  RECOVERY_REQUIRED: ['PROOF_VERIFIED', 'SOURCE_FINALIZED', 'COMPLETED', 'CANCELLED'],
  CANCELLED: ['REFUNDED'],
  COMPLETED: [],
  REJECTED: [],
  REFUNDED: [],
};

export const TERMINAL: TransferState[] = ['COMPLETED', 'REJECTED', 'REFUNDED'];

export class IllegalTransition extends Error {
  constructor(public readonly from: TransferState, public readonly to: TransferState) {
    super(`illegal transition ${from} -> ${to}`);
  }
}

export function canTransition(from: TransferState, to: TransferState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TransferState, to: TransferState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export interface HistoryEntry {
  state: TransferState;
  at: number;
  reason?: string;
}

export class TransferRecord<T> {
  state: TransferState = 'CREATED';
  history: HistoryEntry[];
  attempts = 0;
  /** Set on every change; the relayer persists dirty records after each step. */
  dirty = true;
  /** Store version this in-memory copy is based on (optimistic concurrency). */
  version: number | undefined;

  constructor(public readonly id: string, public readonly payload: T, now: number) {
    this.history = [{ state: 'CREATED', at: now }];
  }

  static restore<T>(s: { id: string; state: TransferState; attempts: number; history: HistoryEntry[]; payload: T; version?: number }): TransferRecord<T> {
    const r = new TransferRecord<T>(s.id, s.payload, s.history[0]?.at ?? 0);
    r.version = s.version;
    r.state = s.state;
    r.history = s.history;
    r.attempts = s.attempts;
    r.dirty = false;
    return r;
  }

  move(to: TransferState, now: number, reason?: string): void {
    assertTransition(this.state, to);
    this.state = to;
    this.history.push({ state: to, at: now, reason });
    this.dirty = true;
  }

  get terminal(): boolean {
    return TERMINAL.includes(this.state);
  }

  /** Time spent in the current state. */
  ageInState(now: number): number {
    return now - (this.history.at(-1)?.at ?? now);
  }
}
