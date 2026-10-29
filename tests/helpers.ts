import { loadConfig, type AppConfig } from '../src/config/env.js';
import { StaticPriceOracle, priceKey, resolveRequestPrices, type PriceOracle, type RequestPrices } from '../src/providers/price-oracle.js';
import type { ResolvedRequest } from '../src/schemas/quote.schema.js';
import { createServices, type Services } from '../src/services.js';
import type { FetchLike } from '../src/utils/http.js';
import { ASSETS } from '../src/config/assets.js';
import { MICRO } from '../src/utils/units.js';
import { encodeAbiParameters } from 'viem';

export const SENDER = '0x1111111111111111111111111111111111111111';
export const RECIPIENT = '0x2222222222222222222222222222222222222222';
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
export const BASE_SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ PROVIDER_RETRIES: '0', PROVIDER_TIMEOUT_MS: '500', REQUEST_BUDGET_MS: '3000', QUOTE_CACHE_TTL_MS: '0', ...env });
}

export function staticPrices(overrides: Record<string, bigint> = {}) {
  const table: Record<string, bigint> = {};
  for (const a of ASSETS) table[priceKey(a.chainId, a.address)] = a.peg === 'USD' ? MICRO : a.peg === 'ETH' ? 3000n * MICRO : 400_000n;
  return new StaticPriceOracle({ ...table, ...overrides }, 'test_static');
}

export type Route = (url: URL, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown } | undefined> | undefined;

/** Fake network: routes are tried in order; unmatched requests fail like a refused connection. */
export function mockFetch(routes: Route[], log: string[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    log.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    if (init?.signal?.aborted) throw new Error('aborted');
    for (const r of routes) {
      const hit = await r(url, init);
      if (hit) return new Response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
    }
    throw new TypeError(`fetch failed: no mock for ${url}`);
  };
}

export function rpcRoute(gasPriceWei = 10_000_000n, allowance?: bigint): Route {
  return (url, init) => {
    if (!/publicnode|optimism\.io|polygon-rpc|base\.org|arbitrum\.io/.test(url.host)) return undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'eth_gasPrice') return { status: 200, body: { jsonrpc: '2.0', id: 1, result: `0x${gasPriceWei.toString(16)}` } };
    if (body.method === 'eth_call' && allowance !== undefined) {
      return { status: 200, body: { jsonrpc: '2.0', id: 1, result: `0x${allowance.toString(16).padStart(64, '0')}` } };
    }
    return { status: 500, body: { error: 'unsupported' } };
  };
}

/** Real ABI-encoded LI.FI bridge call: selector + ILiFi.BridgeData + facet data. */
export function lifiCalldata(o: Partial<{ receiver: string; destChain: bigint; minAmount: bigint; asset: string; destCall: boolean; swaps: boolean }> = {}): `0x${string}` {
  const bd = {
    transactionId: `0x${'ab'.repeat(32)}` as `0x${string}`,
    bridge: 'across',
    integrator: 'bridgepilot',
    referrer: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    sendingAssetId: (o.asset ?? BASE_USDC) as `0x${string}`,
    receiver: (o.receiver ?? RECIPIENT) as `0x${string}`,
    minAmount: o.minAmount ?? 100_000_000n,
    destinationChainId: o.destChain ?? 42161n,
    hasSourceSwaps: o.swaps ?? false,
    hasDestinationCall: o.destCall ?? false,
  };
  const enc = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'transactionId', type: 'bytes32' }, { name: 'bridge', type: 'string' }, { name: 'integrator', type: 'string' },
      { name: 'referrer', type: 'address' }, { name: 'sendingAssetId', type: 'address' }, { name: 'receiver', type: 'address' },
      { name: 'minAmount', type: 'uint256' }, { name: 'destinationChainId', type: 'uint256' }, { name: 'hasSourceSwaps', type: 'bool' },
      { name: 'hasDestinationCall', type: 'bool' } ] }, { type: 'bytes' }],
    [bd, '0x1234'],
  );
  return `0x3cf2ee5e${enc.slice(2)}`;
}

