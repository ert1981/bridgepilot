import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { isFinal, PROTOCOL_CHAINS, protocolChain } from '../protocol/finality.js';
import { MemoryRelayerStore, SqliteRelayerStore } from '../protocol/relayer-store.js';
import { canTransition, TransferRecord } from '../protocol/state-machine.js';
import { refundOf, type BridgeMessage } from '../protocol/types.js';

const fakeClient = (head: bigint, finalized: bigint | null) =>
  ({
    getBlockNumber: async () => head,
    getBlock: async ({ blockTag }: { blockTag?: string }) => {
      if (blockTag !== 'finalized') throw new Error('unexpected');
      return { number: finalized };
    },
  }) as unknown as PublicClient;

describe('per-chain finality', () => {
  it('finalized-tag uses the RPC finalized block, not local depth', async () => {
    // Block 100 is 50 deep on the L2 but its L1 batch is not finalized yet.
    expect(await isFinal(fakeClient(150n, 90n), 100n, { kind: 'finalized-tag' })).toBe(false);
    expect(await isFinal(fakeClient(150n, 100n), 100n, { kind: 'finalized-tag' })).toBe(true);
    expect(await isFinal(fakeClient(150n, null), 100n, { kind: 'finalized-tag' })).toBe(false);
  });

  it('depth policy counts confirmations', async () => {
    expect(await isFinal(fakeClient(102n, null), 100n, { kind: 'depth', confirmations: 3n })).toBe(false);
    expect(await isFinal(fakeClient(103n, null), 100n, { kind: 'depth', confirmations: 3n })).toBe(true);
  });

  it('every supported chain has an explicit policy; public testnets never use plain depth', () => {
    for (const c of PROTOCOL_CHAINS.filter((x) => x.status === 'supported')) {
      expect(c.finality, c.name).toBeDefined();
      if (c.chainId < 31337n || c.chainId > 31339n) expect(c.finality!.kind, c.name).toBe('finalized-tag');
    }
    expect(PROTOCOL_CHAINS.find((c) => c.family === 'solana')?.status).toBe('unsupported');
    expect(protocolChain(1n)).toBeUndefined(); // mainnet is not a protocol chain
  });
});

describe('durable relayer store', () => {
  const msg: BridgeMessage = {
    version: 1, kind: 0, sourceChainId: 11155111n, sourceContract: '0x1111111111111111111111111111111111111111',
    destChainId: 84532n, destContract: '0x2222222222222222222222222222222222222222', nonce: 7n,
    canonicalToken: '0x3333333333333333333333333333333333333333', sender: '0x4444444444444444444444444444444444444444',
    recipient: '0x5555555555555555555555555555555555555555', amount: (1n << 200n) + 1n,
  };

  for (const [name, make] of [
    ['memory', () => new MemoryRelayerStore()],
    ['sqlite', () => new SqliteRelayerStore(join(mkdtempSync(join(tmpdir(), 'bp-')), 'r.sqlite'))],
  ] as const) {
    it(`${name}: round-trips records (incl. huge bigints) and checkpoints`, () => {
      const store = make();
      const rec = new TransferRecord('id1', { message: msg, sourceTxHash: '0xabc', messageId: '0xdef' }, 1000);
      rec.move('SOURCE_PENDING', 1001, 'seen');
      store.save({ id: rec.id, state: rec.state, attempts: 2, history: rec.history, payload: rec.payload });
      store.setCheckpoint(84532n, 123456789n);
      const [back] = store.loadAll();
      const restored = TransferRecord.restore(back!);
      expect(restored.state).toBe('SOURCE_PENDING');
      expect(restored.attempts).toBe(2);
      expect((restored.payload as { message: BridgeMessage }).message.amount).toBe((1n << 200n) + 1n);
      expect(store.getCheckpoint(84532n)).toBe(123456789n);
      expect(store.getCheckpoint(1n)).toBeUndefined();
    });
  }
});

