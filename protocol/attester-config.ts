import type { PublicClient } from 'viem';
import type { FinalityPolicy } from './finality.js';
import { independentOperators, originOf, validateRegistry, type Resolver, type RpcProvider } from './rpc-providers.js';

/**
 * Operational independence checks for the signer set. Threshold signing is only as strong as the
 * independence of the signers: shared operators, shared RPC providers or shared key custody
 * collapse "2-of-3" into "1-of-1". Run this against the real attester deployment config.
 */
export interface AttesterDeployment {
  name: string;
  /** Signing address: binds this declaration to the running Attester instance. */
  address?: string;
  operator: string; // legal entity / team running it
  keyCustody: 'hsm' | 'kms' | 'file';
  rpcUrls: Record<string, string[]>; // chainId -> endpoints used by this attester
}

export interface Finding {
  severity: 'error' | 'warning';
  message: string;
}


/** Static operator of a URL in the registry (exact origin match), or undefined if not declared exactly once. */
function operatorOf(url: string, registry: RpcProvider[]): string | undefined {
  const o = originOf(url);
  const ps = o ? registry.filter((p) => p.origins.some((x) => originOf(x) === o)) : [];
  return ps.length === 1 ? ps[0]!.operator.trim().toLowerCase() : undefined;
}

/**
 * Static independence of the declared attester deployment. RPC independence is counted per
 * declared OPERATOR from the RPC provider registry (never per domain); an endpoint that is not in
 * the registry is an error. (IP overlap is checked at runtime, where DNS is resolved.)
 */
export function checkAttesterIndependence(attesters: AttesterDeployment[], threshold: number, minRpcQuorum = 2, registry?: RpcProvider[]): Finding[] {
  const f: Finding[] = [];
  const operators = new Set(attesters.map((a) => a.operator.trim().toLowerCase()));
  if (operators.size < threshold) f.push({ severity: 'error', message: `only ${operators.size} distinct operator(s) for a threshold of ${threshold}: one party could reach the threshold alone` });
  if (operators.size < attesters.length) f.push({ severity: 'warning', message: 'some attesters share an operator' });
  if (!registry?.length) {
    f.push({ severity: 'error', message: 'RPC provider registry (rpcProviders) missing: attester RPC independence cannot be established' });
  } else {
    for (const e of validateRegistry(registry)) f.push({ severity: 'error', message: `RPC provider registry: ${e}` });
  }
  const reg = registry ?? [];
  for (const a of attesters) {
    if (a.keyCustody === 'file') f.push({ severity: 'error', message: `${a.name}: signing key stored in a file; use an HSM or KMS` });
    for (const [chain, urls] of Object.entries(a.rpcUrls)) {
      const undeclared = urls.filter((u) => !operatorOf(u, reg));
      if (undeclared.length) f.push({ severity: 'error', message: `${a.name}: chain ${chain}: RPC endpoint(s) not in the provider registry: ${undeclared.join(', ')}` });
      const ops = new Set(urls.map((u) => operatorOf(u, reg)).filter(Boolean));
      if (ops.size < minRpcQuorum) f.push({ severity: 'error', message: `${a.name}: chain ${chain} has ${ops.size} independent RPC operator(s); need ${minRpcQuorum}` });
    }
  }
  // The same RPC operator used by >= threshold attesters on a chain is a shared point of failure.
  const chains = new Set(attesters.flatMap((a) => Object.keys(a.rpcUrls)));
  for (const chain of chains) {
    const count = new Map<string, number>();
    for (const a of attesters) for (const op of new Set((a.rpcUrls[chain] ?? []).map((u) => operatorOf(u, reg)).filter(Boolean) as string[])) count.set(op, (count.get(op) ?? 0) + 1);
    for (const [op, n] of count) {
      if (n >= threshold) f.push({ severity: 'warning', message: `chain ${chain}: RPC operator ${op} is used by ${n} attesters (>= threshold); a single operator outage or lie affects the quorum` });
    }
  }
  return f;
}

/**
 * Sanity-probe an RPC endpoint before trusting its finality signal: the `finalized` tag must exist,
 * be at or below `latest`, and not lag absurdly (a stuck finalized block means a broken node).
 */
export async function probeFinalityRpc(client: PublicClient, policy: FinalityPolicy, maxLagBlocks: bigint): Promise<Finding[]> {
  if (policy.kind !== 'finalized-tag') return [];
  const f: Finding[] = [];
  try {
    const [latest, finalized] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockTag: 'finalized' })]);
    if (finalized.number === null) f.push({ severity: 'error', message: 'endpoint does not report a finalized block' });
    else if (finalized.number > latest) f.push({ severity: 'error', message: 'finalized block is ahead of latest: inconsistent endpoint' });
    else if (latest - finalized.number > maxLagBlocks) f.push({ severity: 'error', message: `finalized lags latest by ${latest - finalized.number} blocks (> ${maxLagBlocks}): stalled or misconfigured node` });
  } catch (e) {
    f.push({ severity: 'error', message: `endpoint does not support the finalized tag: ${(e as Error).message.slice(0, 80)}` });
  }
  return f;
}

