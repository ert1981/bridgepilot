import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi, Address, Hex } from 'viem';

export interface BridgeMessage {
  version: number;
  kind: number; // 0 LOCK_MINT, 1 BURN_RELEASE, 2 REFUND
  sourceChainId: bigint;
  sourceContract: Address;
  destChainId: bigint;
  destContract: Address;
  nonce: bigint;
  canonicalToken: Address;
  sender: Address;
  recipient: Address;
  amount: bigint;
}

export const KIND_LOCK_MINT = 0;
export const KIND_BURN_RELEASE = 1;
export const KIND_REFUND = 2;

/** Mirror of BridgeTypes.refundOf: the 1:1 refund message for a cancelled original. */
export function refundOf(o: BridgeMessage): BridgeMessage {
  return {
    version: o.version,
    kind: KIND_REFUND,
    sourceChainId: o.destChainId,
    sourceContract: o.destContract,
    destChainId: o.sourceChainId,
    destContract: o.sourceContract,
    nonce: o.nonce,
    canonicalToken: o.canonicalToken,
    sender: o.sender,
    recipient: o.sender,
    amount: o.amount,
  };
}

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'message', type: 'BridgeMessage' },
    { name: 'signerSetVersion', type: 'uint64' },
  ],
  BridgeMessage: [
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
} as const;

export function attestationTypedData(m: BridgeMessage, verifier: Address, verifierChainId: bigint, signerSetVersion: bigint) {
  return {
    domain: { name: 'BridgePilot', version: '1', chainId: verifierChainId, verifyingContract: verifier },
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation' as const,
    message: { message: m, signerSetVersion },
  };
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'evm', 'out');

/** Loads a compiled Foundry artifact (run `forge build` in contracts/evm first). */
const FILE_OF: Record<string, string> = { MockToken: 'Tokens', FeeOnTransferToken: 'Tokens', MockProofVerifier: 'MockVerifiers', MutableLevelVerifier: 'MockVerifiers' };
/** OpenZeppelin artifacts live under their own file name too. */
const cache = new Map<string, Artifact>();

export function artifact(name: string): Artifact {
  const hit = cache.get(name);
  if (hit) return hit;
  const file = FILE_OF[name] ?? name;
  const json = JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const a = { abi: json.abi, bytecode: json.bytecode.object };
  cache.set(name, a);
  return a;
}

export const messageKey = (m: BridgeMessage) => `${m.sourceChainId}:${m.sourceContract.toLowerCase()}:${m.nonce}`;
