import { randomUUID } from 'node:crypto';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEventLogs,
  recoverAddress,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { endpointOf, type Attester } from './attester.js';
import { independentOperators, validateRegistry, type Resolver, type RpcProvider } from './rpc-providers.js';
import { finalizedBlockNumber, isFinal, type FinalityPolicy } from './finality.js';
import { MemoryRelayerStore, StaleRecordError, type RelayerStore } from './relayer-store.js';
import { TransferRecord, type TransferState } from './state-machine.js';
import { artifact, KIND_LOCK_MINT, refundOf, type BridgeMessage } from './types.js';

export interface RelayerChain {
  chainId: bigint;
  client: PublicClient;
  wallet: WalletClient;
  finality: FinalityPolicy;
  /** BridgeVault on the home chain, BridgeExecutor on remotes. */
  bridge: Address;
  verifier: Address;
  role: 'home' | 'remote';
  /** First block to scan when no checkpoint exists (deployment block). */
  startBlock?: bigint;
  /**
   * Independent RPC endpoints (other providers) used, together with `client`, to PROVE that a source
   * lock does not exist before a transfer is ever rejected. A missing receipt on one RPC proves nothing.
   */
  proofClients?: PublicClient[];
  /** How many endpoints (incl. `client`) must ALL agree that nothing is locked. Default 2, min 2. */
  rejectQuorum?: number;
  /**
   * Builds the `proof` argument for this chain's verifier from the threshold signatures. Default:
   * the signatures themselves (MessageVerifier). After a VerifierRouter upgrade to e.g.
   * CompositeVerifier(signers, proofVerifier), plug the prover in here — the bridge contracts are
   * unchanged and the destination re-verifies everything.
   */
  proofBuilder?: (m: BridgeMessage, signatures: Hex[]) => Promise<Hex[]>;
}

export interface TransferPayload {
  message: BridgeMessage;
  sourceTxHash: Hex;
  messageId: Hex;
  signatures?: Hex[];
  /** Write-ahead: hash + signed raw tx are persisted BEFORE broadcast. */
  destTxHash?: Hex;
  destRawTx?: Hex;
  submittedAt?: number;
  misses?: number;
  /** Source block in which the lock/burn event was first seen. */
  seenBlock?: bigint;
  /** Set once the "receipt missing but lock not disproven" critical alert was raised. */
  unprovenAlerted?: boolean;
  lastError?: string;
  /** Destination block from which a cancellation could have happened (bounded event search). */
  destSearchFrom?: bigint;
  cancelTxHash?: Hex;
  cancelBlock?: bigint;
  refundSignatures?: Hex[];
  refundTxHash?: Hex;
  refundRawTx?: Hex;
  alertedKey?: string;
}

export interface RelayerAlert {
  level: 'warning' | 'critical';
  id: string;
  state: TransferState | 'GATE';
  reason: string;
  sinceMs: number;
}

export type RecoveryAction = 'retry_execution' | 're_attest';

export interface RelayerOptions {
  /**
   * Durable store. REQUIRED outside devMode: an in-memory store loses write-ahead transactions,
   * leases and checkpoints on restart.
   */
  store?: RelayerStore<TransferPayload>;
  now?: () => number;
  maxAttempts?: number;
  /** Normal processing window for source finality; after it the transfer is EXPIRED (still watched). */
  expiryMs?: number;
  destTimeoutMs?: number;
  /** A non-terminal transfer older than this in one state raises a warning alert. */
  stuckAfterMs?: number;
  /** Blocks re-scanned behind the checkpoint to pick up re-included events after reorgs. */
  reorgMargin?: bigint;
  onAlert?: (a: RelayerAlert) => void;
  /** Unique id of this relayer instance (lease owner). */
  ownerId?: string;
  leaseTtlMs?: number;
  /** Operator ids allowed to call recover(). */
  operators?: string[];
  /**
   * Mandatory deployment/readiness gate (use `readinessGate(...)`). While it returns false, no
   * FORWARD transaction (execute/release) is submitted; recovery (refunds of cancelled transfers,
   * which only return funds to the original sender and are fully re-verified on-chain) continues.
   * Constructing a Relayer without a gate throws, unless `devMode` is set AND every configured
   * chain is a local development chain.
   */
  gate?: { check: () => Promise<boolean>; intervalMs?: number };
  devMode?: boolean;
  /**
   * Declared RPC provider registry (see rpc-providers.ts). A transfer can only be rejected
   * automatically when connections from >= rejectQuorum independent DECLARED operators (with no
   * shared IP addresses) agree. Without a registry, nothing is ever rejected automatically.
   */
  rpcProviders?: RpcProvider[];
  /** DNS resolver override (tests). */
  resolver?: Resolver;
  /** Max block range per getLogs query. */
  logChunk?: bigint;
  /** Test-only fault injection. */
  testHooks?: {
    afterPersistBeforeBroadcast?: (kind: 'destination' | 'refund') => void;
    beforeBroadcast?: (kind: 'destination' | 'refund') => Promise<void>;
    disableLeaseRenewal?: boolean;
  };
}