export interface RuntimeRpc {
  /** Taken from the client's own transport (see attester.endpointOf); undefined = identity unknown. */
  endpoint: string | undefined;
  client: PublicClient;
}

export interface RuntimeAttester {
  address: string;
  /** The registry the running attester counts its own quorum with. */
  rpcProviders?: RpcProvider[];
  runtimeConfig(): { chainId: bigint; rpcs: RuntimeRpc[]; quorum: number; finality: FinalityPolicy }[];
}

export interface RuntimeFinding {
  attester: string;
  chainId?: string;
  ok: boolean;
  message: string;
}

/** The signer set actually installed in each chain's MessageVerifier. */
export type OnchainSignerSets = Map<bigint, { signers: string[]; threshold: number }>;

const norm = (a: string) => a.toLowerCase();
const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a.map(norm));
  const y = new Set(b.map(norm));
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** Probe a list of (endpoint, client) pairs: identity known, distinct providers, sane finality. */
async function checkRpcs(rpcs: RuntimeRpc[], quorum: number, finality: FinalityPolicy, maxLag: bigint, label: string, registry: RpcProvider[] | undefined, resolve?: Resolver): Promise<{ ok: boolean; message: string }[]> {
  const out: { ok: boolean; message: string }[] = [];
  const unknown = rpcs.filter((r) => !r.endpoint).length;
  out.push({ ok: unknown === 0, message: `${label}: every connection has a known endpoint identity${unknown ? ` (${unknown} unknown)` : ''}` });
  // Independence = declared OPERATORS in the registry (exact origin); unregistered endpoints never
  // count; operators whose endpoints resolve to a common IP address are merged.
  const reg = registry ?? [];
  const ind = await independentOperators(rpcs.map((r) => r.endpoint), reg, resolve);
  const merged = ind.groups.filter((g) => g.length > 1).map((g) => g.join('+'));
  out.push({
    ok: rpcs.length >= quorum && ind.independent >= quorum,
    message: `${label}: enough connections from distinct providers for the quorum (${ind.independent} independent, ${rpcs.length} connections, quorum ${quorum}${merged.length ? `; merged by shared IPs: ${merged.join(' ')}` : ''}${ind.uncounted.length ? `; not counted: ${ind.uncounted.map((u) => `${u.endpoint ?? '?'} (${u.why})`).join(', ')}` : ''})`,
  });
  for (const [i, r] of rpcs.entries()) {
    const f = await probeFinalityRpc(r.client, finality, maxLag);
    out.push({ ok: f.length === 0, message: `${label}: endpoint #${i} (${r.endpoint ?? 'unknown'}) finality signal sane${f.length ? `: ${f.map((x) => x.message).join('; ')}` : ''}` });
  }
  return out;
}

/**
 * Checks the RUNNING attesters, not just the declared config:
 *  - the running set is EXACTLY the signer set installed on every chain (no missing, extra or
 *    duplicate attester) and is at least the threshold;
 *  - the declared attesters are exactly that signer set too;
 *  - every required chain is configured, with an operational quorum >= minQuorum;
 *  - each quorum member is a (endpoint, client) pair: the endpoint is the client's own transport,
 *    it is from a declared provider, providers are distinct, and THAT connection's finality is sane.
 */
