import type { PublicClient } from 'viem';

/**
 * Finality is defined PER CHAIN, never as one global block depth.
 *
 * - `finalized-tag`: the block must be at or below the RPC's `finalized` block. On Ethereum
 *   this is Casper FFG finality; on OP-stack and Arbitrum nodes the `finalized` tag means the L2
 *   block is derived from a FINALIZED L1 batch — i.e. economic finality on the base layer, not
 *   just local L2 depth.
 * - `depth`: N blocks deep. Only acceptable for local development chains.
 *
 * A chain without an explicit, tested policy is unsupported: attesters refuse to sign for it.
 */
export type FinalityPolicy = { kind: 'finalized-tag' } | { kind: 'depth'; confirmations: bigint };

export type ChainFamily = 'evm' | 'solana' | 'utxo' | 'other';

export interface ProtocolChainInfo {
  chainId: bigint;
  name: string;
  family: ChainFamily;
  /** `supported` only when verifier, finality and recovery are implemented and tested. */
  status: 'supported' | 'unsupported';
  finality?: FinalityPolicy;
  reason?: string;
}

/** Registry of chains the PROTOCOL (not the routing API) can operate on. */
export const PROTOCOL_CHAINS: ProtocolChainInfo[] = [
  { chainId: 11155111n, name: 'Sepolia', family: 'evm', status: 'supported', finality: { kind: 'finalized-tag' } },
  { chainId: 84532n, name: 'Base Sepolia', family: 'evm', status: 'supported', finality: { kind: 'finalized-tag' } },
  { chainId: 421614n, name: 'Arbitrum Sepolia', family: 'evm', status: 'supported', finality: { kind: 'finalized-tag' } },
  { chainId: 11155420n, name: 'OP Sepolia', family: 'evm', status: 'supported', finality: { kind: 'finalized-tag' } },
  { chainId: 31337n, name: 'Local anvil A', family: 'evm', status: 'supported', finality: { kind: 'depth', confirmations: 3n } },
  { chainId: 31338n, name: 'Local anvil B', family: 'evm', status: 'supported', finality: { kind: 'depth', confirmations: 3n } },
  {
    chainId: 0n,
    name: 'Solana (any cluster)',
    family: 'solana',
    status: 'unsupported',
    reason: 'Needs its own program, account model, proof of transaction, finality (slot commitment) and recovery design.',
  },
];

export function protocolChain(chainId: bigint): ProtocolChainInfo | undefined {
  return PROTOCOL_CHAINS.find((c) => c.chainId === chainId && c.family === 'evm');
}

/** Highest block that is final under `policy` on this endpoint. Errors propagate. */
export async function finalizedBlockNumber(client: PublicClient, policy: FinalityPolicy): Promise<bigint> {
  if (policy.kind === 'depth') {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    return head >= policy.confirmations ? head - policy.confirmations : 0n;
  }
  const finalized = await client.getBlock({ blockTag: 'finalized' });
  if (finalized.number === null) throw new Error('endpoint reports no finalized block');
  return finalized.number;
}

/** Returns true only when `blockNumber` is final under `policy`. Errors propagate (retry later). */
export async function isFinal(client: PublicClient, blockNumber: bigint, policy: FinalityPolicy): Promise<boolean> {
  if (policy.kind === 'depth') {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    return head >= blockNumber + policy.confirmations;
  }
  const finalized = await client.getBlock({ blockTag: 'finalized' });
  return finalized.number !== null && finalized.number >= blockNumber;
}