describe('refund message and states', () => {
  it('refundOf reverses direction and pays the sender', () => {
    const o: BridgeMessage = {
      version: 1, kind: 0, sourceChainId: 1n, sourceContract: '0x1111111111111111111111111111111111111111', destChainId: 2n,
      destContract: '0x2222222222222222222222222222222222222222', nonce: 9n, canonicalToken: '0x3333333333333333333333333333333333333333',
      sender: '0x4444444444444444444444444444444444444444', recipient: '0x5555555555555555555555555555555555555555', amount: 10n,
    };
    const r = refundOf(o);
    expect(r).toMatchObject({ kind: 2, sourceChainId: 2n, destChainId: 1n, recipient: o.sender, amount: 10n, nonce: 9n });
    expect(r.sourceContract).toBe(o.destContract);
    expect(r.destContract).toBe(o.sourceContract);
  });

  it('a completed transfer can never become cancelled or refunded', () => {
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'COMPLETED')).toBe(false);
    expect(canTransition('REFUNDED', 'CANCELLED')).toBe(false);
    expect(canTransition('RECOVERY_REQUIRED', 'CANCELLED')).toBe(true);
    expect(canTransition('CANCELLED', 'REFUNDED')).toBe(true);
  });
});

import { checkAttesterIndependence, probeFinalityRpc, type AttesterDeployment } from '../protocol/attester-config.js';

describe('attester independence and RPC probes', () => {
  const good: AttesterDeployment[] = [
    { name: 'a', operator: 'Org A', keyCustody: 'hsm', rpcUrls: { '1': ['https://x.alchemy.example', 'https://y.quicknode.example'] } },
    { name: 'b', operator: 'Org B', keyCustody: 'kms', rpcUrls: { '1': ['https://x.infura.example', 'https://y.ankr.example'] } },
    { name: 'c', operator: 'Org C', keyCustody: 'hsm', rpcUrls: { '1': ['https://x.blast.example', 'https://y.drpc.example'] } },
  ];
  const regOf = (urls: string[], operatorFor: (u: string) => string = (u) => new URL(u).hostname.split('.').slice(-2).join('.')) =>
    urls.map((u, i) => ({ id: `p${i}`, operator: operatorFor(u), origins: [u] }));
  const goodReg = regOf(good.flatMap((a) => a.rpcUrls['1']!));
  it('accepts independent operators, hardware keys and diverse providers', () => {
    expect(checkAttesterIndependence(good, 2, 2, goodReg).filter((f) => f.severity === 'error')).toEqual([]);
  });
  it('without a provider registry, or with an unregistered endpoint, RPC independence is an error', () => {
    expect(checkAttesterIndependence(good, 2).some((f) => f.severity === 'error' && /registry \(rpcProviders\) missing/.test(f.message))).toBe(true);
    const partial = goodReg.slice(1);
    expect(checkAttesterIndependence(good, 2, 2, partial).some((f) => f.severity === 'error' && /not in the provider registry: https:\/\/x.alchemy.example/.test(f.message))).toBe(true);
  });
  it('two domains with different IPs owned by ONE operator count as one RPC vote (seventh review)', () => {
    const oneCompany = regOf(good.flatMap((a) => a.rpcUrls['1']!), (u) => (/alchemy|quicknode/.test(u) ? 'Same Corp' : u));
    expect(checkAttesterIndependence(good, 2, 2, oneCompany).some((f) => f.severity === 'error' && /a: chain 1 has 1 independent RPC operator/.test(f.message))).toBe(true);
  });
  it('flags one operator controlling the threshold, file keys, single-provider RPC and shared providers', () => {
    const bad: AttesterDeployment[] = good.map((a, i) => ({
      ...a,
      operator: i < 2 ? 'Org A' : a.operator,
      keyCustody: i === 2 ? 'file' : a.keyCustody,
      rpcUrls: { '1': ['https://one.shared.example', 'https://two.shared.example'] },
    }));
    const msgs = checkAttesterIndependence(bad, 3, 2, regOf(['https://one.shared.example', 'https://two.shared.example'])).map((f) => `${f.severity}:${f.message}`);
    expect(msgs.some((m) => /^error:.*distinct operator/.test(m))).toBe(true);
    expect(msgs.some((m) => /^error:.*stored in a file/.test(m))).toBe(true);
    expect(msgs.some((m) => /^error:.*1 independent RPC operator/.test(m))).toBe(true);
    expect(msgs.some((m) => /^warning:.*RPC operator shared.example is used by 3/.test(m))).toBe(true);
  });
  it('probes the finalized tag: missing, ahead of latest, or stalled endpoints are rejected', async () => {
    const client = (latest: bigint, fin: bigint | null | 'throw') =>
      ({
        getBlockNumber: async () => latest,
        getBlock: async () => {
          if (fin === 'throw') throw new Error('unknown block tag');
          return { number: fin };
        },
      }) as unknown as PublicClient;
    const pol = { kind: 'finalized-tag' } as const;
    expect(await probeFinalityRpc(client(1000n, 950n), pol, 200n)).toEqual([]);
    expect((await probeFinalityRpc(client(1000n, 1001n), pol, 200n))[0]!.message).toMatch(/ahead of latest/);
    expect((await probeFinalityRpc(client(1000n, 100n), pol, 200n))[0]!.message).toMatch(/stalled/);
    expect((await probeFinalityRpc(client(1000n, null), pol, 200n))[0]!.message).toMatch(/does not report/);
    expect((await probeFinalityRpc(client(1000n, 'throw'), pol, 200n))[0]!.message).toMatch(/does not support/);
  });
});