const MESSAGE_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'version', type: 'uint8' },
      { name: 'kind', type: 'uint8' },
      { name: 'sourceChainId', type: 'uint256' },
      { name: 'sourceContract', type: 'address' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'destContract', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'canonicalToken', type: 'address' },
      { name: 'sender', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
] as const;

export function messageId(m: BridgeMessage): Hex {
  return keccak256(encodeAbiParameters(MESSAGE_TUPLE, [m]));
}

const PAUSE_ERRORS = ['EnforcedPause', 'RoutePaused'];
const STALE_SIGNATURE_ERRORS = ['InvalidSignature', 'UnknownSigner', 'NotEnoughSignatures', 'SignersNotSorted', 'TooManySignatures'];
const RETRY_LATER_ERRORS = ['RateLimitExceeded', 'RefundLimitExceeded'];
const REORG_MISSES = 3;
const GAS_BUFFER_PCT = 130n;
const GAS_BUFFER_FIXED = 30_000n;
const CANCELLABLE: TransferState[] = ['SOURCE_FINALIZED', 'PROOF_VERIFIED', 'DESTINATION_PENDING', 'PAUSED', 'RECOVERY_REQUIRED'];
/** Attester refusals that PROVE nothing was locked (safe to reject permanently). */
const PROVES_NOTHING_LOCKED = /transaction reverted|event not found in receipt/;
/** Refusals that point to configuration / data problems (funds may be locked: never reject). */
const NEEDS_OPERATOR = /differs|route not allowed|not supported|no verifier/;

export class LeaseLostError extends Error {
  constructor(public readonly id: string) {
    super(`lease lost for ${id}; another relayer took over`);
    this.name = 'LeaseLostError';
  }
}

function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? 'revert';
  }
  return undefined;
}

/**
 * Relayer: moves transfers through the state machine. It is untrusted by design — it cannot forge
 * attestations and destination contracts re-verify everything — so a buggy or malicious relayer can
 * delay transfers but cannot steal or double-spend.
 *
 * Durability & concurrency:
 *  - every state change is persisted; a restart resumes where it stopped;
 *  - transactions are signed and their hash persisted BEFORE broadcast (write-ahead), so a crash
 *    between sending and saving can never lose track of a submitted transaction;
 *  - several instances may share a store: each record is processed only under a lease, after
 *    reloading its latest state.
 */
export class Relayer {
  readonly records = new Map<string, TransferRecord<TransferPayload>>();
  readonly ownerId: string;
  private readonly vaultAbi: Abi;
  private readonly execAbi: Abi;
  private readonly verifierAbi = artifact('MessageVerifier').abi;
  private readonly store: RelayerStore<TransferPayload>;
  private gateState?: { open: boolean; at: number; alerted: boolean };
  private forwardAllowed = false;
  /** Observability: how often this instance aborted because another one owned/advanced a record. */
  readonly stats = { superseded: 0, leaseLostBeforeSend: 0 };
  private current?: { id: string; lost: boolean };

