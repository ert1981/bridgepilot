import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, pad, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { MemoryRelayerStore } from '../protocol/relayer-store.js';
import { Attester, type ChainView } from '../protocol/attester.js';
import { messageId, Relayer, type RelayerAlert, type RelayerChain } from '../protocol/relayer.js';
import { TransactionReceiptNotFoundError } from 'viem';
import type { RpcProvider } from '../protocol/rpc-providers.js';
import { canTransition, IllegalTransition, TransferRecord } from '../protocol/state-machine.js';
import { SqliteRelayerStore } from '../protocol/relayer-store.js';
import { verifyDeployment, type DeploymentConfig } from '../protocol/verify-deployment.js';
import { checkAttesterRuntime, checkRelayerRpcs } from '../protocol/attester-config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifact, refundOf, type BridgeMessage } from '../protocol/types.js';

const ANVIL = process.env.ANVIL_PATH ?? '/opt/foundry/anvil';
const HAVE_ANVIL = existsSync(ANVIL) && existsSync(new URL('../contracts/evm/out/BridgeVault.sol/BridgeVault.json', import.meta.url));
// In the full pipeline (REQUIRE_E2E=1) a missing anvil or missing artifacts is a FAILURE, not a skip.
if (process.env.REQUIRE_E2E === '1' && !HAVE_ANVIL) throw new Error(`protocol e2e required but anvil (${ANVIL}) or contract artifacts are missing`);

// Anvil's well-known development keys (never use on a real network).
const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b05a1e3b7a6b6e6e2b3c4d5e',
];
const ATTESTER_KEYS: Hex[] = [
  '0x0000000000000000000000000000000000000000000000000000000000a11ce1',
  '0x0000000000000000000000000000000000000000000000000000000000b0b002',
  '0x0000000000000000000000000000000000000000000000000000000000c4a103',
];
const deployer = privateKeyToAccount(KEYS[0]!);
const pauser = privateKeyToAccount(KEYS[1]!);
const alice = privateKeyToAccount(KEYS[2]!);
const relayerAcct = privateKeyToAccount(KEYS[3]!);

interface Node { proc: ChildProcess; url: string; chainId: number; client: PublicClient; wallet: ReturnType<typeof createWalletClient> }

async function startAnvil(port: number, chainId: number): Promise<Node> {
  // Bound to two loopback addresses: 127.0.0.2 stands in for a second, independently operated
  // endpoint (distinct IP). Loopback only — never exposed to the network.
  const proc = spawn(ANVIL, ['--port', String(port), '--host', '127.0.0.1', '--host', '127.0.0.2', '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: chainId, name: `local-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const client = createPublicClient({ chain, transport: http(url), pollingInterval: 50 }) as PublicClient;
  const wallet = createWalletClient({ chain, transport: http(url) });
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); return { proc, url, chainId, client, wallet }; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('anvil did not start');
}

async function deploy(n: Node, name: string, args: unknown[], from = deployer): Promise<Address> {
  const a = artifact(name);
  const hash = await n.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: from, chain: n.client.chain });
  const r = await n.client.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