export function lifiQuoteFixture(o: Partial<{ toAmount: string; toAmountMin: string; fromAmount: string; to: string; value: string; toToken: string; from: string; gasUsd: string; feeIncludedUsd: string; feeExtraUsd: string | null; duration: number; fromChainId: number; toAddress: string; data: `0x${string}`; noGas: boolean; fromPrice: string; toPrice: string }> = {}) {
  const fromAmount = o.fromAmount ?? '100000000';
  return {
    type: 'lifi',
    id: 'lifi-quote-0001',
    tool: 'across',
    toolDetails: { key: 'across', name: 'Across' },
    action: {
      fromChainId: o.fromChainId ?? 8453,
      toChainId: 42161,
      fromToken: { address: BASE_USDC, chainId: 8453, symbol: 'USDC', decimals: 6, priceUSD: o.fromPrice ?? '0.9999' },
      toToken: { address: o.toToken ?? ARB_USDC, chainId: 42161, symbol: 'USDC', decimals: 6, priceUSD: o.toPrice ?? '0.9999' },
      fromAmount,
      slippage: 0.005,
      fromAddress: o.from ?? SENDER,
      toAddress: o.toAddress ?? RECIPIENT,
    },
    estimate: {
      tool: 'across',
      fromAmount,
      toAmount: o.toAmount ?? '99720000',
      toAmountMin: o.toAmountMin ?? '99221400',
      approvalAddress: LIFI_DIAMOND,
      executionDuration: o.duration ?? 4,
      feeCosts: [
        { name: 'LP Fee', amount: '280000', amountUSD: o.feeIncludedUsd ?? '0.28', included: true, token: { symbol: 'USDC', chainId: 8453, decimals: 6 } },
        ...(o.feeExtraUsd === null ? [] : [{ name: 'Integrator fee', amount: '0', amountUSD: o.feeExtraUsd ?? '0.00', included: false, token: { symbol: 'USDC', chainId: 8453, decimals: 6 } }]),
      ],
      gasCosts: o.noGas ? [] : [{ type: 'SEND', price: '10000000', estimate: '200000', limit: '260000', amount: '2000000000000', amountUSD: o.gasUsd ?? '0.006', token: { symbol: 'ETH', chainId: 8453, decimals: 18 } }],
    },
    transactionRequest: {
      to: o.to ?? LIFI_DIAMOND,
      data: o.data ?? lifiCalldata(),
      value: o.value ?? '0x0',
      gasLimit: '0x3f7a0',
      chainId: o.fromChainId ?? 8453,
      from: o.from ?? SENDER,
    },
  };
}

export function acrossFeesFixture(o: Partial<{ outputAmount: string | null; total: string; isAmountTooLow: boolean; maxDeposit: string; spoke: string; fill: number }> = {}) {
  return {
    estimatedFillTimeSec: o.fill ?? 2,
    timestamp: String(Math.floor(NOW / 1000) - 10),
    isAmountTooLow: o.isAmountTooLow ?? false,
    quoteBlock: '31000000',
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    exclusivityDeadline: 0,
    spokePoolAddress: o.spoke ?? BASE_SPOKE,
    destinationSpokePoolAddress: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
    totalRelayFee: { pct: '1200000000000000', total: o.total ?? '120000' },
    relayerCapitalFee: { pct: '1000000000000000', total: '100000' },
    relayerGasFee: { pct: '200000000000000', total: '20000' },
    lpFee: { pct: '0', total: '0' },
    limits: { minDeposit: '500000', maxDeposit: o.maxDeposit ?? '5000000000000', maxDepositInstant: '1000000000000', maxDepositShortDelay: '5000000000000', recommendedDepositInstant: '1000000000000' },
    fillDeadline: String(Math.floor(NOW / 1000) + 3 * 3600),
    ...(o.outputAmount === null ? {} : { outputAmount: o.outputAmount ?? '99880000' }),
    inputToken: { address: BASE_USDC, symbol: 'USDC', decimals: 6, chainId: 8453 },
    outputToken: { address: ARB_USDC, symbol: 'USDC', decimals: 6, chainId: 42161 },
    id: 'across-quote-0001',
  };
}

export const lifiQuoteRoute = (body: unknown, status = 200): Route => (url) => (url.host === 'li.quest' && url.pathname === '/v1/quote' ? { status, body } : undefined);
export const acrossRoute = (body: unknown, status = 200): Route => (url) => (url.host === 'app.across.to' && url.pathname === '/api/suggested-fees' ? { status, body } : undefined);

export function makeServices(opts: { env?: Record<string, string>; routes?: Route[]; now?: () => number; prices?: StaticPriceOracle; log?: string[] } = {}): Services {
  const cfg = testConfig(opts.env);
  return createServices(cfg, {
    fetch: mockFetch(opts.routes ?? [], opts.log),
    now: opts.now ?? (() => NOW),
    prices: opts.prices ?? staticPrices(),
  });
}

export const baseQuoteInput = {
  source_chain: 'base',
  destination_chain: 'arbitrum',
  source_token: 'USDC',
  destination_token: 'USDC',
  amount: '100000000',
};

/** Deterministic PRNG for property tests (seed printed by the 3x runner). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
export const TEST_SEED = Number(process.env.TEST_SEED ?? Date.now() % 1_000_000);

/** Request-level prices (market from the given oracle, no hints). */
export function pricesFor(r: ResolvedRequest, oracle: PriceOracle = staticPrices()): Promise<RequestPrices> {
  return resolveRequestPrices(oracle, r.sourceAsset, r.destinationAsset, { input: [], output: [] });
}
