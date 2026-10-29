import { independentOperators, validateRegistry, type Resolver, type RpcProvider } from './rpc-providers.js';
import { getAddress, parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { isFinal, protocolChain, type FinalityPolicy } from './finality.js';
import { artifact, attestationTypedData, refundOf, type BridgeMessage } from './types.js';

export interface AttestRoute {
  destChainId: bigint;
  destContract: Address;
}

export type AttestResult = { ok: true; signer: Address; signature: Hex } | { ok: false; signer: Address; reason: string };

export interface RuntimeChainConfig {
  chainId: bigint;
  rpcs: { endpoint: string | undefined; client: PublicClient }[];
  quorum: number;
  finality: FinalityPolicy;
}

/** The URL a viem client really talks to (http/webSocket transports); undefined if not knowable. */
export function endpointOf(client: PublicClient): string | undefined {
  const t = client.transport as { url?: unknown; type?: string };
  return typeof t?.url === 'string' && t.url.length > 0 ? t.url : undefined;
}

export interface ChainView {
  chainId: bigint;
  /** The attester's OWN RPC (never the relayer's). */
  client: PublicClient;
  finality: FinalityPolicy;
  /** Additional independent RPC endpoints (different providers). */
  extraClients?: PublicClient[];
  /** How many endpoints (incl. `client`) must each see the same final, canonical receipt. Default 1. */
  quorum?: number;
}

/**
 * An attester independently re-reads chains from its OWN RPC and only signs if:
 *  - the chain is in the protocol registry as supported, with an explicit finality policy,
 *  - the transaction receipt succeeded, is on the canonical chain and is FINAL under that policy,
 *  - it contains exactly this event, emitted by an allowed bridge contract,
 *  - the route (source contract -> destination contract) is allowed.
 * It never trusts the relayer's copy of the message.
 */
export class Attester {
  private readonly account: PrivateKeyAccount;
  private readonly abi = [...artifact('BridgeVault').abi, ...artifact('BridgeExecutor').abi];

  constructor(
    privateKey: Hex,
    private readonly chains: Map<bigint, ChainView>,
    /** sourceChainId -> allowed source contract (lower-case) -> allowed destinations */
    private readonly routes: Map<bigint, Map<string, AttestRoute[]>>,
    /** chainId -> MessageVerifier on that chain (the EIP-712 verifying contract) */
    private readonly verifiers: Map<bigint, Address>,
    /**
     * Declared RPC provider registry. With quorum > 1 it is REQUIRED: agreement is counted per
     * independent declared OPERATOR (exact origin match, operators sharing an IP merged), never per
     * connection or domain. Unregistered endpoints never count.
     */
    private readonly opts: { rpcProviders?: RpcProvider[]; resolver?: Resolver } = {},
  ) {
    this.account = privateKeyToAccount(privateKey);
    const errors = validateRegistry(opts.rpcProviders ?? []);
    if (errors.length) throw new Error(`invalid RPC provider registry: ${errors.join('; ')}`);
  }

  /** The registry this attester counts its quorum with (checked by the readiness gate). */
  get rpcProviders(): RpcProvider[] {
    return this.opts.rpcProviders ?? [];
  }

  get address(): Address {
    return this.account.address;
  }

  /**
   * What this attester ACTUALLY uses at runtime (checked by the readiness gate). Each entry binds an
   * endpoint identity to the very client used for reads: the endpoint is taken from that client's own
   * transport, never from a separate list, so the gate probes exactly the connections in use.
   */
  runtimeConfig(): RuntimeChainConfig[] {
    return [...this.chains.values()].map((c) => ({
      chainId: c.chainId,
      rpcs: [c.client, ...(c.extraClients ?? [])].map((client) => ({ endpoint: endpointOf(client), client })),
      quorum: c.quorum ?? 1,
      finality: c.finality,
    }));
  }

  /** Attest a LOCK_MINT or BURN_RELEASE emitted in `sourceTxHash`. */
  async attest(claimed: BridgeMessage, sourceTxHash: Hex): Promise<AttestResult> {
    const fail = (reason: string): AttestResult => ({ ok: false, signer: this.address, reason });
    if (!this.routeAllowed(claimed)) return fail('route not allowed');
    const evidence = await this.findFinalEvent(claimed.sourceChainId, sourceTxHash, claimed.sourceContract, 'TransferInitiated', claimed);
    if (typeof evidence === 'string') return fail(evidence);
    return this.sign(evidence, claimed.destChainId);
  }

  /**
   * Attest the REFUND of `original` after it was cancelled on its destination. Signs refundOf(original)
   * for the verifier on the ORIGINAL SOURCE chain, only after a final MessageCancelled event for exactly
   * this message, emitted by the original destination contract.
   */
  async attestRefund(original: BridgeMessage, cancelTxHash: Hex): Promise<AttestResult> {
    const fail = (reason: string): AttestResult => ({ ok: false, signer: this.address, reason });
    if (!this.routeAllowed(original)) return fail('route not allowed');
    const evidence = await this.findFinalEvent(original.destChainId, cancelTxHash, original.destContract, 'MessageCancelled', original);
    if (typeof evidence === 'string') return fail(evidence);
    return this.sign(refundOf(evidence), original.sourceChainId);
  }

  private routeAllowed(m: BridgeMessage): boolean {
    const allowed = this.routes.get(m.sourceChainId)?.get(m.sourceContract.toLowerCase());
    return !!allowed?.some((r) => r.destChainId === m.destChainId && r.destContract.toLowerCase() === m.destContract.toLowerCase());
  }

  private async findFinalEvent(
    chainId: bigint,
    txHash: Hex,
    emitter: Address,
    eventName: 'TransferInitiated' | 'MessageCancelled',
    claimed: BridgeMessage,
  ): Promise<BridgeMessage | string> {
    const chain = this.chains.get(chainId);
    const reg = protocolChain(chainId);
    if (!chain || !reg || reg.status !== 'supported') return `chain ${chainId} is not supported by the protocol`;

    let receipt;
    try {
      receipt = await chain.client.getTransactionReceipt({ hash: txHash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return 'transaction not found (pending, dropped or reorged)';
      return `rpc error: ${(e as Error).message.slice(0, 80)}`;
    }
    if (receipt.status !== 'success') return 'transaction reverted';
    if (!(await isFinal(chain.client, receipt.blockNumber, chain.finality))) return 'not final yet';
    const block = await chain.client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return 'receipt not on canonical chain';

    // Independent confirmation: a single lying or lagging RPC cannot make us sign.
    const quorum = chain.quorum ?? 1;
    if (quorum > 1) {
      if (!this.opts.rpcProviders?.length) return `rpc quorum ${quorum} requires a declared RPC provider registry; refusing to count connections as independent`;
      const extras = chain.extraClients ?? [];
      const others = await Promise.all(
        extras.map(async (c) => {
          try {
            const r = await c.getTransactionReceipt({ hash: txHash });
            if (r.status !== 'success' || r.blockHash !== receipt.blockHash) return false;
            if (!(await isFinal(c, r.blockNumber, chain.finality))) return false;
            const b = await c.getBlock({ blockNumber: r.blockNumber });
            return b.hash === r.blockHash;
          } catch {
            return false;
          }
        }),
      );
      const agreeing = [chain.client, ...extras.filter((_, i) => others[i])].map(endpointOf);
      const ind = await independentOperators(agreeing, this.opts.rpcProviders, this.opts.resolver);
      if (ind.independent < quorum) {
        return `rpc quorum not met (${ind.independent}/${quorum} independent operators confirm a final receipt; ${agreeing.length} connections agree${ind.uncounted.length ? `; not counted: ${ind.uncounted.map((u) => `${u.endpoint ?? '?'} (${u.why})`).join(', ')}` : ''})`;
      }
    }

    const found = parseEventLogs({ abi: this.abi, logs: receipt.logs, eventName })
      .filter((l) => getAddress(l.address) === getAddress(emitter))
      .map((e) => (e.args as unknown as { message: BridgeMessage }).message)
      .find((m) => m.nonce === claimed.nonce && m.sourceChainId === claimed.sourceChainId);
    if (!found) return 'event not found in receipt';
    if (!sameMessage(found, claimed)) return 'claimed message differs from on-chain event';
    return found;
  }

  private async sign(m: BridgeMessage, verifierChainId: bigint): Promise<AttestResult> {
    const verifier = this.verifiers.get(verifierChainId);
    const chain = this.chains.get(verifierChainId);
    if (!verifier || !chain) return { ok: false, signer: this.address, reason: 'no verifier configured for target chain' };
    const version = (await chain.client.readContract({ address: verifier, abi: artifact('MessageVerifier').abi, functionName: 'signerSetVersion' })) as bigint;
    const signature = await this.account.signTypedData(attestationTypedData(m, verifier, verifierChainId, version));
    return { ok: true, signer: this.address, signature };
  }
}

export function sameMessage(a: BridgeMessage, b: BridgeMessage): boolean {
  return (
    Number(a.version) === Number(b.version) &&
    Number(a.kind) === Number(b.kind) &&
    a.sourceChainId === b.sourceChainId &&
    a.destChainId === b.destChainId &&
    a.nonce === b.nonce &&
    a.amount === b.amount &&
    getAddress(a.sourceContract) === getAddress(b.sourceContract) &&
    getAddress(a.destContract) === getAddress(b.destContract) &&
    getAddress(a.canonicalToken) === getAddress(b.canonicalToken) &&
    getAddress(a.sender) === getAddress(b.sender) &&
    getAddress(a.recipient) === getAddress(b.recipient)
  );
}
