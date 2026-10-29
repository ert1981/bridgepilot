import { providerContext } from '../agents/discovery-agent.js';
import type { Services } from '../services.js';
import type { PreparedRecord, PreparedState } from '../storage/store.js';
import { ApiError } from '../utils/errors.js';
import { bps, parseUint } from '../utils/units.js';

const POLL_MIN_INTERVAL_MS = 5000;
const TERMINAL: PreparedState[] = ['DONE', 'FAILED', 'REFUNDED', 'PARTIAL'];

const GUIDANCE: Record<PreparedState, string> = {
  AWAITING_SIGNATURE: 'Not broadcast yet. If the quote expired, request a fresh quote before signing.',
  SUBMITTED: 'Transaction hash recorded; waiting for the provider to index it. Do not resend.',
  PENDING: 'Transfer in progress. Do not resend the transaction; check again later.',
  DONE: 'Transfer completed.',
  FAILED: 'Transfer failed. Check the provider refund status before retrying with a fresh quote; never resend the same transaction.',
  REFUNDED: 'Transfer was refunded on the source chain. Request a new quote if you still want to bridge.',
  PARTIAL: 'Transfer completed with a different token or partial amount. Review the destination receipt.',
  EXPIRED: 'Prepared transaction expired without a recorded broadcast. Request a fresh quote.',
  UNKNOWN: 'Status is unclear. Verify on a block explorer before taking any action; do not resend blindly.',
};

function view(r: PreparedRecord, svc: Services) {
  const overdue =
    r.state === 'PENDING' && r.estimatedTimeSeconds !== null && r.txHash !== undefined && r.lastCheckedAt !== undefined
      ? svc.now() - r.createdAt > Math.max(r.estimatedTimeSeconds * 3, 900) * 1000
      : false;
  return {
    prepared_id: r.id,
    request_id: r.requestId,
    provider: r.provider,
    state: r.state.toLowerCase(),
    source_tx_hash: r.txHash ?? null,
    destination_tx_hash: r.destinationTxHash ?? null,
    expected_output: r.expectedOutput,
    received_amount: r.receivedAmount ?? null,
    output_deviation_bps: r.outputDeviationBps ?? null,
    expires_at: new Date(r.expiresAt).toISOString(),
    last_checked_at: r.lastCheckedAt ? new Date(r.lastCheckedAt).toISOString() : null,
    delayed: overdue,
    guidance: overdue ? `${GUIDANCE.PENDING} The transfer is slower than expected; contact the provider (${r.provider}) with the source tx hash.` : GUIDANCE[r.state],
  };
}

/** Transaction Monitoring: tracks a prepared transfer after the user signs it. */
export async function getTransferStatus(id: string, txHash: string | undefined, svc: Services, ownerId: string) {
  let r = await svc.store.getPrepared(id);
  if (!r || (r.ownerId !== 'anonymous' && r.ownerId !== ownerId)) throw new ApiError(404, 'NOT_FOUND', 'Unknown prepared_id.');

  if (txHash) {
    if (r.txHash && r.txHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new ApiError(409, 'TX_HASH_CONFLICT', 'A different tx_hash is already recorded for this transfer.');
    }
    if (!r.txHash) r = (await svc.store.updatePrepared(id, { txHash, state: 'SUBMITTED' }))!;
  }

  if (!r.txHash) {
    if (svc.now() > r.expiresAt && r.state === 'AWAITING_SIGNATURE') r = (await svc.store.updatePrepared(id, { state: 'EXPIRED' }))!;
    return view(r, svc);
  }
  if (TERMINAL.includes(r.state)) return view(r, svc);
  if (r.lastCheckedAt && svc.now() - r.lastCheckedAt < POLL_MIN_INTERVAL_MS) return view(r, svc);

  const provider = svc.registry.get(r.provider);
  if (!provider?.status) return view(r, svc);
  let st;
  try {
    st = await provider.status({ txHash: r.txHash, sourceChainId: r.sourceChainId, destinationChainId: r.destinationChainId, tool: r.tool }, providerContext(svc));
  } catch {
    // Provider unreachable: keep the last known state, never assume failure.
    r = (await svc.store.updatePrepared(id, { lastCheckedAt: svc.now() }))!;
    return { ...view(r, svc), provider_unreachable: true };
  }

  const map: Record<string, PreparedState> = {
    PENDING: 'PENDING',
    DONE: 'DONE',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
    PARTIAL: 'PARTIAL',
    NOT_FOUND: 'SUBMITTED',
    UNKNOWN: 'UNKNOWN',
  };
  const patch: Partial<PreparedRecord> = { state: map[st.state] ?? 'UNKNOWN', lastCheckedAt: svc.now() };
  if (st.destinationTxHash) patch.destinationTxHash = st.destinationTxHash;
  if (st.receivedAmount !== undefined) {
    patch.receivedAmount = st.receivedAmount.toString();
    const expected = parseUint(r.expectedOutput);
    if (expected) {
      const dev = bps(expected - st.receivedAmount, expected);
      if (dev !== null) patch.outputDeviationBps = Number(dev);
    }
  }
  r = (await svc.store.updatePrepared(id, patch))!;
  if (TERMINAL.includes(r.state)) {
    svc.metrics.inc('bridgepilot_transfers_terminal_total', { provider: r.provider, state: r.state });
    svc.audit.record('transfer_terminal', { preparedId: id, provider: r.provider, state: r.state, deviationBps: r.outputDeviationBps ?? null });
  }
  return view(r, svc);
}