  constructor(
    private readonly chains: Map<bigint, RelayerChain>,
    private readonly attesters: Attester[],
    private readonly opts: RelayerOptions = {},
  ) {
    const verifierErrors = this.verifierAbi.filter((x) => x.type === 'error');
    this.vaultAbi = [...artifact('BridgeVault').abi, ...verifierErrors];
    this.execAbi = [...artifact('BridgeExecutor').abi, ...verifierErrors];
    const local = [...chains.keys()].every((id) => id >= 31337n && id <= 31339n);
    if (opts.devMode && !local) throw new Error('devMode is only allowed when every chain is a local development chain');
    if (!opts.gate && !opts.devMode) throw new Error('Relayer requires a readiness gate (readinessGate(...)); ungated operation is only allowed with devMode on local chains');
    if (!opts.devMode && (!opts.store || opts.store instanceof MemoryRelayerStore || opts.store.durable !== true)) {
      throw new Error('Relayer requires a durable store (e.g. SqliteRelayerStore); MemoryRelayerStore is only allowed with devMode on local chains');
    }
    const regErrors = validateRegistry(opts.rpcProviders ?? []);
    if (regErrors.length) throw new Error(`invalid RPC provider registry: ${regErrors.join('; ')}`);
    this.store = opts.store ?? new MemoryRelayerStore();
    this.ownerId = opts.ownerId ?? `relayer-${randomUUID()}`;
    this.refreshIndex();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private abiOf(c: RelayerChain): Abi {
    return c.role === 'home' ? this.vaultAbi : this.execAbi;
  }

  /** Pick up records created by other instances. */
  private refreshIndex(): void {
    for (const s of this.store.loadAll()) if (!this.records.has(s.id)) this.records.set(s.id, TransferRecord.restore(s));
  }

  /** Compare-and-swap persist: throws StaleRecordError if another instance advanced the record. */
  private persist(rec: TransferRecord<TransferPayload>): void {
    if (!rec.dirty) return;
    rec.version = this.store.save({ id: rec.id, state: rec.state, attempts: rec.attempts, history: rec.history, payload: rec.payload, version: rec.version });
    rec.dirty = false;
  }

  /** Re-confirm (and renew) the lease right before an irreversible action. */
  private assertLeaseHeld(id: string): void {
    const ttl = this.opts.leaseTtlMs ?? 60_000;
    if (this.current?.id === id && this.current.lost) throw new LeaseLostError(id);
    if (!this.store.tryLease(id, this.ownerId, ttl, this.now())) throw new LeaseLostError(id);
  }

  /** Discover new source events since the stored checkpoint (minus a reorg margin). */
  async scan(chainId: bigint): Promise<number> {
    const c = this.chains.get(chainId);
    if (!c) throw new Error(`unknown chain ${chainId}`);
    const head = await c.client.getBlockNumber({ cacheTime: 0 });
    const cp = this.store.getCheckpoint(chainId);
    const margin = this.opts.reorgMargin ?? 64n;
    let from = cp === undefined ? c.startBlock ?? 0n : cp + 1n > margin ? cp + 1n - margin : 0n;
    if (c.startBlock !== undefined && from < c.startBlock) from = c.startBlock;
    if (from > head) return 0;
    let added = 0;
    for (const logs of await this.chunkedLogs(c, from, head)) {
      for (const ev of parseEventLogs({ abi: this.abiOf(c), logs, eventName: 'TransferInitiated' })) {
        const m = (ev.args as unknown as { message: BridgeMessage }).message;
        // Key by the full message hash: after a reorg a DIFFERENT message can reuse the same nonce.
        const id = messageId(m);
        const existing = this.store.load(id);
        // A transfer rejected as "not locked" whose event is seen again (re-included) is re-admitted.
        const reorgRejected = existing?.state === 'REJECTED' && /reorg|proven not locked/.test(existing.history.at(-1)?.reason ?? '');
        if (existing && !reorgRejected) {
          if (!this.records.has(id)) this.records.set(id, TransferRecord.restore(existing));
          continue;
        }
        const dst = this.chains.get(m.destChainId);
        const destHead = dst ? await dst.client.getBlockNumber({ cacheTime: 0 }) : 0n;
        const rec = new TransferRecord<TransferPayload>(
          id,
          { message: m, sourceTxHash: ev.transactionHash!, messageId: id, seenBlock: ev.blockNumber ?? undefined, destSearchFrom: destHead > margin ? destHead - margin : 0n },
          this.now(),
        );
        rec.move('SOURCE_PENDING', this.now(), `seen in block ${ev.blockNumber}`);
        const stored = { id, state: rec.state, attempts: 0, history: rec.history, payload: rec.payload };
        if (reorgRejected) {
          try {
            rec.version = this.store.save({ ...stored, version: existing!.version });
          } catch (e) {
            if (e instanceof StaleRecordError) continue; // another relayer re-admitted it
            throw e;
          }
        } else if (!this.store.insertIfAbsent(stored)) continue; // another relayer was faster
        else rec.version = 1;
        rec.dirty = false;
        this.records.set(id, rec);
        added++;
      }
    }
    this.store.setCheckpoint(chainId, head);
    return added;
  }

  private async chunkedLogs(c: RelayerChain, from: bigint, to: bigint) {
    const step = this.opts.logChunk ?? 10_000n;
    const out = [];
    for (let a = from; a <= to; a += step) {
      const b = a + step - 1n < to ? a + step - 1n : to;
      out.push(await c.client.getLogs({ address: c.bridge, fromBlock: a, toBlock: b }));
    }
    return out;
  }

  private async gateOpen(): Promise<boolean> {
    const g = this.opts.gate;
    if (!g) return true;
    const now = this.now();
    if (!this.gateState || now - this.gateState.at >= (g.intervalMs ?? 60_000)) {
      let open = false;
      try {
        open = await g.check();
      } catch {
        open = false;
      }
      this.gateState = { open, at: now, alerted: open ? false : this.gateState?.alerted ?? false };
    }
    if (!this.gateState.open && !this.gateState.alerted) {
      this.gateState.alerted = true;
      this.opts.onAlert?.({ level: 'critical', id: 'deployment', state: 'GATE', reason: 'readiness check failed; forward submissions are held (recovery/refunds continue)', sinceMs: 0 });
    }
    return this.gateState.open;
  }

  async tick(): Promise<void> {
    // The gate controls FORWARD submissions only; reads, attestations and recovery always run.
    this.forwardAllowed = await this.gateOpen();
    this.refreshIndex();
    const ttl = this.opts.leaseTtlMs ?? 60_000;
    for (const id of [...this.records.keys()]) {
      let rec = this.records.get(id)!;
      if (rec.terminal) continue;
      if (!this.store.tryLease(id, this.ownerId, ttl, this.now())) continue;
      const latest = this.store.load(id); // another instance may have advanced it
      if (latest) {
        rec = TransferRecord.restore(latest);
        this.records.set(id, rec);
      }
      if (rec.terminal) {
        this.store.releaseLease(id, this.ownerId);
        continue;
      }
      // Keep the lease alive while a (possibly slow) step runs; losing it aborts before any send.
      this.current = { id, lost: false };
      const cur = this.current;
      const renew = this.opts.testHooks?.disableLeaseRenewal
        ? undefined
        : setInterval(() => {
            if (!this.store.tryLease(id, this.ownerId, ttl, this.now())) cur.lost = true;
          }, Math.max(5, Math.floor(ttl / 3)));
      let superseded = false;
      try {
        await this.step(rec);
      } catch (e) {
        if (e instanceof StaleRecordError || e instanceof LeaseLostError) {
          superseded = true;
          if (e instanceof LeaseLostError) this.stats.leaseLostBeforeSend++;
        } else {
          rec.payload.lastError = (e as Error).message.slice(0, 300);
          rec.attempts++;
          rec.dirty = true;
          if (rec.attempts >= (this.opts.maxAttempts ?? 10) && ['SOURCE_FINALIZED', 'PROOF_VERIFIED', 'DESTINATION_PENDING', 'PAUSED'].includes(rec.state)) {
            rec.move('RECOVERY_REQUIRED', this.now(), rec.payload.lastError);
          }
        }
      } finally {
        if (renew) clearInterval(renew);
        this.current = undefined;
      }
      if (!superseded) {
        this.alertIfNeeded(rec);
        try {
          this.persist(rec);
        } catch (e) {
          if (!(e instanceof StaleRecordError)) throw e;
          superseded = true;
        }
      }
      if (superseded) {
        this.stats.superseded++;
        // Another instance owns/advanced this record: drop our stale copy, never overwrite theirs.
        const s = this.store.load(id);
        if (s) this.records.set(id, TransferRecord.restore(s));
        continue;
      }
      if (rec.terminal) this.store.releaseLease(id, this.ownerId);
    }
  }

  /**
   * Proof that a transfer's source lock/burn NEVER happened (e.g. removed by a reorg) — as opposed to
   * "it happened and was later refunded", which also leaves initiated(id) == false.
   *
   * Required, on >= rejectQuorum endpoints from DISTINCT providers (identity read from each client's
   * own transport; unknown identity = no proof), ALL agreeing:
   *   - the event block is final on that endpoint;
   *   - source initiated(id) == false at that final block and at latest (no re-inclusion);
   *   - source processed(refundOf(m)) == false (it was NOT refunded: a refund leaves this set forever);
   * and on the destination: processed(id) == false (never executed or cancelled there).
   * Any single dissenting or unavailable endpoint blocks the rejection.
   */
  private async proveNotLocked(src: RelayerChain, dst: RelayerChain, p: TransferPayload): Promise<{ proven: boolean; why: string }> {
    const clients = [src.client, ...(src.proofClients ?? [])];
    const need = Math.max(2, src.rejectQuorum ?? 2);
    const endpoints = clients.map(endpointOf);
    if (!this.opts.rpcProviders?.length) return { proven: false, why: `no RPC provider registry configured; ${need} independent declared operators are required to prove a rejection` };
    const ind = await independentOperators(endpoints, this.opts.rpcProviders, this.opts.resolver);
    if (ind.independent < need) {
      const un = ind.uncounted.map((u) => `${u.endpoint ?? '?'}: ${u.why}`).join(', ');
      return { proven: false, why: `only ${ind.independent} independent source operator(s) (${clients.length} connections${ind.groups.some((g) => g.length > 1) ? `; merged by shared IPs: ${ind.groups.filter((g) => g.length > 1).map((g) => g.join('+')).join(' ')}` : ''}${un ? `; not counted: ${un}` : ''}); ${need} independent endpoints are required to prove a rejection` };
    }
    if (p.seenBlock === undefined) return { proven: false, why: 'block of the original event unknown' };
    const refundId = messageId(refundOf(p.message));
    for (const [i, c] of clients.entries()) {
      try {
        const fin = await finalizedBlockNumber(c, src.finality);
        if (fin < p.seenBlock) return { proven: false, why: `endpoint #${i}: block ${p.seenBlock} not final yet (final=${fin})` };
        const read = (fn: 'initiated' | 'processed', id: Hex, blockNumber?: bigint) =>
          c.readContract({ address: src.bridge, abi: this.abiOf(src), functionName: fn, args: [id], ...(blockNumber !== undefined ? { blockNumber } : {}) }) as Promise<boolean>;
        if (await read('initiated', p.messageId, fin)) return { proven: false, why: `endpoint #${i}: source contract shows the message as initiated at final block ${fin}` };
        if (await read('initiated', p.messageId)) return { proven: false, why: `endpoint #${i}: message initiated at latest block (re-included)` };
        if (await read('processed', refundId)) return { proven: false, why: `endpoint #${i}: the transfer was locked and later REFUNDED (refund processed on source)` };
      } catch (e) {
        return { proven: false, why: `endpoint #${i} unavailable: ${(e as Error).message.slice(0, 80)}` };
      }
    }
    try {
      if (await this.isProcessed(dst, p.messageId)) return { proven: false, why: 'destination already processed (executed or cancelled) this message' };
    } catch (e) {
      return { proven: false, why: `destination unavailable: ${(e as Error).message.slice(0, 80)}` };
    }
    return { proven: true, why: `never locked: initiated=false at a final block >= ${p.seenBlock} and at latest, not refunded, not processed on destination — ${ind.independent} independent operators` };
  }

  /** The relayer's own RPC connections per chain (for the operational health check). */
  /** The declared RPC provider registry this relayer uses for rejection proofs. */
  get rpcProviders(): RpcProvider[] {
    return this.opts.rpcProviders ?? [];
  }

  runtimeRpcConfig(): { chainId: bigint; rpcs: { endpoint: string | undefined; client: PublicClient }[]; rejectQuorum: number; finality: FinalityPolicy }[] {
    return [...this.chains.values()].map((c) => ({
      chainId: c.chainId,
      rpcs: [c.client, ...(c.proofClients ?? [])].map((client) => ({ endpoint: endpointOf(client), client })),
      rejectQuorum: Math.max(2, c.rejectQuorum ?? 2),
      finality: c.finality,
    }));
  }

  /** Signatures a recipient needs to call cancel() on the destination. */
  signaturesFor(id: string): Hex[] | undefined {
    return (this.store.load(id)?.payload ?? this.records.get(id)?.payload)?.signatures;
  }

  /**
   * Operator recovery for RECOVERY_REQUIRED transfers. It can only RE-DRIVE the normal flow
   * (all on-chain checks apply again); it can never move funds by itself. Refunds still require
   * an on-chain cancel by the recipient or governance.
   */
  recover(id: string, action: RecoveryAction, operator: string, reason: string): void {
    if (!this.opts.operators?.includes(operator)) throw new Error(`"${operator}" is not an authorised operator`);
    if (!reason.trim()) throw new Error('a reason is required for the audit trail');
    const s = this.store.load(id);
    if (!s) throw new Error('unknown transfer');
    const rec = TransferRecord.restore(s);
    if (rec.state !== 'RECOVERY_REQUIRED') throw new Error(`transfer is ${rec.state}, not RECOVERY_REQUIRED`);
    if (action === 'retry_execution') {
      if (!rec.payload.signatures?.length) throw new Error('no attestations yet; use re_attest');
      rec.move('PROOF_VERIFIED', this.now(), `operator ${operator}: retry_execution — ${reason}`);
    } else {
      rec.payload.signatures = undefined;
      rec.move('SOURCE_FINALIZED', this.now(), `operator ${operator}: re_attest — ${reason}`);
    }
    rec.attempts = 0;
    this.records.set(id, rec);
    this.persist(rec);
  }

  /** Non-terminal transfers that need attention (for dashboards). */
  pendingReport(): { id: string; state: TransferState; ageMs: number; lastError?: string; stuck: boolean }[] {
    const now = this.now();
    const stuckAfter = this.opts.stuckAfterMs ?? 30 * 60_000;
    return [...this.records.values()]
      .filter((r) => !r.terminal)
      .map((r) => ({
        id: r.id,
        state: r.state,
        ageMs: r.ageInState(now),
        lastError: r.payload.lastError,
        stuck: r.state === 'RECOVERY_REQUIRED' || r.state === 'EXPIRED' || r.ageInState(now) > stuckAfter,
      }))
      .sort((a, b) => b.ageMs - a.ageMs);
  }

  private alertIfNeeded(rec: TransferRecord<TransferPayload>): void {
    if (!this.opts.onAlert || rec.terminal) return;
    const key = `${rec.state}:${rec.history.length}`;
    if (rec.payload.alertedKey === key) return;
    const age = rec.ageInState(this.now());
    const reason = rec.history.at(-1)?.reason ?? rec.payload.lastError ?? '';
    let alert: RelayerAlert | undefined;
    if (rec.state === 'RECOVERY_REQUIRED') alert = { level: 'critical', id: rec.id, state: rec.state, reason, sinceMs: age };
    else if (rec.state === 'EXPIRED') alert = { level: 'warning', id: rec.id, state: rec.state, reason: `source not final within the processing window (still watched): ${reason}`, sinceMs: age };
    else if (age > (this.opts.stuckAfterMs ?? 30 * 60_000)) alert = { level: 'warning', id: rec.id, state: rec.state, reason: rec.payload.lastError ?? 'no progress', sinceMs: age };
    if (alert) {
      rec.payload.alertedKey = key;
      rec.dirty = true;
      this.opts.onAlert(alert);
    }
  }

  private async step(rec: TransferRecord<TransferPayload>): Promise<void> {
    const p = rec.payload;
    const m = p.message;
    const src = this.chains.get(m.sourceChainId);
    const dst = this.chains.get(m.destChainId);
    // Misconfiguration never strands funds by rejecting: retry and raise a stuck alert instead.
    if (!src || !dst) throw new Error(`chain ${!src ? m.sourceChainId : m.destChainId} is not configured in this relayer`);

    // Anyone (recipient or governance) may cancel on the destination before execution.
    if (CANCELLABLE.includes(rec.state) && (await this.isProcessed(dst, p.messageId))) {
      if (await this.isCancelled(dst, p.messageId)) rec.move('CANCELLED', this.now(), 'cancelled on destination; refunding sender');
      else rec.move('COMPLETED', this.now(), 'already processed on destination (idempotent)');
      return;
    }

    switch (rec.state) {
      case 'SOURCE_PENDING':
      case 'EXPIRED': {
        let receipt;
        try {
          receipt = await src.client.getTransactionReceipt({ hash: p.sourceTxHash });
          p.misses = 0;
        } catch (e) {
          // A missing receipt on ONE RPC proves nothing (lagging, inconsistent or lying endpoint).
          // Reject only with on-chain proof from independent RPCs; otherwise keep watching.
          if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
          p.misses = (p.misses ?? 0) + 1;
          rec.dirty = true;
          if (p.misses < REORG_MISSES) return;
          const proof = await this.proveNotLocked(src, dst, p);
          if (proof.proven) return rec.move('REJECTED', this.now(), `proven not locked (reorg): ${proof.why}`);
          p.lastError = `source receipt missing ${p.misses}x but the lock is not disproven: ${proof.why}; still watching`;
          if (!p.unprovenAlerted) {
            p.unprovenAlerted = true;
            this.opts.onAlert?.({ level: 'critical', id: rec.id, state: rec.state, reason: p.lastError, sinceMs: rec.ageInState(this.now()) });
          }
          return;
        }
        if (await isFinal(src.client, receipt.blockNumber, src.finality)) {
          rec.move('SOURCE_FINALIZED', this.now(), rec.state === 'EXPIRED' ? 'finalized after the processing window; resuming' : `final under ${src.finality.kind}`);
        } else if (rec.state === 'SOURCE_PENDING' && this.opts.expiryMs && this.now() - rec.history[0]!.at > this.opts.expiryMs) {
          rec.move('EXPIRED', this.now(), 'source not final within the processing window; still watching');
        }
        return;
      }
      case 'SOURCE_FINALIZED': {
        const results = await Promise.all(this.attesters.map((a) => a.attest(m, p.sourceTxHash)));
        const ok = results.filter((r) => r.ok).map((r) => (r as { signature: Hex }).signature);
        const { sigs, threshold } = await this.collectValidSignatures(dst, m, ok);
        if (sigs.length >= threshold) {
          p.signatures = sigs.slice(0, Math.max(threshold, 1));
          rec.move('PROOF_VERIFIED', this.now(), `${sigs.length} valid attestations, threshold ${threshold}`);
          return;
        }
        const reasons = results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason);
        if (reasons.length === this.attesters.length) {
          // Reject ONLY when every attester refuses for a "nothing locked" reason AND the source contract
          // itself confirms it on independent RPCs; anything else may hold funds.
          if (reasons.every((r) => PROVES_NOTHING_LOCKED.test(r))) {
            const proof = await this.proveNotLocked(src, dst, p);
            if (proof.proven) return rec.move('REJECTED', this.now(), `proven not locked: ${proof.why}; attesters: ${reasons.join('; ')}`);
            return rec.move('RECOVERY_REQUIRED', this.now(), `attesters refused (${reasons.join('; ')}) but the lock is not disproven: ${proof.why}`);
          }
          if (reasons.every((r) => PROVES_NOTHING_LOCKED.test(r) || NEEDS_OPERATOR.test(r))) {
            return rec.move('RECOVERY_REQUIRED', this.now(), `attesters refused: ${reasons.join('; ')}`);
          }
        }
        throw new Error(`insufficient attestations (${sigs.length}/${threshold}): ${reasons.join('; ')}`);
      }
      case 'PAUSED': {
        if (!(await this.destPaused(dst, m.sourceChainId))) rec.move('PROOF_VERIFIED', this.now(), 'destination unpaused');
        return;
      }
      case 'RECOVERY_REQUIRED':
        return; // operator: fix config then recover(), or recipient/governance cancel => automatic refund
      case 'PROOF_VERIFIED': {
        if (await this.destPaused(dst, m.sourceChainId)) return rec.move('PAUSED', this.now(), 'destination paused');
        const proof = dst.proofBuilder ? await dst.proofBuilder(m, p.signatures!) : p.signatures!;
        const call = { address: dst.bridge, abi: this.abiOf(dst), functionName: m.kind === KIND_LOCK_MINT ? 'execute' : 'release', args: [m, proof] } as const;
        try {
          await dst.client.simulateContract({ ...call, account: dst.wallet.account! });
        } catch (e) {
          const name = revertName(e) ?? 'unknown';
          if (name === 'MessageAlreadyProcessed') return; // next tick classifies executed vs cancelled
          if (PAUSE_ERRORS.includes(name)) return rec.move('PAUSED', this.now(), name);
          if (RETRY_LATER_ERRORS.includes(name)) throw new Error(`retry later: ${name}`);
          if (STALE_SIGNATURE_ERRORS.includes(name)) {
            p.signatures = undefined; // signer-set rotation: re-attest instead of giving up
            return rec.move('SOURCE_FINALIZED', this.now(), `signatures no longer valid (${name}); re-attesting`);
          }
          return rec.move('RECOVERY_REQUIRED', this.now(), `destination would revert: ${name}`);
        }
        if (!this.forwardAllowed) {
          p.lastError = 'forward submission held: readiness gate closed';
          rec.dirty = true;
          return;
        }
        await this.broadcast(dst, call, rec, 'destination');
        return;
      }
      case 'DESTINATION_PENDING': {
        const r = await this.finalReceipt(dst, p.destTxHash!, p.destRawTx, p.submittedAt);
        if (r === 'pending') return;
        if ('retry' in r) return rec.move('PROOF_VERIFIED', this.now(), `destination tx ${r.retry}; re-simulating`);
        // The final receipt itself is the evidence: do not depend on a possibly stale processed() read.
        const evName = m.kind === KIND_LOCK_MINT ? 'TransferCompleted' : 'TransferReleased';
        if (this.receiptHasEvent(r, dst, evName, 'messageId', p.messageId)) return rec.move('COMPLETED', this.now(), `${evName} in final receipt`);
        if (await this.isProcessed(dst, p.messageId)) return; // classified by the CANCELLABLE check next tick
        return rec.move('PROOF_VERIFIED', this.now(), 'final receipt has no execution event; re-simulating');
      }
      case 'CANCELLED':
        return this.stepRefund(rec, src, dst);
      default:
        return;
    }
  }

