import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, keccak256, parseAbiItem, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { protocolChain } from './finality.js';
import { checkAttesterIndependence, checkAttesterRuntime, checkRelayerRpcs, type AttesterDeployment, type OnchainSignerSets, type RuntimeAttester, type RuntimeRpc } from './attester-config.js';
import type { FinalityPolicy } from './finality.js';
import type { RpcProvider } from './rpc-providers.js';
import { artifact } from './types.js';

/**
 * Post-deployment verification. A deployment is "ready for transfers" ONLY if every check passes.
 * Run it after deploying and after every governance change:
 *   npx tsx protocol/verify-deployment.ts deployment.json
 */
export interface MultisigPolicy {
  /** Expected owners and threshold, read back from the Safe itself. */
  owners: Address[];
  threshold: number;
  /** Safe singleton (master copy) addresses accepted, from safe-global/safe-deployments. */
  allowedSingletons: Address[];
  /** keccak256 of the accepted SafeProxy runtime bytecode. */
  allowedProxyCodeHashes: Hex[];
}

export interface DeploymentConfig {
  /** deployBlock is REQUIRED: role holders are reconstructed from RoleGranted/RoleRevoked since then. */
  /**
   * `verifier` is the signer-set MessageVerifier (signers, threshold). With `verifierRouter`, the
   * bridge contract's verifier must be the router, and `activeVerifier` (default: `verifier`) must be
   * the router's active verifier for every route.
   */
  home: { chainId: number; rpc?: string; vault: Address; verifier: Address; timelock: Address; deployBlock?: number; verifierRouter?: Address; activeVerifier?: Address };
  remotes: { chainId: number; rpc?: string; executor: Address; verifier: Address; timelock: Address; deployBlock?: number; verifierRouter?: Address; activeVerifier?: Address }[];
  /**
   * Code hashes of AUDITED verifier implementations. Required when a router is used: the active
   * verifier and any pending upgrade must be one of them.
   */
  verifierPolicy?: { allowedCodeHashes: Hex[] };
  governance: { multisig: Address; pauser: Address; minTimelockDelaySec: number; deployer?: Address; multisigPolicy?: MultisigPolicy };
  signers: { addresses: Address[]; threshold: number; minRotationDelaySec: number };
  /**
   * maxChainCap is REQUIRED: the largest loss per token and per remote chain the business accepts.
   * Caps and rate limits are checked against it.
   */
  tokens: { canonical: Address; decimals: number; maxChainCap?: string }[];
  /** REQUIRED. How long it takes the team to detect an incident and pause. */
  damagePolicy?: { reactionTimeSec: number };
  /** Real attester deployment description (operators, key custody, RPC providers). Required. */
  attesters?: AttesterDeployment[];
  /** REQUIRED. Declared RPC providers (exact origins -> provider -> operator) used by attesters. */
  rpcProviders?: RpcProvider[];
}

/**
 * `deployment` checks decide readiness (addresses, roles, signers, caps, policy). `operational`
 * checks (global/route pause) are reported but NEVER close the deployment gate: a paused route is
 * an operational state handled per route by the contracts and the relayer, and refunds must keep
 * working while it is paused.
 */
export interface Check {
  scope: string;
  name: string;
  ok: boolean;
  detail?: string;
  kind: 'deployment' | 'operational';
}

export interface VerifyResult {
  ready: boolean;
  checks: Check[];
  operational: Check[];
}

/** Worst-case outflow before the team reacts: full bucket now + refill during the reaction time. */
export function worstCaseOutflow(capacity: bigint, windowSec: bigint, reactionSec: bigint): bigint {
  if (capacity === 0n || windowSec === 0n) return 0n;
  return capacity + (capacity * reactionSec) / windowSec;
}

/**
 * PROJECT POLICY floors: enforced regardless of what the config file says (the config can only make
 * them stricter).
 */
export const POLICY = {
  minTimelockDelaySec: 172_800, // 2 days
  minMultisigThreshold: 2,
  minMultisigOwners: 3,
  minVerifierUpgradeDelaySec: 604_800, // 7 days, same as VerifierRouter.MIN_UPGRADE_DELAY
} as const;