describe('EXPIRED is recoverable', () => {
  it('EXPIRED is not terminal and can resume or be proven empty', () => {
    const r = new TransferRecord('x', {}, 0);
    r.move('SOURCE_PENDING', 1);
    r.move('EXPIRED', 2);
    expect(r.terminal).toBe(false);
    expect(canTransition('EXPIRED', 'SOURCE_FINALIZED')).toBe(true);
    expect(canTransition('EXPIRED', 'REJECTED')).toBe(true);
    expect(canTransition('EXPIRED', 'CANCELLED')).toBe(false); // time alone never authorises a refund
    expect(canTransition('EXPIRED', 'REFUNDED')).toBe(false);
  });
});

describe('relayer store leases', () => {
  for (const [name, make] of [
    ['memory', () => new MemoryRelayerStore()],
    ['sqlite', () => new SqliteRelayerStore(join(mkdtempSync(join(tmpdir(), 'bp-')), 'l.sqlite'))],
  ] as const) {
    it(`${name}: one owner at a time; expiry hands over; checkpoint never goes back`, () => {
      const s = make();
      expect(s.tryLease('t', 'A', 1000, 0)).toBe(true);
      expect(s.tryLease('t', 'B', 1000, 500)).toBe(false);
      expect(s.tryLease('t', 'A', 1000, 600)).toBe(true); // renewal
      expect(s.tryLease('t', 'B', 1000, 1700)).toBe(true); // expired -> B
      s.releaseLease('t', 'A'); // not the owner: no effect
      expect(s.tryLease('t', 'A', 1000, 1800)).toBe(false);
      s.setCheckpoint(1n, 100n);
      s.setCheckpoint(1n, 90n);
      expect(s.getCheckpoint(1n)).toBe(100n);
    });
  }
});

import { checkAttesterRuntime } from '../protocol/attester-config.js';
import { independentOperators, validateRegistry, type Resolver } from '../protocol/rpc-providers.js';
/** Test DNS: every hostname gets its own address unless listed in SHARED. */
const SHARED: Record<string, string> = { 'eth.alias-of-one.example': '10.0.0.1', 'a.one.example': '10.0.0.1' };
/** Registry for the runtime unit tests: operator by registrable domain. */
const UREG = ['https://a.one.example', 'https://x.one.example', 'https://b.two.example'].map((u, i) => ({ id: `u${i}`, operator: u.split('.').slice(-2).join('.'), origins: [u] }));
const fakeDns: Resolver = async (h) => [SHARED[h] ?? `10.1.${h.length}.${[...h].reduce((a, c) => (a + c.charCodeAt(0)) % 250, 1)}`];
import { StaleRecordError } from '../protocol/relayer-store.js';
import { worstCaseOutflow } from '../protocol/verify-deployment.js';