  /** CANCELLED -> REFUNDED: attest refundOf(original) and submit it on the ORIGINAL source chain. */
  private async stepRefund(rec: TransferRecord<TransferPayload>, src: RelayerChain, dst: RelayerChain): Promise<void> {
    const p = rec.payload;
    const m = p.message;
    const refund = refundOf(m);
    if (await this.isProcessed(src, messageId(refund))) {
      rec.move('REFUNDED', this.now(), `sender refunded on chain ${src.chainId}`);
      return;
    }
    if (p.refundTxHash) {
      const r = await this.finalReceipt(src, p.refundTxHash, p.refundRawTx, p.submittedAt);
      if (r === 'pending') return;
      if (!('retry' in r) && this.receiptHasEvent(r, src, 'TransferRefunded', 'originalId', p.messageId)) {
        return rec.move('REFUNDED', this.now(), 'TransferRefunded in final receipt');
      }
      p.refundTxHash = undefined; // dropped/reverted: retry below (on-chain checks prevent a double refund)
      p.refundRawTx = undefined;
      rec.dirty = true;
    }
    if (!p.cancelTxHash) {
      // Bounded search: a cancel cannot predate this transfer being seen (minus the reorg margin).
      const head = await dst.client.getBlockNumber({ cacheTime: 0 });
      const from = p.destSearchFrom ?? dst.startBlock ?? 0n;
      const step = this.opts.logChunk ?? 10_000n;
      for (let a = from; a <= head && !p.cancelTxHash; a += step) {
        const b = a + step - 1n < head ? a + step - 1n : head;
        const logs = await dst.client.getContractEvents({ address: dst.bridge, abi: this.abiOf(dst), eventName: 'MessageCancelled', args: { messageId: p.messageId }, fromBlock: a, toBlock: b });
        if (logs.length) {
          p.cancelTxHash = logs[0]!.transactionHash!;
          p.cancelBlock = logs[0]!.blockNumber!;
          rec.dirty = true;
        }
      }
      if (!p.cancelTxHash) throw new Error('cancel event not found yet');
    }
    if (!p.refundSignatures) {
      const results = await Promise.all(this.attesters.map((a) => a.attestRefund(m, p.cancelTxHash!)));
      const ok = results.filter((r) => r.ok).map((r) => (r as { signature: Hex }).signature);
      const { sigs, threshold } = await this.collectValidSignatures(src, refund, ok);
      if (sigs.length < threshold) {
        throw new Error(`insufficient refund attestations: ${results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason).join('; ')}`);
      }
      p.refundSignatures = sigs.slice(0, threshold);
      rec.dirty = true;
    }
    const refundProof = src.proofBuilder ? await src.proofBuilder(refund, p.refundSignatures) : p.refundSignatures;
    const call = { address: src.bridge, abi: this.abiOf(src), functionName: 'refund', args: [m, refundProof] } as const;
    try {
      await src.client.simulateContract({ ...call, account: src.wallet.account! });
    } catch (e) {
      const name = revertName(e) ?? 'unknown';
      if (STALE_SIGNATURE_ERRORS.includes(name)) {
        p.refundSignatures = undefined;
        rec.dirty = true;
        throw new Error(`refund signatures stale (${name}); re-attesting`);
      }
      throw new Error(`refund would revert: ${name}`); // e.g. RefundLimitExceeded: retried, never lost
    }
    await this.broadcast(src, call, rec, 'refund');
  }