const ROUTER_ABI = [
  { type: 'function', name: 'upgradeDelay', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'verifierKind', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'activeVerifier', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'levelOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'minLevel', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'pendingUpgrade', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'uint64' }] },
  { type: 'function', name: 'isAllowedTestnet', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const ROUTER_KIND = keccak256(toHex('VERIFIER_ROUTER_V1'));

const ADMIN = `0x${'00'.repeat(32)}` as const;
const ROLE_GRANTED = parseAbiItem('event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)');
const ROLE_REVOKED = parseAbiItem('event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)');
const ROLE_ABI = [
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getRoleAdmin', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
] as const;
const SAFE_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
] as const;
const SENTINEL = '0x0000000000000000000000000000000000000001' as const;

/**
 * Reconstruct EVERY holder of EVERY role from the contract's own RoleGranted/RoleRevoked history
 * (AccessControl is not enumerable, so probing a few known addresses cannot rule out an unknown admin).
 */
export async function roleHolders(c: PublicClient, address: Address, fromBlock: bigint, chunk = 10_000n): Promise<Map<Hex, Set<Address>>> {
  const head = await c.getBlockNumber({ cacheTime: 0 });
  const logs = [];
  for (let a = fromBlock; a <= head; a += chunk) {
    const b = a + chunk - 1n < head ? a + chunk - 1n : head;
    logs.push(...(await c.getLogs({ address, events: [ROLE_GRANTED, ROLE_REVOKED], fromBlock: a, toBlock: b })));
  }
  logs.sort((x, y) => (x.blockNumber === y.blockNumber ? (x.logIndex ?? 0) - (y.logIndex ?? 0) : x.blockNumber! < y.blockNumber! ? -1 : 1));
  const out = new Map<Hex, Set<Address>>();
  for (const l of logs) {
    const { role, account } = l.args as { role: Hex; account: Address };
    const set = out.get(role) ?? new Set<Address>();
    if (l.eventName === 'RoleGranted') set.add(getAddress(account));
    else set.delete(getAddress(account));
    out.set(role, set);
  }
  return out;
}
const PAUSER_ROLE = keccak256(toHex('PAUSER_ROLE'));
const GUARDIAN_ROLE = keccak256(toHex('GUARDIAN_ROLE'));
const PROPOSER_ROLE = keccak256(toHex('PROPOSER_ROLE'));
const EXECUTOR_ROLE = keccak256(toHex('EXECUTOR_ROLE'));
const CANCELLER_ROLE = keccak256(toHex('CANCELLER_ROLE'));
const ZERO = '0x0000000000000000000000000000000000000000' as const;

const TIMELOCK_ABI = [
  { type: 'function', name: 'getMinDelay', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
const ERC20_DECIMALS = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

export async function verifyDeployment(cfg: DeploymentConfig, clients: Map<number, PublicClient>): Promise<VerifyResult> {
  const checks: Check[] = [];
  const operational: Check[] = [];
  const add = (scope: string, name: string, ok: boolean, detail?: string): void => {
    checks.push({ scope, name, ok, detail, kind: 'deployment' });
  };
  const op = (scope: string, name: string, ok: boolean, detail?: string): void => {
    operational.push({ scope, name, ok, detail, kind: 'operational' });
  };
  const safe = async <T>(scope: string, name: string, f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch (e) {
      add(scope, name, false, `call failed: ${(e as Error).message.slice(0, 120)}`);
      return undefined;
    }
  };
  const vaultAbi = artifact('BridgeVault').abi;
  const execAbi = artifact('BridgeExecutor').abi;
  const verAbi = artifact('MessageVerifier').abi;
  const tokenAbi = artifact('BridgeToken').abi;
  const eq = (a?: string, b?: string) => !!a && !!b && getAddress(a) === getAddress(b);
  const expectedSigners = cfg.signers.addresses.map((a) => getAddress(a)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

  const g = cfg.governance;
  const reaction = cfg.damagePolicy?.reactionTimeSec;
  add('damage-policy', 'damage policy defined (incident reaction time)', typeof reaction === 'number' && reaction > 0, 'set damagePolicy.reactionTimeSec');
  if (!cfg.attesters?.length) {
    add('attesters', 'attester deployment described (operators, key custody, RPCs)', false, 'missing "attesters" in config');
  } else {
    const findings = checkAttesterIndependence(cfg.attesters, cfg.signers.threshold, 2, cfg.rpcProviders);
    for (const f of findings) add('attesters', f.message, f.severity !== 'error');
    const declared = cfg.attesters.map((a) => (a.address && /^0x[0-9a-fA-F]{40}$/.test(a.address) ? getAddress(a.address) : undefined));
    add('attesters', 'every declared attester has a signing address', declared.every(Boolean));
    add(
      'attesters',
      'declared attester addresses == configured signer set',
      new Set(declared).size === declared.length && declared.length === expectedSigners.length && expectedSigners.every((x) => declared.includes(x)),
    );
  }
  add('governance', 'pauser is separate from multisig and timelocks', ![g.multisig, cfg.home.timelock, ...cfg.remotes.map((r) => r.timelock)].some((x) => eq(x, g.pauser)));

  /** The multisig must really be the expected Safe: known proxy code + singleton, owners, threshold, no modules. */
  async function multisigChecks(scope: string, c: PublicClient): Promise<void> {
    const pol = g.multisigPolicy;
    const code = await safe(scope, 'multisig code', () => c.getCode({ address: g.multisig }));
    add(scope, 'multisig is a contract (not an EOA)', !!code && code !== '0x');
    if (!pol) {
      add(scope, 'multisig policy defined (owners, threshold, accepted Safe code)', false, 'set governance.multisigPolicy');
      return;
    }
    const hashOk = !!code && code !== '0x' && pol.allowedProxyCodeHashes.map((h) => h.toLowerCase()).includes(keccak256(code).toLowerCase());
    add(scope, 'multisig runtime code is an accepted Safe proxy', hashOk, code && code !== '0x' ? `codehash=${keccak256(code)}` : undefined);
    const slot0 = await safe(scope, 'multisig singleton', () => c.getStorageAt({ address: g.multisig, slot: '0x0' }));
    const singleton = slot0 ? getAddress(`0x${slot0.slice(-40)}`) : undefined;
    add(scope, 'multisig singleton is an accepted Safe version', !!singleton && pol.allowedSingletons.some((x) => eq(x, singleton)), `singleton=${singleton}`);
    const owners = ((await safe(scope, 'multisig owners', () => c.readContract({ address: g.multisig, abi: SAFE_ABI, functionName: 'getOwners' }))) ?? []) as Address[];
    const th = await safe(scope, 'multisig threshold', () => c.readContract({ address: g.multisig, abi: SAFE_ABI, functionName: 'getThreshold' }));
    const want = pol.owners.map((x) => getAddress(x));
    const got = owners.map((x) => getAddress(x));
    add(scope, 'multisig owners == policy', got.length === want.length && new Set(got).size === got.length && want.every((x) => got.includes(x)), `on-chain=${got.length} policy=${want.length}`);
    add(scope, 'multisig threshold == policy', th !== undefined && Number(th) === pol.threshold, `on-chain=${th} policy=${pol.threshold}`);
    add(
      scope,
      `multisig meets project floor (>= ${POLICY.minMultisigThreshold} of >= ${POLICY.minMultisigOwners}, strict majority)`,
      th !== undefined && Number(th) >= POLICY.minMultisigThreshold && got.length >= POLICY.minMultisigOwners && Number(th) * 2 > got.length,
    );
    add(scope, 'pauser is not a multisig owner', !got.some((x) => eq(x, g.pauser)));
    const mods = await safe(scope, 'multisig modules', () => c.readContract({ address: g.multisig, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 10n] }));
    add(scope, 'multisig has no enabled modules (a module bypasses the threshold)', !!mods && (mods as readonly [readonly Address[], Address])[0].length === 0);
  }

  /**
   * Role holders reconstructed from events must be EXACTLY the policy, and agree with hasRole():
   *   bridge contracts & verifier: DEFAULT_ADMIN = {timelock}; PAUSER = {pauser} (bridge contracts)
   *   timelock: DEFAULT_ADMIN = {timelock}; PROPOSER = CANCELLER = EXECUTOR = {multisig}
   * Any other role with a holder, or a role whose admin is not DEFAULT_ADMIN, fails. The history
   * must start before the contract existed (checked), so no grant can be outside it.
   */
  async function roleChecks(scope: string, c: PublicClient, contracts: { addr: Address; label: string; bridge: boolean; roles?: Map<Hex, Address[]> }[], timelock: Address, deployBlock?: number): Promise<void> {
    add(scope, 'deployment block known (role history can be reconstructed)', deployBlock !== undefined && deployBlock >= 0, 'set deployBlock');
    if (deployBlock === undefined) return;
    const targets = [
      ...contracts.map((x) => ({ ...x, expected: x.roles ?? new Map<Hex, Address[]>(x.bridge ? [[ADMIN, [timelock]], [PAUSER_ROLE, [g.pauser]]] : [[ADMIN, [timelock]]]) })),
      { addr: timelock, label: 'Timelock', bridge: false, expected: new Map<Hex, Address[]>([[ADMIN, [timelock]], [PROPOSER_ROLE, [g.multisig]], [CANCELLER_ROLE, [g.multisig]], [EXECUTOR_ROLE, [g.multisig]]]) },
    ];
    for (const t of targets) {
      // The history is complete only if the contract did NOT exist before deployBlock: then every
      // RoleGranted (including the constructor's) is at or after it. A too-late deployBlock could
      // otherwise hide an admin granted earlier. Needs an RPC that serves historical state.
      const before = deployBlock > 0 ? BigInt(deployBlock - 1) : 0n;
      // viem returns undefined for empty code, so wrap to tell "no code" from "call failed".
      const prior = await safe(scope, `${t.label} code before deployBlock (archive RPC required)`, async () => ({ code: await c.getCode({ address: t.addr, blockNumber: before }) }));
      add(scope, `${t.label}: did not exist before deployBlock (role history complete)`, prior !== undefined && (!prior.code || prior.code === '0x'), `checked block ${before}`);
      const holders = await safe(scope, `${t.label} role history`, () => roleHolders(c, t.addr, BigInt(deployBlock)));
      if (!holders) continue;
      const roles = new Set<Hex>([...holders.keys(), ...t.expected.keys()]);
      for (const role of roles) {
        const want = (t.expected.get(role) ?? []).map((x) => getAddress(x)).sort();
        const got = [...(holders.get(role) ?? [])].sort();
        const label = role === ADMIN ? 'DEFAULT_ADMIN' : role === PAUSER_ROLE ? 'PAUSER' : role === GUARDIAN_ROLE ? 'GUARDIAN' : role === PROPOSER_ROLE ? 'PROPOSER' : role === EXECUTOR_ROLE ? 'EXECUTOR' : role === CANCELLER_ROLE ? 'CANCELLER' : `role ${role.slice(0, 10)}…`;
        add(scope, `${t.label}: ${label} holders exactly as policy`, JSON.stringify(got) === JSON.stringify(want), `on-chain=[${got.join(',')}] policy=[${want.join(',')}]`);
        // History must agree with live state (a wrong deployBlock would miss grants).
        let live = true;
        for (const who of new Set([...got, ...want])) {
          const has = await safe(scope, `${t.label} hasRole`, () => c.readContract({ address: t.addr, abi: ROLE_ABI, functionName: 'hasRole', args: [role, who] }));
          if (has !== got.includes(who)) live = false;
        }
        add(scope, `${t.label}: ${label} history agrees with hasRole()`, live);
        const adminOf = await safe(scope, `${t.label} role admin`, () => c.readContract({ address: t.addr, abi: ROLE_ABI, functionName: 'getRoleAdmin', args: [role] }));
        add(scope, `${t.label}: ${label} is administered by DEFAULT_ADMIN`, adminOf === ADMIN);
      }
    }
  }

  /**
   * Router checks: the bridge's verifier is the router; one-way policy in force (delay >= 7 days);
   * every route's active verifier is the expected, AUDITED (code-hash allowlisted) one at >= its
   * minimum level; a pending upgrade is reported, and closes the gate if it is not audited.
   */
  async function routerChecks(scope: string, c: PublicClient, router: Address, routes: number[], expectedActive: Address): Promise<void> {
    const allowed = (cfg.verifierPolicy?.allowedCodeHashes ?? []).map((h) => h.toLowerCase());
    add(scope, 'verifier policy defined (audited verifier code hashes)', allowed.length > 0, 'set verifierPolicy.allowedCodeHashes');
    const code = await safe(scope, 'router code', () => c.getCode({ address: router }));
    add(scope, 'VerifierRouter deployed', !!code && code !== '0x');
    const kind = await safe(scope, 'router kind', () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'verifierKind' }));
    add(scope, 'VerifierRouter is a VERIFIER_ROUTER_V1', kind === ROUTER_KIND);
    const tn = await safe(scope, 'router allowlist', () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'isAllowedTestnet', args: [BigInt(cfg.home.chainId)] }));
    add(scope, 'VerifierRouter built with testnet allowlist', tn === true);
    const delay = await safe(scope, 'router delay', () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'upgradeDelay' }));
    add(scope, `VerifierRouter upgrade delay >= ${POLICY.minVerifierUpgradeDelaySec}s`, delay !== undefined && delay >= BigInt(POLICY.minVerifierUpgradeDelaySec), `delay=${delay}`);
    for (const route of routes) {
      const r = BigInt(route);
      const active = await safe(scope, `route ${route} active verifier`, () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'activeVerifier', args: [r] }));
      add(scope, `VerifierRouter route ${route}: active verifier is the configured one`, eq(active as string, expectedActive), `active=${active} expected=${expectedActive}`);
      const [lvl, min] = await Promise.all([
        safe(scope, `route ${route} level`, () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'levelOf', args: [r] })),
        safe(scope, `route ${route} min level`, () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'minLevel', args: [r] })),
      ]);
      add(scope, `VerifierRouter route ${route}: active level >= route minimum >= 1`, lvl !== undefined && min !== undefined && Number(min) >= 1 && Number(lvl) >= Number(min), `level=${lvl} min=${min}`);
      const activeCode = active ? await safe(scope, `route ${route} active code`, () => c.getCode({ address: active as Address })) : undefined;
      add(scope, `VerifierRouter route ${route}: active verifier code is audited (allowlisted hash)`, !!activeCode && allowed.includes(keccak256(activeCode).toLowerCase()), activeCode ? `codehash=${keccak256(activeCode)}` : undefined);
      const pending = (await safe(scope, `route ${route} pending`, () => c.readContract({ address: router, abi: ROUTER_ABI, functionName: 'pendingUpgrade', args: [r] }))) as readonly [Address, number, Hex, bigint] | undefined;
      const hasPending = !!pending && !/^0x0{40}$/i.test(pending[0]);
      op(scope, `VerifierRouter route ${route}: no pending verifier upgrade`, !hasPending, hasPending ? `pending ${pending![0]} level=${pending![1]} eta=${pending![3]}` : undefined);
      if (hasPending) {
        // An un-audited verifier scheduled to go live: the guardian must veto it; hold forward flow.
        add(scope, `VerifierRouter route ${route}: pending upgrade is an audited verifier (else guardian must veto)`, allowed.includes(pending![2].toLowerCase()), `codehash=${pending![2]}`);
      }
    }
  }

  async function commonChecks(scope: string, chainId: number, contracts: { addr: Address; abi: typeof vaultAbi; label: string }[], verifier: Address, timelock: Address, deployBlock?: number, router?: { address: Address; routes: number[]; active: Address }): Promise<PublicClient | undefined> {
    const c = clients.get(chainId);
    if (!c) {
      add(scope, 'rpc client configured', false);
      return undefined;
    }
    const actual = await safe(scope, 'chain id', () => c.getChainId());
    add(scope, 'chain id matches config', actual === chainId, `rpc=${actual} config=${chainId}`);
    const reg = protocolChain(BigInt(chainId));
    add(scope, 'chain supported by protocol with explicit finality policy', !!reg && reg.status === 'supported' && !!reg.finality, reg?.finality?.kind);

    for (const x of [...contracts, { addr: verifier, abi: verAbi, label: 'MessageVerifier' }]) {
      const code = await safe(scope, `${x.label} code`, () => c.getCode({ address: x.addr }));
      add(scope, `${x.label} deployed`, !!code && code !== '0x');
      const allowed = await safe(scope, `${x.label} testnet allowlist`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'isAllowedTestnet', args: [BigInt(chainId)] }));
      add(scope, `${x.label} built with testnet allowlist`, allowed === true);
      const tlAdmin = await safe(scope, `${x.label} admin`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'hasRole', args: [ADMIN, timelock] }));
      add(scope, `${x.label} admin is the timelock`, tlAdmin === true);
      for (const who of [g.multisig, g.deployer, g.pauser].filter(Boolean) as Address[]) {
        const has = await safe(scope, `${x.label} admin holder`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'hasRole', args: [ADMIN, who] }));
        add(scope, `${x.label}: ${who.slice(0, 10)}… holds no direct admin`, has === false);
      }
      if (x.label !== 'MessageVerifier') {
        const p = await safe(scope, `${x.label} pauser`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'hasRole', args: [PAUSER_ROLE, g.pauser] }));
        add(scope, `${x.label} pauser configured`, p === true);
        const paused = await safe(scope, `${x.label} paused`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'paused' }));
        op(scope, `${x.label} not globally paused`, paused === false);
        const v = await safe(scope, `${x.label} verifier`, () => c.readContract({ address: x.addr, abi: x.abi, functionName: 'verifier' }));
        add(scope, `${x.label} uses the configured verifier${router ? ' (router)' : ''}`, eq(v as string, router?.address ?? verifier));
      }
    }

    const tlCode = await safe(scope, 'timelock code', () => c.getCode({ address: timelock }));
    add(scope, 'timelock deployed', !!tlCode && tlCode !== '0x');
    const delay = await safe(scope, 'timelock delay', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'getMinDelay' }));
    const minDelay = Math.max(POLICY.minTimelockDelaySec, g.minTimelockDelaySec);
    add(scope, `timelock delay >= ${minDelay}s (project floor ${POLICY.minTimelockDelaySec}s)`, delay !== undefined && delay >= BigInt(minDelay), `delay=${delay}`);
    const prop = await safe(scope, 'timelock proposer', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [PROPOSER_ROLE, g.multisig] }));
    add(scope, 'multisig is timelock proposer', prop === true);
    const exe = await safe(scope, 'timelock executor', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [EXECUTOR_ROLE, g.multisig] }));
    add(scope, 'multisig is timelock executor', exe === true);
    const can = await safe(scope, 'timelock canceller', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [CANCELLER_ROLE, g.multisig] }));
    add(scope, 'multisig can cancel scheduled operations', can === true);
    // The timelock must govern itself: nobody may hold its admin role (which could bypass the delay).
    const selfAdmin = await safe(scope, 'timelock self-admin', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [ADMIN, timelock] }));
    add(scope, 'timelock is self-administered', selfAdmin === true);
    const openExec = await safe(scope, 'open executor', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [EXECUTOR_ROLE, ZERO] }));
    add(scope, 'timelock execution is not open to everyone', openExec === false);
    for (const who of [g.multisig, g.deployer, g.pauser].filter(Boolean) as Address[]) {
      const tla = await safe(scope, 'timelock admin holder', () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [ADMIN, who] }));
      add(scope, `timelock: ${who.slice(0, 10)}… is not timelock admin`, tla === false);
    }
    for (const who of [g.deployer, g.pauser].filter(Boolean) as Address[]) {
      for (const [role, label] of [[PROPOSER_ROLE, 'proposer'], [EXECUTOR_ROLE, 'executor'], [CANCELLER_ROLE, 'canceller']] as const) {
        const has = await safe(scope, `timelock ${label}`, () => c.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [role, who] }));
        add(scope, `timelock: ${who.slice(0, 10)}… is not ${label}`, has === false);
      }
    }
    await multisigChecks(scope, c);
    const roleTargets: { addr: Address; label: string; bridge: boolean; roles?: Map<Hex, Address[]> }[] = [...contracts.map((x) => ({ addr: x.addr, label: x.label, bridge: true })), { addr: verifier, label: 'MessageVerifier', bridge: false }];
    if (router) {
      roleTargets.push({ addr: router.address, label: 'VerifierRouter', bridge: false, roles: new Map<Hex, Address[]>([[ADMIN, [timelock]], [GUARDIAN_ROLE, [g.pauser]]]) });
      await routerChecks(scope, c, router.address, router.routes, router.active);
    } else if (cfg.verifierPolicy?.allowedCodeHashes.length) {
      const vc = await safe(scope, 'verifier code', () => c.getCode({ address: verifier }));
      add(scope, 'MessageVerifier code is audited (allowlisted hash)', !!vc && cfg.verifierPolicy.allowedCodeHashes.map((h) => h.toLowerCase()).includes(keccak256(vc).toLowerCase()));
    }
    await roleChecks(scope, c, roleTargets, timelock, deployBlock);

    const signers = ((await safe(scope, 'signers', () => c.readContract({ address: verifier, abi: verAbi, functionName: 'signers' }))) ?? []) as Address[];
    add(scope, 'signer set matches config', JSON.stringify(signers.map((a) => getAddress(a))) === JSON.stringify(expectedSigners));
    const th = await safe(scope, 'threshold', () => c.readContract({ address: verifier, abi: verAbi, functionName: 'threshold' }));
    add(scope, 'threshold matches config and is a strict majority', Number(th) === cfg.signers.threshold && Number(th) * 2 > signers.length);
    const rd = await safe(scope, 'rotation delay', () => c.readContract({ address: verifier, abi: verAbi, functionName: 'rotationDelay' }));
    add(scope, `signer rotation delay >= ${cfg.signers.minRotationDelaySec}s`, rd !== undefined && BigInt(rd as bigint) >= BigInt(cfg.signers.minRotationDelaySec));
    return c;
  }

  // ---- home
  const hc = await commonChecks('home', cfg.home.chainId, [{ addr: cfg.home.vault, abi: vaultAbi, label: 'BridgeVault' }], cfg.home.verifier, cfg.home.timelock, cfg.home.deployBlock,
    cfg.home.verifierRouter ? { address: cfg.home.verifierRouter, routes: cfg.remotes.map((r) => r.chainId), active: cfg.home.activeVerifier ?? cfg.home.verifier } : undefined);
  // ---- remotes
  for (const r of cfg.remotes) {
    const scope = `remote:${r.chainId}`;
    const rc = await commonChecks(scope, r.chainId, [{ addr: r.executor, abi: execAbi, label: 'BridgeExecutor' }], r.verifier, r.timelock, r.deployBlock,
      r.verifierRouter ? { address: r.verifierRouter, routes: [cfg.home.chainId], active: r.activeVerifier ?? r.verifier } : undefined);
    if (!rc || !hc) continue;
    const homeId = await safe(scope, 'homeChainId', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'homeChainId' }));
    add(scope, 'executor home chain matches', Number(homeId) === cfg.home.chainId);
    const hv = await safe(scope, 'homeVault', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'homeVault' }));
    add(scope, 'executor points to the home vault', eq(hv as string, cfg.home.vault));
    const peer = await safe(scope, 'peer', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'peers', args: [BigInt(r.chainId)] }));
    add(scope, 'vault peer points to this executor', eq(peer as string, r.executor));
    const ps = await safe(scope, 'peer status', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'peerStatus', args: [BigInt(r.chainId), r.executor] }));
    add(scope, 'vault: executor peer status is Active', Number(ps) === 1);
    const vs = await safe(scope, 'vault status', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'vaultStatus', args: [cfg.home.vault] }));
    add(scope, 'executor: home vault status is Active', Number(vs) === 1);
    // Route-level pauses: a globally unpaused contract can still have this route paused.
    const vrp = await safe(scope, 'vault route pause', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'routePaused', args: [BigInt(r.chainId)] }));
    op(scope, 'vault: route to this chain not paused', vrp === false);
    const erp = await safe(scope, 'executor route pause', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'routePaused', args: [BigInt(cfg.home.chainId)] }));
    op(scope, 'executor: route from home not paused', erp === false);
    for (const t of cfg.tokens) {
      const ts = `${scope}:${t.canonical.slice(0, 10)}…`;
      const tc = (await safe(ts, 'token config', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'tokenConfig', args: [t.canonical] }))) as [boolean, bigint, bigint] | undefined;
      add(ts, 'vault: token enabled with bounds', !!tc && tc[0] === true && tc[1] > 0n && tc[2] >= tc[1]);
      const hdec = await safe(ts, 'canonical decimals', () => hc.readContract({ address: t.canonical, abi: ERC20_DECIMALS, functionName: 'decimals' }));
      add(ts, 'canonical decimals match config', Number(hdec) === t.decimals);
      const vb = (await safe(ts, 'vault rate limit', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'buckets', args: [t.canonical] }))) as readonly bigint[] | undefined;
      add(ts, 'vault: rate limit configured', !!vb && vb[0]! > 0n);
      const vrb = (await safe(ts, 'vault refund limit', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'refundBuckets', args: [t.canonical] }))) as readonly bigint[] | undefined;
      add(ts, 'vault: refund (recovery) limit configured', !!vrb && vrb[0]! > 0n);
      const max = t.maxChainCap !== undefined && /^[0-9]+$/.test(t.maxChainCap) ? BigInt(t.maxChainCap) : undefined;
      add(ts, 'maximum acceptable loss (maxChainCap) defined for token', max !== undefined && max > 0n);
      const cap = await safe(ts, 'chain cap', () => hc.readContract({ address: cfg.home.vault, abi: vaultAbi, functionName: 'chainCap', args: [t.canonical, BigInt(r.chainId)] }));
      add(ts, 'vault: per-chain cap configured', typeof cap === 'bigint' && cap > 0n && max !== undefined && cap <= max, `cap=${cap} max=${t.maxChainCap ?? 'MISSING'}`);
      const budget = (label: string, b: readonly bigint[] | undefined) => {
        const worst = b && reaction ? worstCaseOutflow(b[0]!, b[2]!, BigInt(reaction)) : undefined;
        add(ts, `${label}: worst-case outflow before reaction <= maxChainCap`, worst !== undefined && max !== undefined && worst <= max, `worst=${worst} max=${t.maxChainCap ?? 'MISSING'} reaction=${reaction ?? 'MISSING'}s`);
      };
      budget('vault transfer limit', vb);
      budget('vault refund limit', vrb);
      const w = await safe(ts, 'wrapped', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'wrapped', args: [t.canonical] }));
      const wOk = !!w && !/^0x0{40}$/i.test(w as string);
      add(ts, 'executor: wrapped token registered', wOk);
      if (wOk) {
        const wd = await safe(ts, 'wrapped decimals', () => rc.readContract({ address: w as Address, abi: tokenAbi, functionName: 'decimals' }));
        add(ts, 'wrapped decimals == canonical decimals', Number(wd) === t.decimals);
        const wb = await safe(ts, 'wrapped bridge', () => rc.readContract({ address: w as Address, abi: tokenAbi, functionName: 'bridge' }));
        add(ts, 'wrapped token minter is this executor', eq(wb as string, r.executor));
      }
      const eb = (await safe(ts, 'executor rate limit', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'buckets', args: [t.canonical] }))) as readonly bigint[] | undefined;
      add(ts, 'executor: rate limit configured', !!eb && eb[0]! > 0n);
      const erb = (await safe(ts, 'executor refund limit', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'refundBuckets', args: [t.canonical] }))) as readonly bigint[] | undefined;
      add(ts, 'executor: refund (recovery) limit configured', !!erb && erb[0]! > 0n);
      const sc = await safe(ts, 'supply cap', () => rc.readContract({ address: r.executor, abi: execAbi, functionName: 'supplyCap', args: [t.canonical] }));
      add(ts, 'executor: supply cap configured', typeof sc === 'bigint' && sc > 0n && max !== undefined && sc <= max, `cap=${sc} max=${t.maxChainCap ?? 'MISSING'}`);
      budget('executor transfer limit', eb);
      budget('executor refund limit', erb);
    }
  }
  return { ready: checks.every((c) => c.ok), checks, operational };
}

