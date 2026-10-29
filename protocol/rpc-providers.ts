import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Explicit RPC provider registry (operational configuration).
 *
 * Provider independence cannot be derived from a URL: one operator can serve many domains, and two
 * names (`localhost`, `127.0.0.1`) can reach the same node. So identity is DECLARED here, per
 * provider, with the exact origins (scheme://host:port) it serves, and enforced as follows:
 *   - a connection counts only if its exact origin is declared under exactly one provider;
 *     unknown or ambiguous connections are never counted towards a quorum;
 *   - independence is counted per declared OPERATOR (not per provider id or domain);
 *   - providers whose endpoints resolve to ANY common IP address are merged into one
 *     (they demonstrably share infrastructure), whatever their declaration says.
 * What software cannot prove — that two declared operators are really independent companies with
 * separate infrastructure behind distinct IPs — remains an operational fact to audit.
 */
export interface RpcProvider {
  id: string;
  /** Legal entity operating the infrastructure. Independence is counted per operator. */
  operator: string;
  /** Exact origins served by this provider, e.g. "https://eth-sepolia.example-rpc.com". */
  origins: string[];
}

export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Static registry validation: unique ids, non-empty operator, an origin under at most one provider. */
export function validateRegistry(reg: RpcProvider[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const p of reg) {
    if (!p.id.trim()) errors.push('provider with empty id');
    if (ids.has(p.id)) errors.push(`duplicate provider id ${p.id}`);
    ids.add(p.id);
    if (!p.operator.trim()) errors.push(`provider ${p.id}: operator missing`);
    for (const o of p.origins) {
      const n = originOf(o);
      if (!n) errors.push(`provider ${p.id}: invalid origin ${o}`);
      else if (owner.has(n) && owner.get(n) !== p.id) errors.push(`origin ${n} declared under both ${owner.get(n)} and ${p.id}`);
      else owner.set(n, p.id);
    }
  }
  return errors;
}

export type Resolver = (hostname: string) => Promise<string[]>;
export const dnsResolver: Resolver = async (h) => (isIP(h) ? [h] : (await lookup(h, { all: true })).map((a) => a.address));

export interface IndependenceResult {
  /** Number of independent operator groups among the counted connections. */
  independent: number;
  counted: number;
  uncounted: { endpoint: string | undefined; why: string }[];
  groups: string[][];
}

/**
 * How many INDEPENDENT operators the given endpoints represent, per the registry and DNS.
 * Endpoints that are unknown, ambiguous or unresolvable are listed in `uncounted`.
 */
export async function independentOperators(endpoints: (string | undefined)[], reg: RpcProvider[], resolve: Resolver = dnsResolver): Promise<IndependenceResult> {
  const uncounted: IndependenceResult['uncounted'] = [];
  const byOrigin = new Map<string, RpcProvider[]>();
  for (const p of reg) for (const o of p.origins) {
    const n = originOf(o);
    if (n) byOrigin.set(n, [...(byOrigin.get(n) ?? []), p]);
  }
  // operator -> IPs
  const ips = new Map<string, Set<string>>();
  let counted = 0;
  for (const e of endpoints) {
    const origin = e ? originOf(e) : undefined;
    if (!e || !origin) {
      uncounted.push({ endpoint: e, why: 'no knowable endpoint identity' });
      continue;
    }
    const ps = byOrigin.get(origin) ?? [];
    if (ps.length !== 1) {
      uncounted.push({ endpoint: e, why: ps.length ? 'origin declared under several providers' : 'origin not declared in the RPC provider registry' });
      continue;
    }
    let addrs: string[];
    try {
      addrs = await resolve(new URL(e).hostname.replace(/^\[|\]$/g, ''));
    } catch {
      uncounted.push({ endpoint: e, why: 'hostname does not resolve' });
      continue;
    }
    if (!addrs.length) {
      uncounted.push({ endpoint: e, why: 'hostname does not resolve' });
      continue;
    }
    const op = ps[0]!.operator.trim().toLowerCase();
    const set = ips.get(op) ?? new Set<string>();
    for (const a of addrs) set.add(a);
    ips.set(op, set);
    counted++;
  }
  // Merge operators that share any IP address (union-find over operators).
  const ops = [...ips.keys()];
  const parent = new Map(ops.map((o) => [o, o]));
  const find = (o: string): string => (parent.get(o) === o ? o : find(parent.get(o)!));
  for (let i = 0; i < ops.length; i++)
    for (let j = i + 1; j < ops.length; j++) {
      const a = ips.get(ops[i]!)!;
      if ([...ips.get(ops[j]!)!].some((x) => a.has(x))) parent.set(find(ops[j]!), find(ops[i]!));
    }
  const groups = new Map<string, string[]>();
  for (const o of ops) groups.set(find(o), [...(groups.get(find(o)) ?? []), o]);
  return { independent: groups.size, counted, uncounted, groups: [...groups.values()] };
}