describe('third review: runtime gate probes, CAS writes, damage budget', () => {
  const fake = (url: string, latest: bigint, fin: bigint) =>
    ({ transport: { url }, getBlockNumber: async () => latest, getBlock: async () => ({ number: fin }) }) as unknown as PublicClient;
  const att = (clients: PublicClient[], quorum: number) => ({
    address: '0x00000000000000000000000000000000000000a1',
    rpcProviders: UREG,
    runtimeConfig: () => [{ chainId: 11155111n, rpcs: clients.map((client) => ({ endpoint: (client.transport as unknown as { url?: string }).url, client })), quorum, finality: { kind: 'finalized-tag' as const } }],
  });
  const onchain = new Map([[11155111n, { signers: ['0x00000000000000000000000000000000000000a1'], threshold: 1 }]]);
  const decl = [{ name: 'a', address: '0x00000000000000000000000000000000000000a1', operator: 'A', keyCustody: 'hsm' as const, rpcUrls: { '11155111': ['https://a.one.example', 'https://b.two.example'] } }];

  it('the gate probes every endpoint the running attester uses', async () => {
    const healthy = att([fake('https://a.one.example', 1000n, 990n), fake('https://b.two.example', 1000n, 990n)], 2);
    expect((await checkAttesterRuntime([healthy], decl, [11155111n], { onchain, resolver: fakeDns, rpcProviders: UREG })).filter((f) => !f.ok)).toEqual([]);
    const stalled = att([fake('https://a.one.example', 1000n, 990n), fake('https://b.two.example', 100_000n, 10n)], 2);
    const bad = (await checkAttesterRuntime([stalled], decl, [11155111n], { onchain, resolver: fakeDns, rpcProviders: UREG })).filter((f) => !f.ok).map((f) => f.message);
    expect(bad.some((m) => /endpoint #1 .*finality signal sane: .*stalled/.test(m))).toBe(true);
    expect((await checkAttesterRuntime([], decl, [11155111n], { onchain, resolver: fakeDns, rpcProviders: UREG })).some((f) => !f.ok && /no running attesters/.test(f.message))).toBe(true);
  });

  for (const [name, make] of [
    ['memory', () => new MemoryRelayerStore()],
    ['sqlite', () => new SqliteRelayerStore(join(mkdtempSync(join(tmpdir(), 'bp-')), 'v.sqlite'))],
  ] as const) {
    it(`${name}: a write based on an old version is rejected`, () => {
      const s = make();
      const base = { id: 'r', state: 'SOURCE_PENDING' as const, attempts: 0, history: [], payload: {} };
      expect(s.insertIfAbsent(base)).toBe(true);
      const v1 = s.load('r')!.version!;
      const v2 = s.save({ ...base, state: 'SOURCE_FINALIZED', version: v1 }); // instance X advances
      expect(v2).toBe(v1 + 1);
      expect(() => s.save({ ...base, state: 'REJECTED', version: v1 })).toThrow(StaleRecordError); // instance Y is stale
      expect(s.load('r')!.state).toBe('SOURCE_FINALIZED');
    });
  }

  it('worst-case outflow = full bucket + refill during the reaction time', () => {
    expect(worstCaseOutflow(1000n, 86_400n, 3_600n)).toBe(1041n);
    expect(worstCaseOutflow(1000n, 86_400n, 86_400n * 2n)).toBe(3000n);
    expect(worstCaseOutflow(0n, 86_400n, 3_600n)).toBe(0n);
  });
});

describe('fourth review: signer-set binding, endpoint identity, durable store', () => {
  const fake = (url: string | undefined) =>
    ({ transport: url ? { url } : {}, getBlockNumber: async () => 1000n, getBlock: async () => ({ number: 990n }) }) as unknown as PublicClient;
  const A = '0x00000000000000000000000000000000000000a1';
  const B = '0x00000000000000000000000000000000000000b2';
  const C = '0x00000000000000000000000000000000000000c3';
  const urls = { '11155111': ['https://a.one.example', 'https://b.two.example'] };
  const declare = (addrs: string[]) => addrs.map((address, i) => ({ name: `n${i}`, address, operator: `O${i}`, keyCustody: 'hsm' as const, rpcUrls: urls }));
  const run = (address: string, endpoints: (string | undefined)[] = ['https://a.one.example', 'https://b.two.example']) => ({
    address,
    rpcProviders: UREG,
    runtimeConfig: () => [{ chainId: 11155111n, rpcs: endpoints.map((e) => ({ endpoint: e, client: fake(e) })), quorum: 2, finality: { kind: 'finalized-tag' as const } }],
  });
  const onchain = new Map([[11155111n, { signers: [A, B, C], threshold: 2 }]]);
  const fails = async (r: ReturnType<typeof run>[], d = declare([A, B, C]), o: typeof onchain | null = onchain) =>
    (await checkAttesterRuntime(r, d, [11155111n], { onchain: o ?? undefined, resolver: fakeDns, rpcProviders: UREG })).filter((f) => !f.ok).map((f) => f.message);

  it('passes only when the running set is exactly the on-chain signer set', async () => {
    expect(await fails([run(A), run(B), run(C)])).toEqual([]);
  });
  it('one attester missing at runtime closes the gate (even though 2 >= threshold)', async () => {
    expect((await fails([run(A), run(B)])).some((m) => /running attesters == on-chain signer set \(running 2, on-chain 3\)/.test(m))).toBe(true);
  });
  it('a running attester that is not an on-chain signer closes the gate', async () => {
    const D = '0x00000000000000000000000000000000000000d4';
    const f = await fails([run(A), run(B), run(D)], declare([A, B, D]));
    expect(f.some((m) => /running attester is a current on-chain signer/.test(m))).toBe(true);
    expect(f.some((m) => /declared attesters == on-chain signer set/.test(m))).toBe(true);
  });
  it('duplicate running attesters and a missing on-chain read close the gate', async () => {
    expect((await fails([run(A), run(A), run(B)])).some((m) => /no duplicate running attester/.test(m))).toBe(true);
    expect((await fails([run(A), run(B), run(C)], declare([A, B, C]), null)).some((m) => /on-chain signer sets supplied/.test(m))).toBe(true);
  });
  it('a connection without a knowable endpoint identity, or two connections to one provider, fail', async () => {
    expect((await fails([run(A, ['https://a.one.example', undefined]), run(B), run(C)])).some((m) => /known endpoint identity/.test(m))).toBe(true);
    expect((await fails([run(A, ['https://a.one.example', 'https://x.one.example']), run(B), run(C)])).some((m) => /distinct providers/.test(m))).toBe(true);
  });
  it('MemoryRelayerStore and :memory: SQLite are not durable', () => {
    expect(new MemoryRelayerStore().durable).toBe(false);
    expect(new SqliteRelayerStore(':memory:').durable).toBe(false);
    expect(new SqliteRelayerStore(join(mkdtempSync(join(tmpdir(), 'bp-')), 'd.sqlite')).durable).toBe(true);
  });
});

describe('sixth review: declared RPC provider identity', () => {
  const reg = [
    { id: 'alpha', operator: 'Alpha Inc', origins: ['https://a.one.example'] },
    { id: 'beta', operator: 'Beta GmbH', origins: ['https://b.two.example', 'https://b2.two.example'] },
    { id: 'alpha-alt', operator: 'Alpha Inc', origins: ['https://c.three.example'] },
    { id: 'gamma', operator: 'Gamma Ltd', origins: ['https://eth.alias-of-one.example'] },
  ];
  it('counts independent declared OPERATORS, not domains or connections', async () => {
    expect((await independentOperators(['https://a.one.example', 'https://b.two.example'], reg, fakeDns)).independent).toBe(2);
    // two domains of one operator = one
    expect((await independentOperators(['https://a.one.example', 'https://c.three.example'], reg, fakeDns)).independent).toBe(1);
    // two origins of one provider = one
    expect((await independentOperators(['https://b.two.example', 'https://b2.two.example'], reg, fakeDns)).independent).toBe(1);
  });
  it('undeclared origins (or a different port/scheme) are never counted', async () => {
    const r = await independentOperators(['https://a.one.example', 'https://evil.example', 'http://b.two.example', 'https://b.two.example:8443', undefined], reg, fakeDns);
    expect(r.independent).toBe(1);
    expect(r.uncounted.map((u) => u.why)).toEqual([
      'origin not declared in the RPC provider registry',
      'origin not declared in the RPC provider registry',
      'origin not declared in the RPC provider registry',
      'no knowable endpoint identity',
    ]);
  });
  it('declared-distinct operators that resolve to a common IP are merged (localhost vs 127.0.0.1 case)', async () => {
    const r = await independentOperators(['https://a.one.example', 'https://eth.alias-of-one.example'], reg, fakeDns);
    expect(r.independent).toBe(1);
    expect(r.groups).toEqual([['alpha inc', 'gamma ltd']]);
    const real = [
      { id: 'x', operator: 'X', origins: ['http://127.0.0.1:8545'] },
      { id: 'y', operator: 'Y', origins: ['http://localhost:8545'] },
    ];
    expect((await independentOperators(['http://127.0.0.1:8545', 'http://localhost:8545'], real)).independent).toBe(1); // real DNS
  });
  it('an unresolvable hostname is not counted', async () => {
    const r = await independentOperators(['https://a.one.example'], reg, async () => { throw new Error('ENOTFOUND'); });
    expect(r.counted).toBe(0);
    expect(r.uncounted[0]!.why).toBe('hostname does not resolve');
  });
  it('registry validation rejects ambiguous or incomplete declarations', () => {
    expect(validateRegistry(reg)).toEqual([]);
    expect(validateRegistry([...reg, { id: 'dup', operator: 'D', origins: ['https://A.ONE.example/'] }])).toEqual(['origin https://a.one.example declared under both alpha and dup']);
    expect(validateRegistry([{ id: 'alpha', operator: '', origins: ['nope'] }, { id: 'alpha', operator: 'A', origins: [] }])).toEqual(
      expect.arrayContaining(['provider alpha: operator missing', 'provider alpha: invalid origin nope', 'duplicate provider id alpha']),
    );
  });
});

describe('seventh review: attester RPC quorum is counted per declared operator', () => {
  const fake = (url: string) => ({ transport: { url }, getBlockNumber: async () => 1000n, getBlock: async () => ({ number: 990n }) }) as unknown as PublicClient;
  const A = '0x00000000000000000000000000000000000000a1';
  const onchain = new Map([[11155111n, { signers: [A], threshold: 1 }]]);
  const urls = ['https://rpc.alpha-cloud.example', 'https://eth.alpha-backup.example'];
  const decl = [{ name: 'a', address: A, operator: 'O', keyCustody: 'hsm' as const, rpcUrls: { '11155111': urls } }];
  const att = (reg: typeof UREG) => ({
    address: A,
    rpcProviders: reg,
    runtimeConfig: () => [{ chainId: 11155111n, rpcs: urls.map((u) => ({ endpoint: u, client: fake(u) })), quorum: 2, finality: { kind: 'finalized-tag' as const } }],
  });
  const fails = async (deployReg: typeof UREG | undefined, attReg: typeof UREG) =>
    (await checkAttesterRuntime([att(attReg)], decl, [11155111n], { onchain, resolver: fakeDns, rpcProviders: deployReg })).filter((f) => !f.ok).map((f) => f.message);
  const twoCompanies = [
    { id: 'alpha', operator: 'Alpha Cloud', origins: [urls[0]!] },
    { id: 'beta', operator: 'Beta Nodes', origins: [urls[1]!] },
  ];
  const oneCompany = [
    { id: 'alpha', operator: 'Alpha Cloud', origins: [urls[0]!] },
    { id: 'alpha-backup', operator: 'Alpha Cloud', origins: [urls[1]!] }, // different domain AND different IP, same company
  ];
  it('two domains with different IPs of one operator are ONE vote: gate closed', async () => {
    expect(await fails(twoCompanies, twoCompanies)).toEqual([]);
    expect((await fails(oneCompany, oneCompany)).some((m) => /1 independent, 2 connections, quorum 2/.test(m))).toBe(true);
  });
  it('no registry, or a running attester whose registry disagrees with the deployment, closes the gate', async () => {
    expect((await fails(undefined, twoCompanies)).some((m) => /RPC provider registry supplied/.test(m))).toBe(true);
    expect((await fails(oneCompany, twoCompanies)).some((m) => /registry agrees with the deployment registry \(differs for/.test(m))).toBe(true);
    expect((await fails(twoCompanies, [])).some((m) => /counts its RPC quorum with a provider registry/.test(m))).toBe(true);
  });
});