// ---- CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'deployment.json', 'utf8')) as DeploymentConfig;
  const clients = new Map<number, PublicClient>();
  for (const c of [cfg.home, ...cfg.remotes]) {
    if (!c.rpc) throw new Error(`rpc missing for chain ${c.chainId}`);
    clients.set(c.chainId, createPublicClient({ transport: http(c.rpc) }) as PublicClient);
  }
  verifyDeployment(cfg, clients).then((result) => {
    const { ready, checks } = result;
    for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} [${c.scope}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    for (const c of result.operational) console.log(`${c.ok ? '·' : '!'} [${c.scope}] (operational) ${c.name}`);
    console.log(ready ? '\nREADY FOR TRANSFERS' : `\nNOT READY: ${checks.filter((c) => !c.ok).length} check(s) failed`);
    process.exit(ready ? 0 : 1);
  });
}

export interface ReadinessRuntime {
  attesters: RuntimeAttester[];
  /** The relayer's own RPCs (receipts, "nothing locked" proofs): reported as operational health. */
  relayer?: { runtimeRpcConfig(): { chainId: bigint; rpcs: RuntimeRpc[]; rejectQuorum: number; finality: FinalityPolicy }[]; rpcProviders?: RpcProvider[] };
  minQuorum?: number;
  maxFinalizedLagBlocks?: bigint;
}

