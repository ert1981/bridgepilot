import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { providerContext } from '../src/agents/discovery-agent.js';
import { AcrossAdapter } from '../src/providers/across-adapter.js';
import { LifiAdapter } from '../src/providers/lifi-adapter.js';
import { ProviderError } from '../src/utils/errors.js';
import { fetchJson } from '../src/utils/http.js';
import { req } from './engine-fixtures.js';
import { acrossFeesFixture, acrossRoute, lifiQuoteFixture, lifiQuoteRoute, makeServices, mockFetch, RECIPIENT, rpcRoute, SENDER } from './helpers.js';

describe('LI.FI adapter', () => {
  const lifi = new LifiAdapter();

  it('normalises a quote and splits included vs extra fees', async () => {
    const log: string[] = [];
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture({ feeExtraUsd: '0.05' }))], log });
    const [q] = await lifi.quote(req({ sender: SENDER, recipient: RECIPIENT }), providerContext(svc));
    expect(q!.expectedOutput).toBe(99_720_000n);
    expect(q!.minOutput).toBe(99_221_400n);
    expect(q!.includedFees.map((f) => f.usdMicro)).toEqual([280_000n]);
    expect(q!.extraCosts.map((f) => [f.kind, f.usdMicro])).toEqual([['fee', 50_000n], ['gas', 6_000n]]);
    expect(q!.executionAvailable).toBe(true);
    expect(q!.tool).toBe('across');
    expect(q!.priceHints?.output).toBe(999_900n);
    expect(log[0]).toBe('GET li.quest/v1/quote');
  });

  it('sends the right query parameters', async () => {
    let seen: URL | undefined;
    const svc = makeServices({ routes: [(u) => { seen = u; return lifiQuoteRoute(lifiQuoteFixture())(u); }] });
    await lifi.quote(req({ sender: SENDER, recipient: RECIPIENT, constraints: { max_slippage_bps: 30 } }), providerContext(svc));
    const p = seen!.searchParams;
    expect(p.get('fromChain')).toBe('8453');
    expect(p.get('toChain')).toBe('42161');
    expect(p.get('fromAmount')).toBe('100000000');
    expect(p.get('fromAddress')).toBe(SENDER);
    expect(p.get('toAddress')).toBe(RECIPIENT);
    expect(p.get('slippage')).toBe('0.003');
    expect(p.get('integrator')).toBe('bridgepilot');
  });

  it('is quote-only without a sender', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture())] });
    const [q] = await lifi.quote(req(), providerContext(svc));
    expect(q!.executionAvailable).toBe(false);
    expect(q!.warnings.join(' ')).toMatch(/without sender/);
  });

  it('maps 404 to NO_ROUTE and garbage to BAD_RESPONSE', async () => {
    const s1 = makeServices({ routes: [lifiQuoteRoute({ message: 'No available quotes' }, 404)] });
    await expect(lifi.quote(req(), providerContext(s1))).rejects.toMatchObject({ code: 'NO_ROUTE' });
    const s2 = makeServices({ routes: [lifiQuoteRoute({ estimate: { toAmount: 'abc' } })] });
    await expect(lifi.quote(req(), providerContext(s2))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const s3 = makeServices({ routes: [(u) => (u.host === 'li.quest' ? { status: 200, body: 'not json{' } : undefined)] });
    await expect(lifi.quote(req(), providerContext(s3))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('builds the transaction from the quote', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture())] });
    const r = req({ sender: SENDER, recipient: RECIPIENT });
    const [q] = await lifi.quote(r, providerContext(svc));
    const tx = await lifi.buildTransaction(q!, r, providerContext(svc));
    expect(tx).toMatchObject({ chainId: 8453, value: 0n, gasLimit: 0x3f7a0n });
  });

  it('maps status responses', async () => {
    const svc = makeServices({ routes: [(u) => (u.pathname === '/v1/status' ? { status: 200, body: { status: 'DONE', substatus: 'COMPLETED', sending: { txHash: '0xa' }, receiving: { txHash: '0xb', amount: '99700000' } } } : undefined)] });
    const s = await lifi.status({ txHash: '0x' + 'a'.repeat(64), sourceChainId: 8453, destinationChainId: 42161, tool: 'across' }, providerContext(svc));
    expect(s).toMatchObject({ state: 'DONE', destinationTxHash: '0xb', receivedAmount: 99_700_000n });
    const svc2 = makeServices({ routes: [(u) => (u.pathname === '/v1/status' ? { status: 200, body: { status: 'DONE', substatus: 'REFUNDED' } } : undefined)] });
    expect((await lifi.status({ txHash: '0x1', sourceChainId: 8453, destinationChainId: 42161 }, providerContext(svc2))).state).toBe('REFUNDED');
  });
});