export async function checkAttesterRuntime(
  attesters: RuntimeAttester[],
  declared: AttesterDeployment[],
  requiredChains: bigint[],
  opts: { minQuorum?: number; maxFinalizedLagBlocks?: bigint; onchain?: OnchainSignerSets; resolver?: Resolver; rpcProviders?: RpcProvider[] } = {},
): Promise<RuntimeFinding[]> {
  const minQ = opts.minQuorum ?? 2;
  const maxLag = opts.maxFinalizedLagBlocks ?? 2_000n;
  const out: RuntimeFinding[] = [];
  const registry = opts.rpcProviders ?? [];
  out.push({ attester: '-', ok: registry.length > 0, message: 'RPC provider registry supplied for attester RPC independence' });
  if (attesters.length === 0) out.push({ attester: '-', ok: false, message: 'no running attesters supplied to the gate' });
  const running = attesters.map((a) => a.address);
  out.push({ attester: '-', ok: new Set(running.map(norm)).size === running.length, message: 'no duplicate running attester' });
  const declaredAddrs = declared.map((d) => d.address ?? '');
  out.push({ attester: '-', ok: declaredAddrs.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), message: 'every declared attester has a signing address' });
  if (opts.onchain) {
    for (const chainId of requiredChains) {
      const set = opts.onchain.get(chainId);
      const cid = chainId.toString();
      if (!set) {
        out.push({ attester: '-', chainId: cid, ok: false, message: 'on-chain signer set read for this chain' });
        continue;
      }
      out.push({ attester: '-', chainId: cid, ok: sameSet(running, set.signers), message: `running attesters == on-chain signer set (running ${running.length}, on-chain ${set.signers.length})` });
      out.push({ attester: '-', chainId: cid, ok: sameSet(declaredAddrs, set.signers), message: 'declared attesters == on-chain signer set' });
      out.push({ attester: '-', chainId: cid, ok: new Set(running.map(norm)).size >= set.threshold && set.threshold > 0, message: `running attesters >= threshold ${set.threshold}` });
      for (const a of running) {
        if (!set.signers.some((x) => norm(x) === norm(a))) out.push({ attester: a, chainId: cid, ok: false, message: 'running attester is a current on-chain signer' });
      }
    }
  } else {
    out.push({ attester: '-', ok: false, message: 'on-chain signer sets supplied to the runtime check' });
  }
  for (const a of attesters) {
    const who = a.address;
    const decl = declared.find((d) => d.address && norm(d.address) === norm(who));
    out.push({ attester: who, ok: !!decl, message: 'running attester is declared in the deployment config (address bound)' });
    const rc = a.runtimeConfig();
    // The running attester must count its quorum with a registry that agrees with the deployment's.
    const own = a.rpcProviders ?? [];
    out.push({ attester: who, ok: own.length > 0, message: 'running attester counts its RPC quorum with a provider registry' });
    const disagree = rc.flatMap((c) => c.rpcs.map((r) => r.endpoint)).filter((e): e is string => !!e && operatorOf(e, own) !== operatorOf(e, registry));
    out.push({ attester: who, ok: disagree.length === 0, message: `running attester's registry agrees with the deployment registry${disagree.length ? ` (differs for ${[...new Set(disagree)].join(', ')})` : ''}` });
    for (const chainId of requiredChains) {
      const c = rc.find((x) => x.chainId === chainId);
      const cid = chainId.toString();
      if (!c) {
        out.push({ attester: who, chainId: cid, ok: false, message: 'required chain configured in the running attester' });
        continue;
      }
      out.push({ attester: who, chainId: cid, ok: c.quorum >= minQ, message: `operational quorum >= ${minQ} (is ${c.quorum})` });
      if (decl) {
        const allowed = new Set((decl.rpcUrls[cid] ?? []).map(originOf).filter(Boolean));
        const undeclared = c.rpcs.filter((r) => !r.endpoint || !allowed.has(originOf(r.endpoint))).map((r) => r.endpoint ?? 'unknown');
        out.push({ attester: who, chainId: cid, ok: undeclared.length === 0, message: `runtime endpoints match the declared providers${undeclared.length ? ` (undeclared: ${undeclared.join(', ')})` : ''}` });
      }
      for (const f of await checkRpcs(c.rpcs, c.quorum, c.finality, maxLag, 'attester', registry, opts.resolver)) out.push({ attester: who, chainId: cid, ...f });
    }
  }
  return out;
}

/**
 * Operational health of the RELAYER's own RPCs: the source receipts and the "nothing locked" proof
 * come from them. Fewer than 2 independent providers means a transfer can never be rejected
 * automatically (fail-safe: it stays watched), so this is reported as operational health.
 */
export async function checkRelayerRpcs(
  chains: { chainId: bigint; rpcs: RuntimeRpc[]; rejectQuorum: number; finality: FinalityPolicy }[],
  opts: { maxFinalizedLagBlocks?: bigint; rpcProviders?: RpcProvider[]; resolver?: Resolver } = {},
): Promise<RuntimeFinding[]> {
  const out: RuntimeFinding[] = [];
  out.push({ attester: 'relayer', ok: !!opts.rpcProviders?.length, message: 'relayer: RPC provider registry configured (required for automatic rejections)' });
  for (const c of chains) {
    for (const f of await checkRpcs(c.rpcs, Math.max(2, c.rejectQuorum), c.finality, opts.maxFinalizedLagBlocks ?? 2_000n, 'relayer', opts.rpcProviders ?? [], opts.resolver)) {
      out.push({ attester: 'relayer', chainId: c.chainId.toString(), ...f });
    }
  }
  return out;
}