/**
 * The relayer's mandatory gate: static deployment checks + checks of the RUNNING attesters against
 * the signer set ACTUALLY installed on every chain (real quorum, bound endpoint/client pairs,
 * finality probes). Operational state (pauses, relayer RPC health) is reported, not gating.
 */
export async function verifyReadiness(cfg: DeploymentConfig, clients: Map<number, PublicClient>, runtime: ReadinessRuntime): Promise<VerifyResult> {
  const res = await verifyDeployment(cfg, clients);
  const verAbi = artifact('MessageVerifier').abi;
  const all = [{ chainId: cfg.home.chainId, verifier: cfg.home.verifier }, ...cfg.remotes.map((r) => ({ chainId: r.chainId, verifier: r.verifier }))];
  const onchain: OnchainSignerSets = new Map();
  for (const x of all) {
    const c = clients.get(x.chainId);
    if (!c) continue;
    try {
      const [signers, threshold] = await Promise.all([
        c.readContract({ address: x.verifier, abi: verAbi, functionName: 'signers' }) as Promise<Address[]>,
        c.readContract({ address: x.verifier, abi: verAbi, functionName: 'threshold' }) as Promise<number>,
      ]);
      onchain.set(BigInt(x.chainId), { signers: [...signers], threshold: Number(threshold) });
    } catch {
      /* reported as "on-chain signer set read for this chain" */
    }
  }
  const chains = all.map((x) => BigInt(x.chainId));
  for (const f of await checkAttesterRuntime(runtime.attesters, cfg.attesters ?? [], chains, { ...runtime, onchain, rpcProviders: cfg.rpcProviders })) {
    res.checks.push({ scope: `attester-runtime:${f.attester.slice(0, 10)}${f.chainId ? `@${f.chainId}` : ''}`, name: f.message, ok: f.ok, kind: 'deployment' });
  }
  if (runtime.relayer) {
    for (const f of await checkRelayerRpcs(runtime.relayer.runtimeRpcConfig(), { ...runtime, rpcProviders: runtime.relayer.rpcProviders })) {
      res.operational.push({ scope: `relayer-rpc@${f.chainId}`, name: f.message, ok: f.ok, kind: 'operational' });
    }
  }
  res.ready = res.checks.every((c) => c.ok);
  return res;
}

export function readinessGate(cfg: DeploymentConfig, clients: Map<number, PublicClient>, runtime: ReadinessRuntime): () => Promise<boolean> {
  return async () => (await verifyReadiness(cfg, clients, runtime)).ready;
}