  /**
   * Write-ahead broadcast: sign, persist {hash, raw tx, state}, then send. After a crash at any
   * point the persisted raw transaction is re-broadcast (same nonce, same hash) instead of a new one.
   */
  private async broadcast(
    c: RelayerChain,
    call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
    rec: TransferRecord<TransferPayload>,
    kind: 'destination' | 'refund',
  ): Promise<void> {
    const p = rec.payload;
    const account = c.wallet.account!;
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
    // A pre-signed transaction may be included later than it was estimated (after a crash, a drop,
    // or simply a few blocks later). Storage-write costs depend on state (e.g. the rate limiter's
    // timestamp), so an exact estimate can run out of gas. Always sign with headroom.
    const estimate = await c.client.estimateGas({ account, to: call.address, data });
    const gas = (estimate * GAS_BUFFER_PCT) / 100n + GAS_BUFFER_FIXED;
    const request = await c.wallet.prepareTransactionRequest({ account, to: call.address, data, gas, chain: c.wallet.chain ?? null } as never);
    const raw = (await c.wallet.signTransaction({ ...(request as object), account } as never)) as Hex;
    const hash = keccak256(raw);
    await this.opts.testHooks?.beforeBroadcast?.(kind);
    this.assertLeaseHeld(rec.id); // a slow step may have outlived the lease: never send without it
    p.submittedAt = this.now();
    if (kind === 'destination') {
      p.destTxHash = hash;
      p.destRawTx = raw;
      rec.move('DESTINATION_PENDING', this.now(), hash);
    } else {
      p.refundTxHash = hash;
      p.refundRawTx = raw;
      rec.dirty = true;
    }
    this.persist(rec); // durable BEFORE the transaction exists anywhere else; CAS => only one instance gets here
    this.opts.testHooks?.afterPersistBeforeBroadcast?.(kind);
    await this.sendRaw(c, raw);
  }