async function send(n: Node, address: Address, name: string, fn: string, args: unknown[], from = deployer): Promise<Hex> {
  const hash = await n.wallet.writeContract({ address, abi: artifact(name).abi, functionName: fn, args, account: from, chain: n.client.chain });
  const r = await n.client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${fn} reverted`);
  return hash;
}

const read = (n: Node, address: Address, name: string, fn: string, args: unknown[] = []) =>
  n.client.readContract({ address, abi: artifact(name).abi, functionName: fn, args });

const altUrl = (n: Node) => n.url.replace('127.0.0.1', '127.0.0.2');
const altClient = (n: Node) => createPublicClient({ chain: n.client.chain, transport: http(altUrl(n)) }) as PublicClient;
/** Declared provider registry for the test chains: two operators, distinct IPs. */
const registryFor = (nodes: Node[]): RpcProvider[] => [
  { id: 'op-one', operator: 'Operator One (test)', origins: nodes.map((n) => n.url) },
  { id: 'op-two', operator: 'Operator Two (test)', origins: nodes.map(altUrl) },
];
/** A client whose receipts are always "not found" (lagging / inconsistent / lying RPC). */
const receiptless = (c: PublicClient): PublicClient =>
  ({ ...c, getTransactionReceipt: async ({ hash }: { hash: Hex }) => { throw new TransactionReceiptNotFoundError({ hash }); } }) as unknown as PublicClient;

const mine = (n: Node, blocks: number) => n.client.request({ method: 'anvil_mine' as never, params: [`0x${blocks.toString(16)}`] as never });

describe.skipIf(!HAVE_ANVIL)('protocol end-to-end on two local chains (2-of-3 attesters)', () => {
  let home: Node;
  let remote: Node;
  let vault: Address, executor: Address, usdc: Address, wrapped: Address, homeVerifier: Address, remoteVerifier: Address;
  let relayer: Relayer;
  let attesters: Attester[];
  let chainsCfg: Map<bigint, RelayerChain>;
  let views: Map<bigint, ChainView>;
  let routes: Map<bigint, Map<string, { destChainId: bigint; destContract: Address }[]>>;
  let verifiers: Map<bigint, Address>;
  /** Relayer chain config for any account, scanning from the given blocks. */
  let chainsFor: (acct: PrivateKeyAccount, startHome: bigint, startRemote: bigint) => Map<bigint, RelayerChain>;
  const CONF = 3n;
  const FINALITY = { kind: 'depth', confirmations: CONF } as const;
  const storePath = join(mkdtempSync(join(tmpdir(), 'bp-relayer-')), 'relayer.sqlite');
  const alerts: RelayerAlert[] = [];
  // A stable ownerId (e.g. the hostname) lets a restarted relayer resume its own leases immediately.
  let registry: RpcProvider[] = [];
  const makeRelayer = (ownerId = 'relayer-main') => new Relayer(chainsCfg, attesters, { rpcProviders: registry, store: new SqliteRelayerStore(storePath), onAlert: (a) => alerts.push(a), reorgMargin: 16n, ownerId, operators: ['ops-alice'], devMode: true });

  beforeAll(async () => {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    [home, remote] = await Promise.all([startAnvil(base, 31337), startAnvil(base + 1, 31338)]);
    registry = registryFor([home, remote]);
    const signerAddrs = ATTESTER_KEYS.map((k) => privateKeyToAccount(k).address).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

    homeVerifier = await deploy(home, 'MessageVerifier', [deployer.address, signerAddrs, 2, 86_400n]);
    vault = await deploy(home, 'BridgeVault', [deployer.address, pauser.address, homeVerifier, 10, deployer.address]);
    usdc = await deploy(home, 'MockToken', ['USD Coin', 'USDC', 6]);
    remoteVerifier = await deploy(remote, 'MessageVerifier', [deployer.address, signerAddrs, 2, 86_400n]);
    executor = await deploy(remote, 'BridgeExecutor', [deployer.address, pauser.address, remoteVerifier, 31337n]);

    await send(remote, executor, 'BridgeExecutor', 'registerToken', [usdc, 'Bridged USDC', 'bpUSDC', 6, 1n]);
    wrapped = (await read(remote, executor, 'BridgeExecutor', 'wrapped', [usdc])) as Address;
    await send(remote, executor, 'BridgeExecutor', 'setHomeVault', [vault]);
    await send(remote, executor, 'BridgeExecutor', 'setRateLimit', [usdc, 1_000_000_000_000n, 86_400n]);
    await send(remote, executor, 'BridgeExecutor', 'setRefundLimit', [usdc, 100_000_000_000n, 86_400n]);
    await send(remote, executor, 'BridgeExecutor', 'setSupplyCap', [usdc, 10_000_000_000_000n]);
    await send(home, vault, 'BridgeVault', 'configureToken', [usdc, true, 1_000_000n, 500_000_000_000n]);
    await send(home, vault, 'BridgeVault', 'setPeer', [31338n, executor]);
    await send(home, vault, 'BridgeVault', 'setRateLimit', [usdc, 1_000_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setRefundLimit', [usdc, 100_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setChainCap', [usdc, 31338n, 10_000_000_000_000n]);
    await send(home, usdc, 'MockToken', 'mint', [alice.address, 10_000_000_000n]);
    await send(home, usdc, 'MockToken', 'approve', [vault, 2n ** 255n], alice);

    views = new Map<bigint, ChainView>([
      [31337n, { chainId: 31337n, client: home.client, finality: FINALITY }],
      [31338n, { chainId: 31338n, client: remote.client, finality: FINALITY }],
    ]);
    routes = new Map([
      [31337n, new Map([[vault.toLowerCase(), [{ destChainId: 31338n, destContract: executor }]]])],
      [31338n, new Map([[executor.toLowerCase(), [{ destChainId: 31337n, destContract: vault }]]])],
    ]);
    verifiers = new Map<bigint, Address>([[31337n, homeVerifier], [31338n, remoteVerifier]]);
    attesters = ATTESTER_KEYS.map((k) => new Attester(k, views, routes, verifiers));
    const startHome = await home.client.getBlockNumber();
    const startRemote = await remote.client.getBlockNumber();
    const rc = (acct: PrivateKeyAccount, n: Node, bridge: Address, verifier: Address, role: 'home' | 'remote', startBlock: bigint): RelayerChain => ({
      chainId: BigInt(n.chainId), client: n.client, wallet: createWalletClient({ account: acct, chain: n.client.chain, transport: http(n.url) }), finality: FINALITY, bridge, verifier, role, startBlock,
      // A second, independent connection used to PROVE "nothing locked" before any rejection.
      proofClients: [altClient(n)],
    });
    chainsFor = (acct, sh, sr) => new Map([[31337n, rc(acct, home, vault, homeVerifier, 'home', sh)], [31338n, rc(acct, remote, executor, remoteVerifier, 'remote', sr)]]);
    chainsCfg = chainsFor(relayerAcct, startHome, startRemote);
    relayer = makeRelayer();
  }, 60_000);

  afterAll(() => {
    home?.proc.kill();
    remote?.proc.kill();
  });

  /** Tick until every record is terminal, PAUSED or RECOVERY_REQUIRED (bounded). */
  async function drive(maxTicks = 20) {
    for (let i = 0; i < maxTicks; i++) {
      await relayer.scan(31337n);
      await relayer.scan(31338n);
      await relayer.tick();
      await Promise.all([mine(home, 1), mine(remote, 1)]); // time passes on both chains
      const busy = [...relayer.records.values()].some((r) => !r.terminal && r.state !== 'PAUSED' && r.state !== 'RECOVERY_REQUIRED' && r.state !== 'SOURCE_PENDING');
      if (!busy) {
        const pendingFinal = [...relayer.records.values()].some((r) => r.state === 'SOURCE_PENDING');
        if (!pendingFinal) return;
      }
    }
  }
  const recordFor = (m: BridgeMessage) => relayer.records.get(messageId(m))!;

  async function lock(amount: bigint) {
    const hash = await send(home, vault, 'BridgeVault', 'lock', [usdc, amount, 31338n, alice.address], alice);
    const r = await home.client.getTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: artifact('BridgeVault').abi, logs: r.logs, eventName: 'TransferInitiated' })[0]!;
    return { hash, message: (ev.args as unknown as { message: BridgeMessage }).message };
  }

  it('waits for finality, then lock -> attest -> mint', async () => {
    const { message } = await lock(1_000_000_000n);
    await relayer.scan(31337n);
    await relayer.tick();
    expect(recordFor(message).state).toBe('SOURCE_PENDING'); // not final yet
    expect(await read(remote, wrapped, 'BridgeToken', 'balanceOf', [alice.address])).toBe(0n);
    await mine(home, Number(CONF));
    await drive();
    const rec = recordFor(message);
    expect(rec.state, JSON.stringify(rec.history)+ ' ERR=' + rec.payload.lastError).toBe('COMPLETED');
    expect(rec.history.map((h) => h.state)).toEqual(['CREATED', 'SOURCE_PENDING', 'SOURCE_FINALIZED', 'PROOF_VERIFIED', 'DESTINATION_PENDING', 'COMPLETED']);
    expect(await read(remote, wrapped, 'BridgeToken', 'balanceOf', [alice.address])).toBe(999_000_000n);
  }, 60_000);

  it('burn -> attest -> release back on the home chain', async () => {
    const before = (await read(home, usdc, 'MockToken', 'balanceOf', [alice.address])) as bigint;
    const hash = await send(remote, executor, 'BridgeExecutor', 'burn', [usdc, 400_000_000n, alice.address], alice);
    const r = await remote.client.getTransactionReceipt({ hash });
    const m = (parseEventLogs({ abi: artifact('BridgeExecutor').abi, logs: r.logs, eventName: 'TransferInitiated' })[0]!.args as unknown as { message: BridgeMessage }).message;
    await mine(remote, Number(CONF));
    await drive();
    expect(recordFor(m).state).toBe('COMPLETED');
    expect(((await read(home, usdc, 'MockToken', 'balanceOf', [alice.address])) as bigint) - before).toBe(400_000_000n);
    expect(await read(home, vault, 'BridgeVault', 'totalLocked', [usdc])).toBe(599_000_000n);
    expect(await read(remote, wrapped, 'BridgeToken', 'totalSupply')).toBe(599_000_000n);
  }, 60_000);

  it('attesters refuse a message that differs from the on-chain event', async () => {
    const { hash, message } = await lock(5_000_000n);
    await mine(home, Number(CONF));
    const forged = { ...message, amount: message.amount * 1000n };
    for (const a of attesters) expect(await a.attest(forged, hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/differs/) });
    await drive(); // the real one still completes
    expect(recordFor(message).state).toBe('COMPLETED');
  }, 60_000);

  it('a reorged lock is never attested or minted', async () => {
    const snap = (await home.client.request({ method: 'evm_snapshot' as never })) as Hex;
    const { message, hash } = await lock(7_000_000n);
    await relayer.scan(31337n);
    expect(recordFor(message).state).toBe('SOURCE_PENDING');
    await home.client.request({ method: 'evm_revert' as never, params: [snap] as never });
    await mine(home, Number(CONF) + 1);
    for (const a of attesters) expect((await a.attest(message, hash)).ok).toBe(false);
    await relayer.tick();
    expect(recordFor(message).state).toBe('SOURCE_PENDING'); // one miss is not yet a verdict
    await relayer.tick();
    await relayer.tick();
    expect(recordFor(message).state).toBe('REJECTED');
    expect(await read(remote, executor, 'BridgeExecutor', 'processed', [recordFor(message).payload.messageId])).toBe(false);
  }, 60_000);

  it('a real, final lock whose receipt one RPC cannot find is NEVER rejected (fourth review P0)', async () => {
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const seen: RelayerAlert[] = [];
    const lying = (proof: boolean) => {
      const cfg = chainsFor(relayerAcct, sh + 1n, sr + 1n);
      const h = cfg.get(31337n)!;
      cfg.set(31337n, { ...h, client: receiptless(home.client), proofClients: proof ? [altClient(home)] : [] });
      return new Relayer(cfg, attesters, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true, onAlert: (a) => seen.push(a) });
    };
    const withProofRpc = lying(true);
    const withoutProofRpc = lying(false);
    const { message } = await lock(2_100_000n);
    const id = messageId(message);
    await mine(home, Number(CONF) + 2); // the lock is now FINAL on the real chain
    for (const r of [withProofRpc, withoutProofRpc]) {
      await r.scan(31337n);
      expect(r.records.get(id)!.state).toBe('SOURCE_PENDING'); // the event was seen in the logs
      for (let i = 0; i < 6; i++) {
        await r.tick();
        await mine(home, 1);
      }
      const rec = r.records.get(id)!;
      expect(rec.state).toBe('SOURCE_PENDING'); // still watched, not REJECTED
      expect(rec.payload.misses).toBeGreaterThanOrEqual(6);
      expect(rec.payload.lastError).toMatch(/not disproven/);
    }
    // With an independent RPC the source contract itself contradicts the missing receipt:
    expect(withProofRpc.records.get(id)!.payload.lastError).toMatch(/initiated at final block/);
    // Without one, the relayer refuses to decide alone:
    expect(withoutProofRpc.records.get(id)!.payload.lastError).toMatch(/independent endpoints are required/);
    expect(seen.filter((a) => a.level === 'critical' && a.id === id).length).toBe(2); // one alert per relayer, not per tick
    // The honest relayer delivers it; the funds were never at risk.
    await drive();
    expect(recordFor(message).state).toBe('COMPLETED');
  }, 90_000);

  it('pauses on a paused destination and resumes after admin unpause', async () => {
    await send(remote, executor, 'BridgeExecutor', 'pause', [], pauser);
    const { message } = await lock(3_000_000n);
    await mine(home, Number(CONF));
    await drive();
    expect(recordFor(message).state).toBe('PAUSED');
    await send(remote, executor, 'BridgeExecutor', 'unpause', []);
    await drive();
    expect(recordFor(message).state).toBe('COMPLETED');
  }, 60_000);

  it('is idempotent: an already-executed message is marked completed, never re-sent', async () => {
    const done = [...relayer.records.values()].filter((r) => r.state === 'COMPLETED');
    const before = await remote.client.getTransactionCount({ address: relayerAcct.address });
    const rec = done[0]!;
    // Pretend we lost local state and must re-process.
    const clone = new TransferRecord(rec.id + ':dup', { ...rec.payload, destTxHash: undefined }, Date.now());
    clone.move('SOURCE_PENDING', Date.now());
    clone.move('SOURCE_FINALIZED', Date.now());
    clone.move('PROOF_VERIFIED', Date.now());
    relayer.records.set(clone.id, clone);
    await relayer.tick();
    expect(clone.state).toBe('COMPLETED');
    expect(clone.history.at(-1)!.reason).toMatch(/already processed/);
    expect(await remote.client.getTransactionCount({ address: relayerAcct.address })).toBe(before);
  }, 60_000);

  it('a single compromised attester cannot mint (threshold 2)', async () => {
    const { message } = await lock(2_000_000n);
    await mine(home, Number(CONF));
    const evil = { ...message, nonce: 9_999n, amount: 1_000_000_000_000n };
    const sig = await privateKeyToAccount(ATTESTER_KEYS[0]!).signTypedData({
      ...(await import('../protocol/types.js')).attestationTypedData(evil, remoteVerifier, 31338n, (await read(remote, remoteVerifier, 'MessageVerifier', 'signerSetVersion')) as bigint),
    });
    await expect(
      remote.client.simulateContract({ address: executor, abi: [...artifact('BridgeExecutor').abi, ...artifact('MessageVerifier').abi.filter((x) => x.type === 'error')], functionName: 'execute', args: [evil, [sig]], account: relayerAcct }),
    ).rejects.toThrow(/NotEnoughSignatures/);
    await drive();
    expect(recordFor(message).state).toBe('COMPLETED');
  }, 60_000);

  it('transient RPC errors never reject a transfer (M4)', async () => {
    const { message } = await lock(1_500_000n);
    await relayer.scan(31337n);
    const real = home.client.getTransactionReceipt;
    let failures = 0;
    (home.client as { getTransactionReceipt: unknown }).getTransactionReceipt = async () => { failures++; throw new Error('HTTP 502 from RPC'); };
    for (let i = 0; i < 5; i++) await relayer.tick();
    (home.client as { getTransactionReceipt: unknown }).getTransactionReceipt = real;
    expect(failures).toBeGreaterThanOrEqual(5);
    expect(recordFor(message).state).toBe('SOURCE_PENDING');
    await mine(home, Number(CONF));
    await drive();
    expect(recordFor(message).state).toBe('COMPLETED');
  }, 60_000);

  it('re-attests after a signer-set rotation instead of getting stuck (M5)', async () => {
    const { message } = await lock(2_500_000n);
    await mine(home, Number(CONF));
    await relayer.scan(31337n);
    for (let i = 0; i < 6 && recordFor(message).state !== 'PROOF_VERIFIED'; i++) await relayer.tick();
    expect(recordFor(message).state).toBe('PROOF_VERIFIED');
    // Rotate the remote verifier to the same signers (bumps signerSetVersion => cached sigs stale).
    const signerAddrs = (await read(remote, remoteVerifier, 'MessageVerifier', 'signers')) as Address[];
    await send(remote, remoteVerifier, 'MessageVerifier', 'proposeSignerSet', [signerAddrs, 2]);
    await remote.client.request({ method: 'evm_increaseTime' as never, params: [86_401] as never });
    await mine(remote, 1);
    await send(remote, remoteVerifier, 'MessageVerifier', 'executeSignerSet', []);
    await drive();
    const rec = recordFor(message);
    const done = recordFor(message);
    expect(done.state, JSON.stringify(done.history)).toBe('COMPLETED');
    expect(done.history.some((h) => /re-attesting/.test(h.reason ?? ''))).toBe(true);
  }, 60_000);

  it('survives a relayer crash and restart without double submission (durable state)', async () => {
    const { message } = await lock(4_000_000n);
    await mine(home, Number(CONF));
    const id = messageId(message);
    for (let i = 0; i < 10 && relayer.records.get(id)?.state !== 'DESTINATION_PENDING'; i++) {
      await relayer.scan(31337n);
      await relayer.tick();
    }
    expect(relayer.records.get(id)!.state).toBe('DESTINATION_PENDING');
    const sentHash = relayer.records.get(id)!.payload.destTxHash!;
    // anvil may return the hash before the block is mined: count only after inclusion.
    await remote.client.waitForTransactionReceipt({ hash: sentHash });
    const txCount = await remote.client.getTransactionCount({ address: relayerAcct.address, blockTag: 'pending' });

    relayer = makeRelayer(); // "crash": brand-new process state, same database
    expect(relayer.records.get(id)!.state).toBe('DESTINATION_PENDING');
    expect(new SqliteRelayerStore(storePath).getCheckpoint(31337n)).toBeDefined();
    await drive();
    const done = relayer.records.get(id)!;
    expect(done.state).toBe('COMPLETED');
    expect(done.payload.destTxHash).toBe(sentHash); // the original submission, never replaced
    expect(await remote.client.getTransactionCount({ address: relayerAcct.address, blockTag: 'pending' })).toBe(txCount); // nothing re-sent
  }, 60_000);

  it('a stuck transfer raises an alert, is cancelled by the recipient and refunded exactly once', async () => {
    const oth = await deploy(home, 'MockToken', ['Other', 'OTH', 6]);
    await send(home, vault, 'BridgeVault', 'configureToken', [oth, true, 1_000_000n, 500_000_000_000n]);
    await send(home, vault, 'BridgeVault', 'setRateLimit', [oth, 1_000_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setRefundLimit', [oth, 1_000_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setChainCap', [oth, 31338n, 1_000_000_000_000n]);
    await send(home, oth, 'MockToken', 'mint', [alice.address, 10_000_000n]);
    await send(home, oth, 'MockToken', 'approve', [vault, 2n ** 255n], alice);
    // The executor never registered OTH: minting is impossible => stuck.
    const hash = await send(home, vault, 'BridgeVault', 'lock', [oth, 10_000_000n, 31338n, alice.address], alice);
    const r = await home.client.getTransactionReceipt({ hash });
    const m = (parseEventLogs({ abi: artifact('BridgeVault').abi, logs: r.logs, eventName: 'TransferInitiated' })[0]!.args as unknown as { message: BridgeMessage }).message;
    await mine(home, Number(CONF));
    await drive();
    const rec = recordFor(m);
    expect(rec.state).toBe('RECOVERY_REQUIRED');
    expect(rec.history.at(-1)!.reason).toMatch(/TokenNotRegistered/);
    expect(alerts.some((a) => a.id === rec.id && a.level === 'critical')).toBe(true);
    expect(relayer.pendingReport().find((x) => x.id === rec.id)?.stuck).toBe(true);

    // Recipient gives the transfer up using the attestations the relayer already holds.
    await send(remote, executor, 'BridgeExecutor', 'cancel', [m, relayer.signaturesFor(rec.id)!], alice);
    await mine(remote, Number(CONF));
    await drive();
    expect(recordFor(m).state, JSON.stringify(recordFor(m).history) + recordFor(m).payload.lastError).toBe('REFUNDED');
    expect(await read(home, oth, 'MockToken', 'balanceOf', [alice.address])).toBe(m.amount); // net returned (fee kept)
    expect(await read(home, vault, 'BridgeVault', 'lockedFor', [oth, 31338n])).toBe(0n);
    // Neither a mint nor a second refund is possible any more.
    await expect(
      remote.client.simulateContract({ address: executor, abi: artifact('BridgeExecutor').abi, functionName: 'execute', args: [m, relayer.signaturesFor(rec.id)!], account: relayerAcct }),
    ).rejects.toThrow();
    await expect(
      home.client.simulateContract({ address: vault, abi: artifact('BridgeVault').abi, functionName: 'refund', args: [m, recordFor(m).payload.refundSignatures!], account: relayerAcct }),
    ).rejects.toThrow();
    expect(await read(home, vault, 'BridgeVault', 'processed', [messageId(refundOf(m))])).toBe(true);
  }, 90_000);


  // ===================================================== failure scenarios from the second review

  /** An isolated relayer (own store) that only sees transfers from now on. */
  async function isolatedRelayer(opts: Partial<ConstructorParameters<typeof Relayer>[2]> = {}, acct = relayerAcct) {
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    return new Relayer(chainsFor(acct, sh + 1n, sr + 1n), attesters, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true, ...opts });
  }
  async function driveOnly(r: Relayer, id: string, until: string[], max = 25) {
    for (let i = 0; i < max && !until.includes(r.records.get(id)?.state ?? ''); i++) {
      await r.scan(31337n);
      await r.scan(31338n);
      await r.tick();
      await Promise.all([mine(home, 1), mine(remote, 1)]);
    }
    return r.records.get(id);
  }
  const relayerTxs = (acct: Address) => Promise.all([home.client.getTransactionCount({ address: acct, blockTag: 'pending' }), remote.client.getTransactionCount({ address: acct, blockTag: 'pending' })]).then(([a, b]) => a + b);

  it('EXPIRED is not terminal: a late-finalizing source still completes (review #1)', async () => {
    let t = 1_000_000;
    const warnings: RelayerAlert[] = [];
    const r = await isolatedRelayer({ now: () => t, expiryMs: 1_000, onAlert: (a) => warnings.push(a) });
    const { message } = await lock(1_100_000n);
    const id = messageId(message);
    await r.scan(31337n);
    await r.tick(); // not final yet
    t += 2_000; // processing window passes
    await r.tick();
    expect(r.records.get(id)!.state).toBe('EXPIRED');
    expect(r.records.get(id)!.terminal).toBe(false);
    expect(warnings.some((w) => w.id === id && w.state === 'EXPIRED')).toBe(true);
    await mine(home, Number(CONF)); // finality arrives late
    const rec = await driveOnly(r, id, ['COMPLETED']);
    expect(rec!.state).toBe('COMPLETED');
    expect(rec!.history.map((h) => h.state)).toContain('EXPIRED');
    expect(rec!.history.find((h) => h.state === 'SOURCE_FINALIZED')!.reason).toMatch(/after the processing window/);
  }, 90_000);

  it('two relayers on one database never both submit (leases) (review: concurrency)', async () => {
    const acctB = privateKeyToAccount(generatePrivateKey());
    for (const n of [home, remote]) await n.client.request({ method: 'anvil_setBalance' as never, params: [acctB.address, '0x56BC75E2D63100000'] as never });
    const shared = join(mkdtempSync(join(tmpdir(), 'bp-two-')), 'r.sqlite');
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const A = new Relayer(chainsFor(relayerAcct, sh + 1n, sr + 1n), attesters, { store: new SqliteRelayerStore(shared), ownerId: 'A', devMode: true });
    const B = new Relayer(chainsFor(acctB, sh + 1n, sr + 1n), attesters, { store: new SqliteRelayerStore(shared), ownerId: 'B', devMode: true });
    const before = (await relayerTxs(relayerAcct.address)) + (await relayerTxs(acctB.address));
    const { message } = await lock(1_200_000n);
    const id = messageId(message);
    await mine(home, Number(CONF));
    for (let i = 0; i < 12; i++) {
      await Promise.all([A.scan(31337n).then(() => A.tick()), B.scan(31337n).then(() => B.tick())]);
      await Promise.all([mine(home, 1), mine(remote, 1)]);
    }
    const final = new SqliteRelayerStore<never>(shared).load(id)!;
    expect(final.state).toBe('COMPLETED');
    const after = (await relayerTxs(relayerAcct.address)) + (await relayerTxs(acctB.address));
    expect(after - before).toBe(1); // exactly one destination transaction in total
  }, 90_000);

  it('crash after persisting but before broadcasting: the SAME signed tx is re-sent, nothing doubled (review)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bp-crash-')), 'r.sqlite');
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    let crashed = false;
    const first = new Relayer(chainsFor(relayerAcct, sh + 1n, sr + 1n), attesters, {
      store: new SqliteRelayerStore(dbPath),
      ownerId: 'crashy',
      devMode: true,
      testHooks: { afterPersistBeforeBroadcast: () => { if (!crashed) { crashed = true; throw new Error('simulated crash'); } } },
    });
    const { message } = await lock(1_300_000n);
    const id = messageId(message);
    await mine(home, Number(CONF));
    const txBefore = await relayerTxs(relayerAcct.address);
    for (let i = 0; i < 6 && !crashed; i++) {
      await first.scan(31337n);
      await first.tick();
    }
    expect(crashed).toBe(true);
    const persisted = new SqliteRelayerStore<never>(dbPath).load(id)! as unknown as { state: string; payload: { destTxHash: Hex } };
    expect(persisted.state).toBe('DESTINATION_PENDING');
    expect(await relayerTxs(relayerAcct.address)).toBe(txBefore); // nothing reached the chain

    const restarted = new Relayer(chainsFor(relayerAcct, sh + 1n, sr + 1n), attesters, { store: new SqliteRelayerStore(dbPath), ownerId: 'crashy', devMode: true });
    const rec = await driveOnly(restarted, id, ['COMPLETED']);
    expect(rec!.state).toBe('COMPLETED');
    const firstReceipt = await remote.client.getTransactionReceipt({ hash: persisted.payload.destTxHash }).catch((e) => String(e).slice(0, 60));
    expect(rec!.payload.destTxHash, JSON.stringify(rec!.history.map((h) => `${h.state}:${(h.reason ?? '').slice(0, 90)}`))).toBe(persisted.payload.destTxHash); // the write-ahead tx itself
    expect(typeof firstReceipt === 'string' ? firstReceipt : firstReceipt.status).toBe('success'); // and it succeeded when re-sent
    expect(await relayerTxs(relayerAcct.address)).toBe(txBefore + 1);
  }, 90_000);

  it('a stale processed() read after a successful execution never triggers a resend (review)', async () => {
    const r = await isolatedRelayer();
    const { message } = await lock(1_400_000n);
    const id = messageId(message);
    await mine(home, Number(CONF));
    await driveOnly(r, id, ['DESTINATION_PENDING']);
    const sentHash = r.records.get(id)!.payload.destTxHash!;
    await remote.client.waitForTransactionReceipt({ hash: sentHash });
    const txBefore = await relayerTxs(relayerAcct.address);
    const real = remote.client.readContract;
    (remote.client as { readContract: unknown }).readContract = (async (args: { functionName: string }) =>
      args.functionName === 'processed' ? false : (real as (a: unknown) => Promise<unknown>).call(remote.client, args)) as never;
    try {
      const rec = await driveOnly(r, id, ['COMPLETED'], 10);
      expect(rec!.state).toBe('COMPLETED');
      expect(rec!.history.at(-1)!.reason).toMatch(/TransferCompleted in final receipt/);
      expect(rec!.payload.destTxHash).toBe(sentHash);
    } finally {
      (remote.client as { readContract: unknown }).readContract = real;
    }
    expect(await relayerTxs(relayerAcct.address)).toBe(txBefore);
  }, 90_000);

  it('removing a signer mid-flight: transfer is re-attested by the remaining set (review)', async () => {
    const { message } = await lock(1_500_000n);
    const id = messageId(message);
    await mine(home, Number(CONF));
    // Use the main relayer to reach PROOF_VERIFIED with signatures from the full set.
    for (let i = 0; i < 8 && recordFor(message)?.state !== 'PROOF_VERIFIED'; i++) {
      await relayer.scan(31337n);
      await relayer.tick();
    }
    expect(recordFor(message).state).toBe('PROOF_VERIFIED');
    const all = ((await read(remote, remoteVerifier, 'MessageVerifier', 'signers')) as Address[]).map((a) => a);
    const reduced = all.slice(1); // drop the lowest address — always among the cached signatures
    const rotate = async (set: Address[]) => {
      await send(remote, remoteVerifier, 'MessageVerifier', 'proposeSignerSet', [set, 2]);
      await remote.client.request({ method: 'evm_increaseTime' as never, params: [86_401] as never });
      await mine(remote, 1);
      await send(remote, remoteVerifier, 'MessageVerifier', 'executeSignerSet', []);
    };
    await rotate(reduced);
    await drive();
    const rec = recordFor(message);
    expect(rec.state, JSON.stringify(rec.history)).toBe('COMPLETED');
    expect(rec.history.some((h) => /re-attesting/.test(h.reason ?? ''))).toBe(true);
    await rotate(all); // restore the configured 3-signer set for later tests
    expect(id).toBe(rec.id);
  }, 90_000);

  it('readiness gate: a relayer submits nothing until the deployment check passes (review #4)', async () => {
    let ready = false;
    const gateAlerts: RelayerAlert[] = [];
    const r = await isolatedRelayer({ gate: { check: async () => ready, intervalMs: 0 }, onAlert: (a) => gateAlerts.push(a) });
    const txBefore = await relayerTxs(relayerAcct.address);
    const { message } = await lock(1_600_000n);
    const id = messageId(message);
    await mine(home, Number(CONF));
    for (let i = 0; i < 6; i++) {
      await r.scan(31337n);
      await r.tick();
      await mine(home, 1);
    }
    // Attested, but the forward submission is held while the gate is closed.
    expect(r.records.get(id)!.state).toBe('PROOF_VERIFIED');
    expect(r.records.get(id)!.payload.lastError).toMatch(/forward submission held/);
    expect(gateAlerts.some((a) => a.state === 'GATE' && a.level === 'critical')).toBe(true);
    expect(await relayerTxs(relayerAcct.address)).toBe(txBefore);
    ready = true;
    expect((await driveOnly(r, id, ['COMPLETED']))!.state).toBe('COMPLETED');
  }, 90_000);

  it('operator recovery: unauthorised operators are refused; an authorised one re-drives after a fix (review)', async () => {
    const t2 = await deploy(home, 'MockToken', ['Two', 'TWO', 6]);
    await send(home, vault, 'BridgeVault', 'configureToken', [t2, true, 1_000_000n, 500_000_000_000n]);
    await send(home, vault, 'BridgeVault', 'setRateLimit', [t2, 1_000_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setRefundLimit', [t2, 1_000_000_000_000n, 86_400n]);
    await send(home, vault, 'BridgeVault', 'setChainCap', [t2, 31338n, 1_000_000_000_000n]);
    await send(home, t2, 'MockToken', 'mint', [alice.address, 5_000_000n]);
    await send(home, t2, 'MockToken', 'approve', [vault, 2n ** 255n], alice);
    const hash = await send(home, vault, 'BridgeVault', 'lock', [t2, 5_000_000n, 31338n, alice.address], alice);
    const r0 = await home.client.getTransactionReceipt({ hash });
    const m = (parseEventLogs({ abi: artifact('BridgeVault').abi, logs: r0.logs, eventName: 'TransferInitiated' })[0]!.args as unknown as { message: BridgeMessage }).message;
    await mine(home, Number(CONF));
    await drive();
    expect(recordFor(m).state).toBe('RECOVERY_REQUIRED');
    expect(() => relayer.recover(recordFor(m).id, 'retry_execution', 'mallory', 'trust me')).toThrow(/not an authorised operator/);
    expect(() => relayer.recover(recordFor(m).id, 'retry_execution', 'ops-alice', ' ')).toThrow(/reason is required/);
    // Fix the configuration (governance), then re-drive.
    await send(remote, executor, 'BridgeExecutor', 'registerToken', [t2, 'Bridged TWO', 'bpTWO', 6, 1n]);
    await send(remote, executor, 'BridgeExecutor', 'setRateLimit', [t2, 1_000_000_000_000n, 86_400n]);
    await send(remote, executor, 'BridgeExecutor', 'setSupplyCap', [t2, 1_000_000_000_000n]);
    relayer.recover(recordFor(m).id, 'retry_execution', 'ops-alice', 'TWO registered on executor (change #42)');
    await drive();
    const rec = recordFor(m);
    expect(rec.state).toBe('COMPLETED');
    expect(rec.history.some((h) => /operator ops-alice: retry_execution/.test(h.reason ?? ''))).toBe(true);
  }, 90_000);

  it('attester RPC quorum: one unreachable/lying endpoint blocks signing (review: RPC independence)', async () => {
    const { message, hash } = await lock(1_700_000n);
    await mine(home, Number(CONF));
    const dead = createPublicClient({ transport: http('http://127.0.0.1:1') }) as PublicClient;
    const sameOrigin = createPublicClient({ chain: home.client.chain, transport: http(home.url) }) as PublicClient;
    const withQuorum = (extra: PublicClient[], reg: RpcProvider[] | null = registry) =>
      new Attester(ATTESTER_KEYS[0]!, new Map([...views, [31337n, { ...views.get(31337n)!, extraClients: extra, quorum: 2 }]]), routes, verifiers, { rpcProviders: reg ?? undefined });
    expect(await withQuorum([dead]).attest(message, hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/rpc quorum not met \(1\/2 independent operators/) });
    expect((await withQuorum([altClient(home)]).attest(message, hash)).ok).toBe(true);
    // Seventh review: the attester itself counts agreement per declared operator, not per connection.
    expect(await withQuorum([sameOrigin]).attest(message, hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/1\/2 independent operators .* 2 connections agree/) });
    const oneCompany: RpcProvider[] = [
      { id: 'main', operator: 'Single Company', origins: [home.url] },
      { id: 'backup', operator: 'Single Company', origins: [altUrl(home)] }, // different IP, same company
    ];
    expect(await withQuorum([altClient(home)], oneCompany).attest(message, hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/1\/2 independent operators/) });
    expect(await withQuorum([altClient(home)], null).attest(message, hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/requires a declared RPC provider registry/) });
    await drive(); // let the main relayer finish it
  }, 90_000);

  // ===================================================== third review: gate, route pause, leases

  async function lockTo(amount: bigint) {
    const { message, hash } = await lock(amount);
    return { message, hash, id: messageId(message) };
  }

  it('route pause: new transfers on the route are held, but a cancelled one is still refunded (P0)', async () => {
    const r = await isolatedRelayer();
    const a = await lockTo(2_100_000n); // will be cancelled
    const b = await lockTo(2_200_000n); // normal transfer
    await mine(home, Number(CONF));
    await send(remote, executor, 'BridgeExecutor', 'pauseRoute', [31337n], pauser);
    await send(home, vault, 'BridgeVault', 'pauseRoute', [31338n], pauser);
    const txStart = await relayerTxs(relayerAcct.address);
    await driveOnly(r, b.id, ['PAUSED']);
    await driveOnly(r, a.id, ['PAUSED']);
    expect(r.records.get(a.id)!.state).toBe('PAUSED');
    expect(r.records.get(b.id)!.state).toBe('PAUSED');
    expect(await relayerTxs(relayerAcct.address)).toBe(txStart); // nothing forwarded on the paused route

    // Recipient cancels A on the paused route (unwinding is allowed); relayer refunds it.
    const before = (await read(home, usdc, 'MockToken', 'balanceOf', [alice.address])) as bigint;
    await send(remote, executor, 'BridgeExecutor', 'cancel', [a.message, r.signaturesFor(a.id)!], alice);
    await mine(remote, Number(CONF));
    const refunded = await driveOnly(r, a.id, ['REFUNDED']);
    expect(refunded!.state, JSON.stringify(refunded!.history) + refunded!.payload.lastError).toBe('REFUNDED');
    expect(((await read(home, usdc, 'MockToken', 'balanceOf', [alice.address])) as bigint) - before).toBe(a.message.amount);
    expect(r.records.get(b.id)!.state).toBe('PAUSED'); // B is still held

    await send(remote, executor, 'BridgeExecutor', 'unpauseRoute', [31337n]);
    await send(home, vault, 'BridgeVault', 'unpauseRoute', [31338n]);
    expect((await driveOnly(r, b.id, ['COMPLETED']))!.state).toBe('COMPLETED');
  }, 120_000);

  it('closed readiness gate holds forward submissions but recovery (refund) still completes (P0)', async () => {
    const r = await isolatedRelayer({ gate: { check: async () => false, intervalMs: 0 }, devMode: undefined, store: new SqliteRelayerStore(join(mkdtempSync(join(tmpdir(), 'bp-gate-')), 'g.sqlite')) });
    const a = await lockTo(2_300_000n);
    await mine(home, Number(CONF));
    const rec = await driveOnly(r, a.id, ['PROOF_VERIFIED']);
    expect(rec!.state).toBe('PROOF_VERIFIED');
    for (let i = 0; i < 3; i++) await r.tick();
    expect(r.records.get(a.id)!.state).toBe('PROOF_VERIFIED'); // held
    await send(remote, executor, 'BridgeExecutor', 'cancel', [a.message, r.signaturesFor(a.id)!], alice);
    await mine(remote, Number(CONF));
    expect((await driveOnly(r, a.id, ['REFUNDED']))!.state).toBe('REFUNDED');
  }, 120_000);

  it('two connections to the SAME provider are not independent: a real reorg is not auto-rejected (fifth review P0)', async () => {
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const cfg = chainsFor(relayerAcct, sh + 1n, sr + 1n);
    const sameHost = createPublicClient({ chain: home.client.chain, transport: http(home.url) }) as PublicClient; // 2nd connection, same provider
    cfg.set(31337n, { ...cfg.get(31337n)!, proofClients: [sameHost] });
    const r = new Relayer(cfg, attesters, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const snap = (await home.client.request({ method: 'evm_snapshot' as never })) as Hex;
    const { id } = await lockTo(1_300_000n);
    await r.scan(31337n);
    await home.client.request({ method: 'evm_revert' as never, params: [snap] as never });
    await mine(home, Number(CONF) + 1);
    for (let i = 0; i < 5; i++) await r.tick();
    const rec = r.records.get(id)!;
    expect(rec.state).toBe('SOURCE_PENDING'); // refuses to decide on non-independent evidence
    expect(rec.payload.lastError).toMatch(/only 1 independent source operator\(s\) \(2 connections/);
  }, 60_000);

  it('a name alias declared as a different operator is merged by shared IP: no auto-reject (sixth review P0)', async () => {
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const cfg = chainsFor(relayerAcct, sh + 1n, sr + 1n);
    const aliasUrl = home.url.replace('127.0.0.1', 'localhost'); // same node, different name
    cfg.set(31337n, { ...cfg.get(31337n)!, proofClients: [createPublicClient({ chain: home.client.chain, transport: http(aliasUrl) }) as PublicClient] });
    const lyingRegistry: RpcProvider[] = [
      { id: 'op-one', operator: 'Operator One (test)', origins: [home.url, remote.url] },
      { id: 'op-claimed', operator: 'Some Other Company', origins: [aliasUrl] }, // declared independent — it is not
    ];
    const r = new Relayer(cfg, attesters, { rpcProviders: lyingRegistry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    // Same connections, but the alias is simply missing from the registry:
    const r2 = new Relayer(cfg, attesters, { rpcProviders: [lyingRegistry[0]!], store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const snap = (await home.client.request({ method: 'evm_snapshot' as never })) as Hex;
    const { id } = await lockTo(1_350_000n);
    await r.scan(31337n);
    await r2.scan(31337n);
    await home.client.request({ method: 'evm_revert' as never, params: [snap] as never });
    await mine(home, Number(CONF) + 1);
    for (let i = 0; i < 5; i++) await Promise.all([r.tick(), r2.tick()]);
    const rec = r.records.get(id)!;
    expect(rec.state).toBe('SOURCE_PENDING');
    expect(rec.payload.lastError).toMatch(/merged by shared IPs: operator one \(test\)\+some other company/);
    expect(r2.records.get(id)!.state).toBe('SOURCE_PENDING');
    expect(r2.records.get(id)!.payload.lastError).toMatch(/not counted: .*localhost.*not declared in the RPC provider registry/);
  }, 60_000);

  it('a transfer that was locked and later REFUNDED is never rejected when state is lost and re-scanned (fifth review P1)', async () => {
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const first = await isolatedRelayer();
    const a = await lockTo(1_700_000n);
    await mine(home, Number(CONF));
    expect((await driveOnly(first, a.id, ['PROOF_VERIFIED']))!.state).toBe('PROOF_VERIFIED');
    await send(remote, executor, 'BridgeExecutor', 'cancel', [a.message, first.signaturesFor(a.id)!], alice);
    await mine(remote, Number(CONF));
    expect((await driveOnly(first, a.id, ['REFUNDED']))!.state).toBe('REFUNDED');
    expect(await read(home, vault, 'BridgeVault', 'initiated', [a.id])).toBe(false); // same value as "never locked"

    // A fresh relayer (state lost) re-scans the old event; its main RPC cannot find the receipt.
    const cfg = chainsFor(relayerAcct, sh + 1n, sr + 1n);
    cfg.set(31337n, { ...cfg.get(31337n)!, client: receiptless(home.client) });
    const fresh = new Relayer(cfg, attesters, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    await fresh.scan(31337n);
    for (let i = 0; i < 6; i++) {
      await fresh.tick();
      await mine(home, 1);
    }
    const rec = fresh.records.get(a.id)!;
    expect(rec.state).not.toBe('REJECTED');
    expect(rec.payload.lastError).toMatch(/later REFUNDED/);
    // With an honest RPC the same fresh relayer classifies it correctly as REFUNDED (no second refund).
    const honest = new Relayer(chainsFor(relayerAcct, sh + 1n, sr + 1n), attesters, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const before = await relayerTxs(relayerAcct.address);
    expect((await driveOnly(honest, a.id, ['REFUNDED']))!.state).toBe('REFUNDED');
    expect(await relayerTxs(relayerAcct.address)).toBe(before);
  }, 120_000);

  it('never sends after losing the lease, even when its record version is still current (lease is the only barrier)', async () => {
    // Another instance took the lease but has not written yet: the CAS version check alone would
    // let the stale owner through. Only the lease re-check right before broadcast stops it.
    const store = new MemoryRelayerStore<never>();
    let id = '';
    let stolen = false;
    const r = await isolatedRelayer({
      store: store as never,
      leaseTtlMs: 40,
      testHooks: {
        disableLeaseRenewal: true,
        beforeBroadcast: async (kind) => {
          if (kind !== 'destination' || stolen) return;
          await sleep(80); // our lease expires...
          expect(store.tryLease(id, 'other-relayer', 60_000, Date.now())).toBe(true); // ...and another instance takes it
          stolen = true;
        },
      },
    });
    const a = await lockTo(1_100_000n);
    id = a.id;
    await mine(home, Number(CONF));
    const before = await relayerTxs(relayerAcct.address);
    for (let i = 0; i < 8 && !stolen; i++) {
      await r.scan(31337n);
      await r.tick();
      await Promise.all([mine(home, 1), mine(remote, 1)]);
    }
    expect(stolen).toBe(true);
    expect(r.stats.leaseLostBeforeSend).toBe(1);
    expect(await relayerTxs(relayerAcct.address)).toBe(before); // nothing was broadcast
    expect(store.load(id)!.state).toBe('PROOF_VERIFIED'); // and nothing was persisted as "sent"
    expect((store.load(id)!.payload as unknown as { destTxHash?: string }).destTxHash).toBeUndefined();
    // The transfer is not lost: the legitimate relayer completes it.
    await drive();
    expect(relayer.records.get(id)!.state).toBe('COMPLETED');
  }, 60_000);

  it('a relayer cannot be built without a gate outside local dev, nor in dev mode on public chains (P0)', () => {
    expect(() => new Relayer(chainsCfg, attesters, {})).toThrow(/requires a readiness gate/);
    const sepoliaLike = new Map([[11155111n, { ...chainsCfg.get(31337n)!, chainId: 11155111n }]]);
    expect(() => new Relayer(sepoliaLike, attesters, { devMode: true })).toThrow(/only allowed when every chain is a local/);
    const durable = () => new SqliteRelayerStore<never>(join(mkdtempSync(join(tmpdir(), 'bp-ctor-')), 'c.sqlite'));
    expect(() => new Relayer(sepoliaLike, attesters, { gate: { check: async () => true }, store: durable() })).not.toThrow();
  });

  it('a production relayer refuses a non-durable store (fourth review P1)', () => {
    const sepoliaLike = new Map([[11155111n, { ...chainsCfg.get(31337n)!, chainId: 11155111n }]]);
    const gate = { check: async () => true };
    expect(() => new Relayer(sepoliaLike, attesters, { gate })).toThrow(/requires a durable store/);
    expect(() => new Relayer(sepoliaLike, attesters, { gate, store: new MemoryRelayerStore() })).toThrow(/requires a durable store/);
    expect(() => new Relayer(sepoliaLike, attesters, { gate, store: new SqliteRelayerStore(':memory:') as never })).toThrow(/requires a durable store/);
    // Even on local chains, a gated (non-dev) relayer needs a durable store:
    expect(() => new Relayer(chainsCfg, attesters, { gate, store: new MemoryRelayerStore() })).toThrow(/requires a durable store/);
  });

  async function twoRelayers(ttl: number, aHooks: NonNullable<ConstructorParameters<typeof Relayer>[2]>['testHooks']) {
    const acctB = privateKeyToAccount(generatePrivateKey());
    for (const n of [home, remote]) await n.client.request({ method: 'anvil_setBalance' as never, params: [acctB.address, '0x56BC75E2D63100000'] as never });
    const db = join(mkdtempSync(join(tmpdir(), 'bp-lease-')), 'r.sqlite');
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const A = new Relayer(chainsFor(relayerAcct, sh + 1n, sr + 1n), attesters, { store: new SqliteRelayerStore(db), ownerId: 'A', devMode: true, leaseTtlMs: ttl, testHooks: aHooks });
    const B = new Relayer(chainsFor(acctB, sh + 1n, sr + 1n), attesters, { store: new SqliteRelayerStore(db), ownerId: 'B', devMode: true, leaseTtlMs: ttl });
    return { A, B, acctB, db };
  }
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (const renewal of [true, false]) {
    it(`a step slower than the lease TTL never causes a second submission (renewal ${renewal ? 'on' : 'off → CAS'}) (P1)`, async () => {
      let slowed = false;
      const { A, B, acctB, db } = await twoRelayers(100, {
        disableLeaseRenewal: !renewal,
        beforeBroadcast: async () => {
          if (!slowed) {
            slowed = true;
            await sleep(450); // > 4x the lease TTL
          }
        },
      });
      const x = await lockTo(2_400_000n);
      await mine(home, Number(CONF));
      for (let i = 0; i < 8 && A.records.get(x.id)?.state !== 'PROOF_VERIFIED'; i++) {
        await A.scan(31337n);
        await A.tick();
      }
      expect(A.records.get(x.id)!.state).toBe('PROOF_VERIFIED');
      const before = (await relayerTxs(relayerAcct.address)) + (await relayerTxs(acctB.address));
      await sleep(150); // A's lease from the pre-ticks expires
      const aRun = A.tick(); // A enters the slow broadcast
      for (let i = 0; i < 6; i++) {
        await sleep(70);
        await B.scan(31337n);
        await B.tick(); // B races A while A is stalled
      }
      await aRun;
      for (let i = 0; i < 12 && new SqliteRelayerStore<never>(db).load(x.id)!.state !== 'COMPLETED'; i++) {
        await Promise.all([A.tick(), B.tick()]);
        await Promise.all([mine(home, 1), mine(remote, 1)]);
      }
      expect(new SqliteRelayerStore<never>(db).load(x.id)!.state).toBe('COMPLETED');
      const after = (await relayerTxs(relayerAcct.address)) + (await relayerTxs(acctB.address));
      expect(after - before).toBe(1); // exactly one destination transaction
      expect(slowed).toBe(true);
      // Prove the race really happened the way we claim (non-vacuous):
      const sent = await remote.client.getTransaction({ hash: (new SqliteRelayerStore<never>(db).load(x.id)! as unknown as { payload: { destTxHash: Hex } }).payload.destTxHash });
      if (renewal) {
        expect(sent.from.toLowerCase()).toBe(relayerAcct.address.toLowerCase()); // A kept the lease throughout
        expect(A.stats.superseded).toBe(0);
      } else {
        expect(sent.from.toLowerCase()).toBe(acctB.address.toLowerCase()); // B took over the expired lease
        expect(A.stats.superseded).toBeGreaterThanOrEqual(1); // A's late send was refused (lease lost or stale write)
      }
    }, 120_000);
  }

  it('the gate checks the RUNNING attesters: quorum 1, a missing RPC or an undeclared endpoint closes it (P1)', async () => {
    const homeAlt = altClient(home);
    const remoteAlt = altClient(remote);
    const make = (quorum: number, extra: boolean) =>
      ATTESTER_KEYS.map(
        (k) =>
          new Attester(
            k,
            new Map([
              [31337n, { ...views.get(31337n)!, extraClients: extra ? [homeAlt] : [], quorum }],
              [31338n, { ...views.get(31338n)!, extraClients: extra ? [remoteAlt] : [], quorum }],
            ]),
            routes,
            verifiers,
            { rpcProviders: registry },
          ),
      );
    /** Declared RPCs per chain: `pick` selects the URLs for each node. */
    const declared = (pick: (n: Node) => string[]) =>
      ATTESTER_KEYS.map((k, i) => ({ name: `att-${i}`, address: privateKeyToAccount(k).address, operator: `Org ${i}`, keyCustody: 'hsm' as const, rpcUrls: { '31337': pick(home), '31338': pick(remote) } }));
    const both = (n: Node) => [n.url, altUrl(n)];
    const signerAddrs = ATTESTER_KEYS.map((k) => privateKeyToAccount(k).address);
    const onchain = new Map([
      [31337n, { signers: (await read(home, homeVerifier, 'MessageVerifier', 'signers')) as string[], threshold: Number(await read(home, homeVerifier, 'MessageVerifier', 'threshold')) }],
      [31338n, { signers: (await read(remote, remoteVerifier, 'MessageVerifier', 'signers')) as string[], threshold: Number(await read(remote, remoteVerifier, 'MessageVerifier', 'threshold')) }],
    ]);
    expect(onchain.get(31337n)!.signers.length).toBe(signerAddrs.length);
    const fails = async (atts: Attester[], decl: ReturnType<typeof declared>, reg: RpcProvider[] = registry) =>
      (await checkAttesterRuntime(atts, decl, [31337n, 31338n], { onchain, rpcProviders: reg })).filter((f) => !f.ok).map((f) => f.message);
    expect(await fails(make(2, true), declared(both))).toEqual([]);
    // Only 2 of the 3 on-chain signers running (still >= threshold): the gate stays closed.
    expect((await fails(make(2, true).slice(1), declared(both))).some((m) => /running attesters == on-chain signer set/.test(m))).toBe(true);
    // A running attester whose key is not in the on-chain signer set:
    const stranger = new Attester(generatePrivateKey(), new Map([[31337n, { ...views.get(31337n)!, extraClients: [homeAlt], quorum: 2 }], [31338n, { ...views.get(31338n)!, extraClients: [remoteAlt], quorum: 2 }]]), routes, verifiers, { rpcProviders: registry });
    const withStranger = [...make(2, true).slice(1), stranger];
    const declStranger = [...declared(both).slice(1), { name: 'x', address: stranger.address, operator: 'Org X', keyCustody: 'hsm' as const, rpcUrls: { '31337': both(home), '31338': both(remote) } }];
    expect((await fails(withStranger, declStranger)).some((m) => /running attester is a current on-chain signer/.test(m))).toBe(true);
    // The relayer's own RPCs (receipts + "nothing locked" proofs) are part of operational health:
    expect((await checkRelayerRpcs(relayer.runtimeRpcConfig(), { rpcProviders: relayer.rpcProviders })).filter((f) => !f.ok)).toEqual([]);
    const single = new Relayer(new Map([...chainsCfg].map(([k, v]) => [k, { ...v, proofClients: [] }])), attesters, { devMode: true, rpcProviders: registry });
    expect((await checkRelayerRpcs(single.runtimeRpcConfig(), { rpcProviders: registry })).some((f) => !f.ok && /distinct providers/.test(f.message))).toBe(true);
    expect((await checkRelayerRpcs(relayer.runtimeRpcConfig())).some((f) => !f.ok && /registry configured/.test(f.message))).toBe(true);
    // An alias of the same node (localhost == 127.0.0.1) declared as ANOTHER company is merged by IP:
    const alias = (n: Node) => n.url.replace('127.0.0.1', 'localhost');
    const aliasReg: RpcProvider[] = [...registry, { id: 'claimed-other', operator: 'Claimed Other Co', origins: [alias(home), alias(remote)] }];
    const aliasAtt = ATTESTER_KEYS.map((k) => new Attester(k, new Map([
      [31337n, { ...views.get(31337n)!, extraClients: [createPublicClient({ chain: home.client.chain, transport: http(alias(home)) }) as PublicClient], quorum: 2 }],
      [31338n, { ...views.get(31338n)!, extraClients: [remoteAlt], quorum: 2 }],
    ]), routes, verifiers, { rpcProviders: aliasReg }));
    const declAlias = declared((n) => [n.url, alias(n), altUrl(n)]);
    expect((await fails(aliasAtt, declAlias, aliasReg)).some((m) => /merged by shared IPs/.test(m))).toBe(true);
    // Two endpoints with DIFFERENT IPs (127.0.0.1 / 127.0.0.2) that belong to ONE company: one vote.
    const oneCo: RpcProvider[] = [
      { id: 'main', operator: 'Single Company', origins: [home.url, remote.url] },
      { id: 'backup', operator: 'Single Company', origins: [altUrl(home), altUrl(remote)] },
    ];
    const oneCoAtt = ATTESTER_KEYS.map((k) => new Attester(k, new Map([
      [31337n, { ...views.get(31337n)!, extraClients: [homeAlt], quorum: 2 }],
      [31338n, { ...views.get(31338n)!, extraClients: [remoteAlt], quorum: 2 }],
    ]), routes, verifiers, { rpcProviders: oneCo }));
    expect((await fails(oneCoAtt, declared(both), oneCo)).some((m) => /1 independent, 2 connections, quorum 2/.test(m))).toBe(true);
    // The running attesters must count with the SAME registry as the deployment:
    expect((await fails(oneCoAtt, declared(both))).some((m) => /registry agrees with the deployment registry/.test(m))).toBe(true);
    expect((await fails(make(1, false), declared(both))).some((m) => /operational quorum >= 2 \(is 1\)/.test(m))).toBe(true);
    expect((await fails(make(2, false), declared(both))).some((m) => /enough connections from distinct providers/.test(m))).toBe(true); // an RPC removed
    expect((await fails(make(2, true), declared((n) => [n.url]))).some((m) => /undeclared/.test(m))).toBe(true);
    expect((await fails(make(2, true), declared(both).slice(1))).some((m) => /declared in the deployment config/.test(m))).toBe(true);
  }, 60_000);

  it('final accounting holds on both chains', async () => {
    const locked = (await read(home, vault, 'BridgeVault', 'totalLocked', [usdc])) as bigint;
    expect(await read(home, vault, 'BridgeVault', 'lockedFor', [usdc, 31338n])).toBe(locked);
    const fees = (await read(home, vault, 'BridgeVault', 'accruedFees', [usdc])) as bigint;
    const bal = (await read(home, usdc, 'MockToken', 'balanceOf', [vault])) as bigint;
    const supply = (await read(remote, wrapped, 'BridgeToken', 'totalSupply')) as bigint;
    expect(bal).toBe(locked + fees);
    expect(supply).toBe(locked); // nothing in flight
  });

  it('deployment verifier refuses an EOA-administered deployment and accepts timelock + multisig', async () => {
    // TEST stand-in exposing a Safe proxy's read interface (singleton in slot 0, owners, threshold,
    // modules). It is not a multisig; it lets every governance check run on a local chain.
    const SINGLETON = '0x00000000000000000000000000000000005afe14' as Address;
    const owners = [KEYS[4]!, ATTESTER_KEYS[0]!, ATTESTER_KEYS[1]!].map(() => privateKeyToAccount(generatePrivateKey()).address);
    const multisigHome = await deploy(home, 'MockSafe', [SINGLETON, owners, 2n]);
    const safeCode = (await home.client.getCode({ address: multisigHome }))!;
    // Same address on both chains (as with Safe's CREATE2 factory): copy code AND storage.
    await remote.client.request({ method: 'anvil_setCode' as never, params: [multisigHome, safeCode] as never });
    const ownersBase = BigInt(keccak256(pad('0x01')));
    const slots = [0n, 1n, 2n, 3n, ...owners.map((_, i) => ownersBase + BigInt(i))].map((x) => toHex(x, { size: 32 }));
    for (const slot of slots) {
      const v = await home.client.getStorageAt({ address: multisigHome, slot });
      await remote.client.request({ method: 'anvil_setStorageAt' as never, params: [multisigHome, slot, v] as never });
    }
    const DELAY = 172_800n; // project floor: 2 days
    const tlHome = await deploy(home, 'TimelockController', [DELAY, [multisigHome], [multisigHome], '0x0000000000000000000000000000000000000000']);
    const tlRemote = await deploy(remote, 'TimelockController', [DELAY, [multisigHome], [multisigHome], '0x0000000000000000000000000000000000000000']);
    const multisigPolicy = { owners, threshold: 2, allowedSingletons: [SINGLETON], allowedProxyCodeHashes: [keccak256(safeCode)] };

    const cfg: DeploymentConfig = {
      home: { chainId: 31337, vault, verifier: homeVerifier, timelock: tlHome, deployBlock: 0 },
      remotes: [{ chainId: 31338, executor, verifier: remoteVerifier, timelock: tlRemote, deployBlock: 0 }],
      governance: { multisig: multisigHome, pauser: pauser.address, minTimelockDelaySec: 86_400, deployer: deployer.address, multisigPolicy },
      signers: { addresses: ATTESTER_KEYS.map((k) => privateKeyToAccount(k).address), threshold: 2, minRotationDelaySec: 86_400 },
      tokens: [{ canonical: usdc, decimals: 6, maxChainCap: '10000000000000' }],
      damagePolicy: { reactionTimeSec: 3600 },
      attesters: [
        { name: 'att-1', address: privateKeyToAccount(ATTESTER_KEYS[0]!).address, operator: 'Org A', keyCustody: 'hsm', rpcUrls: { '31337': ['https://eth.alpha-rpc.example', 'https://node.beta-infra.example'], '31338': ['https://l2.alpha-rpc.example', 'https://l2.gamma-nodes.example'] } },
        { name: 'att-2', address: privateKeyToAccount(ATTESTER_KEYS[1]!).address, operator: 'Org B', keyCustody: 'kms', rpcUrls: { '31337': ['https://eth.delta-rpc.example', 'https://node.epsilon.example'], '31338': ['https://l2.delta-rpc.example', 'https://l2.zeta-nodes.example'] } },
        { name: 'att-3', address: privateKeyToAccount(ATTESTER_KEYS[2]!).address, operator: 'Org C', keyCustody: 'hsm', rpcUrls: { '31337': ['https://eth.eta-rpc.example', 'https://node.theta.example'], '31338': ['https://l2.eta-rpc.example', 'https://l2.iota-nodes.example'] } },
      ],
    };
    // Declared RPC providers for the attesters' (example) endpoints: one operator per company domain.
    cfg.rpcProviders = cfg.attesters!.flatMap((x) => Object.values(x.rpcUrls).flat()).map((u, i) => ({ id: `rpc-${i}`, operator: new URL(u).hostname.split('.').slice(-2).join('.'), origins: [u] }));
    const clients = new Map<number, PublicClient>([[31337, home.client], [31338, remote.client]]);
    const failing = async (c: DeploymentConfig) => (await verifyDeployment(c, clients)).checks.filter((x) => !x.ok).map((x) => x.name);

    // ---- one injected fault per readiness condition: each must be caught by its own check
    // (both verifiers share an address: same deployer + nonce on both chains, so use a truly different contract)
    expect(await failing({ ...cfg, home: { ...cfg.home, verifier: usdc } })).toContain('BridgeVault uses the configured verifier');
    expect(await failing({ ...cfg, remotes: [{ ...cfg.remotes[0]!, executor: alice.address }] })).toContain('vault peer points to this executor');
    expect(await failing({ ...cfg, tokens: [{ canonical: usdc, decimals: 18 }] })).toEqual(expect.arrayContaining(['canonical decimals match config', 'wrapped decimals == canonical decimals']));
    expect(await failing({ ...cfg, tokens: [{ canonical: usdc, decimals: 6, maxChainCap: '1000' }] })).toEqual(expect.arrayContaining(['vault: per-chain cap configured', 'executor: supply cap configured']));
    const bare = await deploy(home, 'MockToken', ['Bare', 'BARE', 6]);
    expect(await failing({ ...cfg, tokens: [{ canonical: bare, decimals: 6 }] })).toEqual(
      expect.arrayContaining(['vault: refund (recovery) limit configured', 'vault: per-chain cap configured', 'executor: wrapped token registered', 'vault: rate limit configured']),
    );
    expect(await failing({ ...cfg, attesters: undefined })).toContain('attester deployment described (operators, key custody, RPCs)');
    const sameOrg = cfg.attesters!.map((a) => ({ ...a, operator: 'Org A' }));
    expect((await failing({ ...cfg, attesters: sameOrg })).some((n) => /distinct operator/.test(n))).toBe(true);
    expect((await failing({ ...cfg, rpcProviders: undefined })).some((n) => /registry \(rpcProviders\) missing/.test(n))).toBe(true);
    const fileKey = cfg.attesters!.map((a, i) => (i === 0 ? { ...a, keyCustody: 'file' as const } : a));
    expect((await failing({ ...cfg, attesters: fileKey })).some((n) => /stored in a file/.test(n))).toBe(true);
    // Route pause is OPERATIONAL: reported, but it must not close the deployment gate (refunds go on).
    await send(home, vault, 'BridgeVault', 'pauseRoute', [31338n], pauser);
    const paused = await verifyDeployment(cfg, clients);
    expect(paused.operational.filter((c) => !c.ok).map((c) => c.name)).toContain('vault: route to this chain not paused');
    expect(paused.checks.map((c) => c.name)).not.toContain('vault: route to this chain not paused');
    const failingWhilePaused = await failing(cfg);
    await send(home, vault, 'BridgeVault', 'unpauseRoute', [31338n]);
    expect(failingWhilePaused).toEqual(await failing(cfg)); // pausing changed nothing about readiness
    // Damage policy is mandatory and enforced against caps AND rate limits.
    expect(await failing({ ...cfg, damagePolicy: undefined })).toContain('damage policy defined (incident reaction time)');
    expect(await failing({ ...cfg, tokens: [{ canonical: usdc, decimals: 6 }] })).toEqual(
      expect.arrayContaining(['maximum acceptable loss (maxChainCap) defined for token', 'vault: per-chain cap configured', 'executor: supply cap configured']),
    );
    // Caps fit, but at this reaction time the transfer limit could drain more than the budget:
    const slow = await failing({ ...cfg, damagePolicy: { reactionTimeSec: 86_400 * 30 } });
    expect(slow).toEqual(expect.arrayContaining(['vault transfer limit: worst-case outflow before reaction <= maxChainCap', 'executor transfer limit: worst-case outflow before reaction <= maxChainCap']));
    // timelocks with dangerous powers
    const tlAdminLeft = await deploy(home, 'TimelockController', [DELAY, [multisigHome], [multisigHome], deployer.address]);
    expect(await failing({ ...cfg, home: { ...cfg.home, timelock: tlAdminLeft } })).toContain(`timelock: ${deployer.address.slice(0, 10)}… is not timelock admin`);
    const tlOpenExec = await deploy(home, 'TimelockController', [DELAY, [multisigHome], ['0x0000000000000000000000000000000000000000'], '0x0000000000000000000000000000000000000000']);
    expect(await failing({ ...cfg, home: { ...cfg.home, timelock: tlOpenExec } })).toContain('timelock execution is not open to everyone');
    const tlShort = await deploy(home, 'TimelockController', [60n, [multisigHome], [multisigHome], '0x0000000000000000000000000000000000000000']);
    expect((await failing({ ...cfg, home: { ...cfg.home, timelock: tlShort } })).some((n) => /timelock delay >=/.test(n))).toBe(true);
    // The PROJECT floor (2 days) applies even if the config file asks for less:
    const tlOneDay = await deploy(home, 'TimelockController', [86_400n, [multisigHome], [multisigHome], '0x0000000000000000000000000000000000000000']);
    expect(await failing({ ...cfg, governance: { ...cfg.governance, minTimelockDelaySec: 60 }, home: { ...cfg.home, timelock: tlOneDay } })).toContain('timelock delay >= 172800s (project floor 172800s)');

    // ---- the multisig must really be the expected Safe (fourth review)
    const msFails = async (gov: Partial<DeploymentConfig['governance']>) => failing({ ...cfg, governance: { ...cfg.governance, ...gov } });
    expect(await msFails({ multisigPolicy: undefined })).toContain('multisig policy defined (owners, threshold, accepted Safe code)');
    expect(await msFails({ multisigPolicy: { ...multisigPolicy, owners: [...owners.slice(0, 2), alice.address] } })).toContain('multisig owners == policy');
    expect(await msFails({ multisigPolicy: { ...multisigPolicy, threshold: 3 } })).toContain('multisig threshold == policy');
    expect(await msFails({ multisigPolicy: { ...multisigPolicy, allowedSingletons: [alice.address] } })).toContain('multisig singleton is an accepted Safe version');
    expect(await msFails({ multisigPolicy: { ...multisigPolicy, allowedProxyCodeHashes: [keccak256('0x00')] } })).toContain('multisig runtime code is an accepted Safe proxy');
    const oneOfOne = await deploy(home, 'MockSafe', [SINGLETON, [alice.address], 1n]);
    expect(await msFails({ multisig: oneOfOne, multisigPolicy: { ...multisigPolicy, owners: [alice.address], threshold: 1 } })).toContain(
      'multisig meets project floor (>= 2 of >= 3, strict majority)',
    );
    const withModule = await deploy(home, 'MockSafe', [SINGLETON, owners, 2n]);
    await send(home, withModule, 'MockSafe', 'enableModuleForTest', [alice.address]);
    expect(await msFails({ multisig: withModule })).toContain('multisig has no enabled modules (a module bypasses the threshold)');
    expect(await msFails({ multisig: alice.address })).toContain('multisig is a contract (not an EOA)');

    const before = await verifyDeployment(cfg, clients);
    expect(before.ready).toBe(false);
    const failed = before.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('BridgeVault admin is the timelock');
    expect(failed.some((n) => /holds no direct admin/.test(n))).toBe(true);
    // Wiring itself is already correct:
    for (const n of ['executor points to the home vault', 'vault peer points to this executor', 'signer set matches config', 'executor: rate limit configured']) {
      expect(failed, n).not.toContain(n);
    }

    // Hand admin to the timelocks and renounce the deployer's rights everywhere — but leave ONE extra,
    // unknown admin on the vault. Probing known addresses (timelock, multisig, deployer, pauser) cannot
    // see it; the event-reconstructed holder set must.
    const ADMIN = `0x${'00'.repeat(32)}`;
    const hidden = privateKeyToAccount(generatePrivateKey());
    await home.client.request({ method: 'anvil_setBalance' as never, params: [hidden.address, '0x56BC75E2D63100000'] as never });
    await send(home, vault, 'BridgeVault', 'grantRole', [ADMIN, hidden.address]);
    for (const [n, addr, name, tl] of [
      [home, vault, 'BridgeVault', tlHome], [home, homeVerifier, 'MessageVerifier', tlHome],
      [remote, executor, 'BridgeExecutor', tlRemote], [remote, remoteVerifier, 'MessageVerifier', tlRemote],
    ] as [Node, Address, string, Address][]) {
      await send(n, addr, name, 'grantRole', [ADMIN, tl]);
      await send(n, addr, name, 'renounceRole', [ADMIN, deployer.address]);
    }
    const withHidden = (await verifyDeployment(cfg, clients)).checks.filter((c) => !c.ok);
    expect(withHidden.map((c) => c.name)).toEqual(['BridgeVault: DEFAULT_ADMIN holders exactly as policy']);
    expect(withHidden[0]!.detail).toContain(hidden.address);
    await send(home, vault, 'BridgeVault', 'renounceRole', [ADMIN, hidden.address], hidden);
    // A wrong deployment block (history starts after the grants) is detected, not silently trusted:
    const head = Number(await home.client.getBlockNumber());
    const late = await failing({ ...cfg, home: { ...cfg.home, deployBlock: head } });
    for (const label of ['BridgeVault', 'MessageVerifier', 'Timelock']) expect(late).toContain(`${label}: did not exist before deployBlock (role history complete)`);
    // An admin granted BEFORE a too-late deployBlock is outside the history, yet still caught:
    const early = privateKeyToAccount(generatePrivateKey());
    const v2 = await deploy(home, 'BridgeVault', [deployer.address, pauser.address, homeVerifier, 10, deployer.address]);
    await send(home, v2, 'BridgeVault', 'grantRole', [ADMIN, early.address]);
    await send(home, v2, 'BridgeVault', 'grantRole', [ADMIN, tlHome]);
    await send(home, v2, 'BridgeVault', 'renounceRole', [ADMIN, deployer.address]);
    const afterGrants = Number(await home.client.getBlockNumber()) + 1;
    await mine(home, 1);
    const hiddenEarly = await failing({ ...cfg, home: { ...cfg.home, vault: v2, deployBlock: afterGrants } });
    expect(hiddenEarly).toContain('BridgeVault: did not exist before deployBlock (role history complete)');
    const after = await verifyDeployment(cfg, clients);
    expect(after.checks.filter((c) => !c.ok), JSON.stringify(after.checks.filter((c) => !c.ok))).toEqual([]);
    expect(after.ready).toBe(true);
    // And the deployer really lost control.
    await expect(send(home, vault, 'BridgeVault', 'setFee', [5, deployer.address])).rejects.toThrow();
  }, 90_000);

  it('upgrade path: router -> signer set, then one-way upgrade to signers AND proof; relayer plugs the prover in (verifier upgrade)', async () => {
    // An isolated vault/executor pair whose executor verifies through a VerifierRouter.
    const WEEK = 7 * 86_400;
    const router = await deploy(remote, 'VerifierRouter', [deployer.address, pauser.address, BigInt(WEEK)]);
    await send(remote, router, 'VerifierRouter', 'initRoute', [31337n, remoteVerifier]);
    const exec2 = await deploy(remote, 'BridgeExecutor', [deployer.address, pauser.address, router, 31337n]);
    const vault2 = await deploy(home, 'BridgeVault', [deployer.address, pauser.address, homeVerifier, 10, deployer.address]);
    await send(remote, exec2, 'BridgeExecutor', 'registerToken', [usdc, 'Bridged USDC', 'bpUSDC', 6, 1n]);
    await send(remote, exec2, 'BridgeExecutor', 'setHomeVault', [vault2]);
    await send(remote, exec2, 'BridgeExecutor', 'setRateLimit', [usdc, 1_000_000_000_000n, 86_400n]);
    await send(remote, exec2, 'BridgeExecutor', 'setRefundLimit', [usdc, 100_000_000_000n, 86_400n]);
    await send(remote, exec2, 'BridgeExecutor', 'setSupplyCap', [usdc, 10_000_000_000_000n]);
    await send(home, vault2, 'BridgeVault', 'configureToken', [usdc, true, 1_000_000n, 500_000_000_000n]);
    await send(home, vault2, 'BridgeVault', 'setPeer', [31338n, exec2]);
    await send(home, vault2, 'BridgeVault', 'setRateLimit', [usdc, 1_000_000_000_000n, 86_400n]);
    await send(home, vault2, 'BridgeVault', 'setRefundLimit', [usdc, 100_000_000_000n, 86_400n]);
    await send(home, vault2, 'BridgeVault', 'setChainCap', [usdc, 31338n, 10_000_000_000_000n]);
    await send(home, usdc, 'MockToken', 'approve', [vault2, 2n ** 255n], alice);
    const routes2 = new Map([
      [31337n, new Map([[vault2.toLowerCase(), [{ destChainId: 31338n, destContract: exec2 }]]])],
      [31338n, new Map([[exec2.toLowerCase(), [{ destChainId: 31337n, destContract: vault2 }]]])],
    ]);
    const atts2 = ATTESTER_KEYS.map((k) => new Attester(k, views, routes2, verifiers));
    const [sh, sr] = await Promise.all([home.client.getBlockNumber(), remote.client.getBlockNumber()]);
    const pair = (proofBuilder?: RelayerChain['proofBuilder']) => {
      const base = chainsFor(relayerAcct, sh + 1n, sr + 1n);
      return new Map<bigint, RelayerChain>([
        [31337n, { ...base.get(31337n)!, bridge: vault2 }],
        [31338n, { ...base.get(31338n)!, bridge: exec2, proofBuilder }], // signatures still checked against remoteVerifier
      ]);
    };
    const lock2 = async (amount: bigint) => {
      const hash = await send(home, vault2, 'BridgeVault', 'lock', [usdc, amount, 31338n, alice.address], alice);
      const r = await home.client.getTransactionReceipt({ hash });
      const m = (parseEventLogs({ abi: artifact('BridgeVault').abi, logs: r.logs, eventName: 'TransferInitiated' })[0]!.args as unknown as { message: BridgeMessage }).message;
      return messageId(m);
    };

    // 1) signer-set route works end to end through the router
    const R = new Relayer(pair(), atts2, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const id1 = await lock2(3_000_000n);
    await mine(home, Number(CONF));
    expect((await driveOnly(R, id1, ['COMPLETED']))!.state).toBe('COMPLETED');

    // Gate: router checks pass with the signer verifier's code hash allowlisted.
    const signerHash = keccak256((await remote.client.getCode({ address: remoteVerifier }))!);
    const gateCfg = {
      home: { chainId: 31337, vault: vault2, verifier: homeVerifier, timelock: deployer.address, deployBlock: 0 },
      remotes: [{ chainId: 31338, executor: exec2, verifier: remoteVerifier, timelock: deployer.address, deployBlock: 0, verifierRouter: router }],
      governance: { multisig: deployer.address, pauser: pauser.address, minTimelockDelaySec: 0 },
      signers: { addresses: ATTESTER_KEYS.map((k) => privateKeyToAccount(k).address), threshold: 2, minRotationDelaySec: 86_400 },
      tokens: [],
      verifierPolicy: { allowedCodeHashes: [signerHash] },
    } as DeploymentConfig;
    const clients = new Map<number, PublicClient>([[31337, home.client], [31338, remote.client]]);
    const routerFails = async (c: DeploymentConfig = gateCfg) => {
      const r = await verifyDeployment(c, clients);
      return { failed: r.checks.filter((x) => !x.ok && /VerifierRouter|verifier policy|uses the configured verifier/.test(x.name)).map((x) => x.name), operational: r.operational.filter((x) => !x.ok).map((x) => x.name) };
    };
    expect((await routerFails()).failed).toEqual([]);
    expect((await routerFails({ ...gateCfg, verifierPolicy: { allowedCodeHashes: [keccak256('0x01')] } })).failed).toContain('VerifierRouter route 31337: active verifier code is audited (allowlisted hash)');

    // 2) propose the upgrade to AND(signers, proof): public, delayed; un-audited => gate holds forward flow
    const proofV = await deploy(remote, 'MockProofVerifier', []);
    const composite = await deploy(remote, 'CompositeVerifier', [[remoteVerifier, proofV]]);
    await send(remote, router, 'VerifierRouter', 'proposeUpgrade', [31337n, composite]);
    const pend = await routerFails();
    expect(pend.operational).toContain('VerifierRouter route 31337: no pending verifier upgrade');
    expect(pend.failed).toContain('VerifierRouter route 31337: pending upgrade is an audited verifier (else guardian must veto)');
    await expect(send(remote, router, 'VerifierRouter', 'activateUpgrade', [31337n])).rejects.toThrow(); // delay not over
    const compositeHash = keccak256((await remote.client.getCode({ address: composite }))!);
    const auditedCfg = { ...gateCfg, verifierPolicy: { allowedCodeHashes: [signerHash, compositeHash] } } as DeploymentConfig;
    expect((await routerFails(auditedCfg)).failed).toEqual([]);
    await remote.client.request({ method: 'evm_increaseTime' as never, params: [WEEK] as never });
    await mine(remote, 1);
    await send(remote, router, 'VerifierRouter', 'activateUpgrade', [31337n]);
    expect(await read(remote, router, 'VerifierRouter', 'minLevel', [31337n])).toBe(3);
    // Now the gate expects the composite as the active verifier:
    const after = { ...auditedCfg, remotes: [{ ...auditedCfg.remotes[0]!, activeVerifier: composite }] } as DeploymentConfig;
    expect((await routerFails(after)).failed).toEqual([]);

    // 3) no way back: governance cannot even PROPOSE the signer-only verifier again
    await expect(send(remote, router, 'VerifierRouter', 'proposeUpgrade', [31337n, remoteVerifier])).rejects.toThrow();

    // 4) signatures alone no longer move funds; the relayer needs the prover plugged in
    const noProver = new Relayer(pair(), atts2, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const id2 = await lock2(2_000_000n);
    await mine(home, Number(CONF));
    expect((await driveOnly(noProver, id2, ['RECOVERY_REQUIRED', 'COMPLETED']))!.state).toBe('RECOVERY_REQUIRED');
    expect(await read(remote, exec2, 'BridgeExecutor', 'processed', [id2])).toBe(false);
    const prover: RelayerChain['proofBuilder'] = async (m, sigs) => [
      encodeAbiParameters([{ type: 'bytes[]' }], [sigs]),
      encodeAbiParameters([{ type: 'bytes[]' }], [[encodeAbiParameters([{ type: 'bytes32' }], [messageId(m)])]]),
    ];
    const withProver = new Relayer(pair(prover), atts2, { rpcProviders: registry, store: new MemoryRelayerStore(), reorgMargin: 4n, devMode: true });
    const id3 = await lock2(2_500_000n);
    await mine(home, Number(CONF));
    expect((await driveOnly(withProver, id3, ['COMPLETED', 'RECOVERY_REQUIRED']))!.state).toBe('COMPLETED');
  }, 120_000);
});

describe('transfer state machine', () => {
  it('allows only the specified transitions', () => {
    expect(canTransition('CREATED', 'SOURCE_PENDING')).toBe(true);
    expect(canTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(canTransition('SOURCE_PENDING', 'PROOF_VERIFIED')).toBe(false);
    expect(canTransition('COMPLETED', 'PROOF_VERIFIED')).toBe(false);
    expect(canTransition('REJECTED', 'SOURCE_PENDING')).toBe(false);
    const r = new TransferRecord('x', {}, 0);
    expect(() => r.move('DESTINATION_PENDING', 1)).toThrow(IllegalTransition);
    r.move('SOURCE_PENDING', 1);
    r.move('SOURCE_FINALIZED', 2);
    r.move('PROOF_VERIFIED', 3);
    r.move('PAUSED', 4);
    r.move('PROOF_VERIFIED', 5);
    r.move('COMPLETED', 6);
    expect(r.terminal).toBe(true);
  });
});