describe('Across adapter', () => {
  const across = new AcrossAdapter();

  it('normalises suggested-fees and estimates origin gas', async () => {
    const svc = makeServices({ routes: [acrossRoute(acrossFeesFixture()), rpcRoute(10_000_000n)] });
    const [q] = await across.quote(req({ sender: SENDER, recipient: RECIPIENT }), providerContext(svc));
    expect(q!.expectedOutput).toBe(99_880_000n);
    expect(q!.minOutput).toBe(99_880_000n);
    expect(q!.estimatedTimeSeconds).toBe(2);
    expect(q!.limits).toEqual({ minInput: 500_000n, maxInput: 5_000_000_000_000n });
    // 120k gas * 0.01 gwei = 1.2e15 wei... at $3000/ETH = $0.0036
    expect(q!.extraCosts[0]!.usdMicro).toBe(3_600n);
    expect(q!.includedFees[0]!.token!.amount).toBe('120000');
    expect(q!.executionAvailable).toBe(false); // disabled by default
  });

  it('falls back to amount - totalRelayFee when outputAmount is absent', async () => {
    const svc = makeServices({ routes: [acrossRoute(acrossFeesFixture({ outputAmount: null, total: '150000' })), rpcRoute()] });
    const [q] = await across.quote(req(), providerContext(svc));
    expect(q!.expectedOutput).toBe(99_850_000n);
  });

  it('keeps gas unpriced (null) when the RPC is unreachable', async () => {
    const svc = makeServices({ routes: [acrossRoute(acrossFeesFixture())] });
    const [q] = await across.quote(req(), providerContext(svc));
    expect(q!.extraCosts[0]!.usdMicro).toBeNull();
  });

  it('does not support native or cross-asset pairs', () => {
    expect(across.supports(req({ source_token: 'ETH', destination_token: 'ETH' })).ok).toBe(false);
    expect(across.supports(req({ source_token: 'USDC', destination_token: 'WETH' })).ok).toBe(false);
  });

  it('encodes depositV3 when execution is enabled', async () => {
    const svc = makeServices({ env: { ACROSS_EXECUTION_ENABLED: 'true' }, routes: [acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const r = req({ sender: SENDER, recipient: RECIPIENT });
    const [q] = await across.quote(r, providerContext(svc));
    const tx = await across.buildTransaction(q!, r, providerContext(svc));
    const abi = parseAbi(['function depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)']);
    const decoded = decodeFunctionData({ abi, data: tx.data });
    expect(decoded.args[4]).toBe(100_000_000n);
    expect(decoded.args[5]).toBe(99_880_000n);
    expect(decoded.args[6]).toBe(42161n);
  });
});

describe('http helper', () => {
  it('retries transient errors and stops on 4xx', async () => {
    let n = 0;
    const flaky = mockFetch([() => (++n < 3 ? { status: 503, body: {} } : { status: 200, body: { ok: true } })]);
    expect(await fetchJson('https://x.test/a', { provider: 't', fetch: flaky, timeoutMs: 200, retries: 2, retryBaseDelayMs: 1 })).toEqual({ ok: true });
    let m = 0;
    const bad = mockFetch([() => { m++; return { status: 400, body: { message: 'bad' } }; }]);
    await expect(fetchJson('https://x.test/a', { provider: 't', fetch: bad, timeoutMs: 200, retries: 2, retryBaseDelayMs: 1 })).rejects.toBeInstanceOf(ProviderError);
    expect(m).toBe(1);
  });

  it('times out slow providers', async () => {
    const slow = (_: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(fetchJson('https://x.test/a', { provider: 't', fetch: slow, timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects oversized responses', async () => {
    const big = mockFetch([() => ({ status: 200, body: { x: 'a'.repeat(5000) } })]);
    await expect(fetchJson('https://x.test/a', { provider: 't', fetch: big, timeoutMs: 200, maxBytes: 1000 })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