  private async sendRaw(c: RelayerChain, raw: Hex): Promise<void> {
    try {
      await c.wallet.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      if (/already known|already imported|nonce too low|known transaction/.test(msg)) return;
      throw e;
    }
  }

  /** 'pending' | { retry, why } | the final successful receipt. */
  private async finalReceipt(c: RelayerChain, hash: Hex, raw: Hex | undefined, submittedAt?: number): Promise<TransactionReceipt | 'pending' | { retry: string }> {
    let receipt;
    try {
      receipt = await c.client.getTransactionReceipt({ hash });
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
      if (this.now() - (submittedAt ?? 0) > (this.opts.destTimeoutMs ?? 600_000)) return { retry: 'not mined before timeout' };
      if (raw) await this.sendRaw(c, raw).catch(() => undefined); // re-broadcast after a crash or a drop
      return 'pending';
    }
    if (receipt.status !== 'success') return { retry: `reverted in block ${receipt.blockNumber}` };
    return (await isFinal(c.client, receipt.blockNumber, c.finality)) ? receipt : 'pending';
  }

  private receiptHasEvent(r: TransactionReceipt, c: RelayerChain, eventName: string, key: string, id: Hex): boolean {
    return parseEventLogs({ abi: this.abiOf(c), logs: r.logs, eventName } as never).some(
      (l) => getAddress((l as { address: string }).address) === getAddress(c.bridge) && ((l as { args: Record<string, unknown> }).args[key] as string)?.toLowerCase() === id.toLowerCase(),
    );
  }

  private async isProcessed(c: RelayerChain, id: Hex): Promise<boolean> {
    return (await c.client.readContract({ address: c.bridge, abi: this.abiOf(c), functionName: 'processed', args: [id] })) as boolean;
  }

  private async isCancelled(c: RelayerChain, id: Hex): Promise<boolean> {
    return (await c.client.readContract({ address: c.bridge, abi: this.abiOf(c), functionName: 'cancelled', args: [id] })) as boolean;
  }

  private async destPaused(c: RelayerChain, sourceChainId: bigint): Promise<boolean> {
    const [paused, route] = await Promise.all([
      c.client.readContract({ address: c.bridge, abi: this.abiOf(c), functionName: 'paused' }) as Promise<boolean>,
      c.client.readContract({ address: c.bridge, abi: this.abiOf(c), functionName: 'routePaused', args: [sourceChainId] }) as Promise<boolean>,
    ]);
    return paused || route;
  }

  /** Verify signatures locally against `c`'s verifier; return them sorted and de-duplicated. */
  private async collectValidSignatures(c: RelayerChain, m: BridgeMessage, sigs: Hex[]): Promise<{ sigs: Hex[]; threshold: number }> {
    const [digest, signersRaw, threshold] = await Promise.all([
      c.client.readContract({ address: c.verifier, abi: this.verifierAbi, functionName: 'digest', args: [m] }) as Promise<Hex>,
      c.client.readContract({ address: c.verifier, abi: this.verifierAbi, functionName: 'signers' }) as Promise<Address[]>,
      c.client.readContract({ address: c.verifier, abi: this.verifierAbi, functionName: 'threshold' }) as Promise<number>,
    ]);
    const signers = signersRaw.map((a) => getAddress(a));
    const valid = new Map<Address, Hex>();
    for (const s of sigs) {
      try {
        const who = getAddress(await recoverAddress({ hash: digest, signature: s }));
        if (signers.includes(who)) valid.set(who, s);
      } catch {
        /* drop malformed */
      }
    }
    return {
      sigs: [...valid.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(([, s]) => s),
      threshold: Number(threshold),
    };
  }
}
