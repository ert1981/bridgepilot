import { findAsset } from '../config/assets.js';
import { getChain } from '../config/chains.js';
import type { FetchLike } from '../utils/http.js';
import { buildUrl, fetchJson } from '../utils/http.js';
import { MICRO, tryParseDecimal, USD_SCALE } from '../utils/units.js';

export interface Price {
  priceMicro: bigint;
  source: string;
  /** True when the price is an assumption (stablecoin peg, provider-supplied) rather than market data. */
  assumed?: boolean;
}

/**
 * Shared, cross-request price source. It returns ONLY independent market data or a flagged
 * stablecoin peg. Prices that providers attach to their own quotes are never stored here:
 * a provider must not be able to value its own quote or influence other requests.
 */
export interface PriceOracle {
  get(chainId: number, token: string, signal?: AbortSignal): Promise<Price | null>;
  nativePrice(chainId: number, signal?: AbortSignal): Promise<Price | null>;
}

const key = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

/** 1. LI.FI token price API (market data, cached)  2. optional $1 peg for registry USD stablecoins (assumed). */
export class LayeredPriceOracle implements PriceOracle {
  private cache = new Map<string, { price: Price; at: number }>();

  constructor(
    private readonly opts: {
      fetch: FetchLike;
      now: () => number;
      lifiBaseUrl: string;
      lifiApiKey?: string;
      ttlMs: number;
      allowStablePeg: boolean;
      timeoutMs?: number;
      disableMarket?: boolean;
    },
  ) {}

  async nativePrice(chainId: number, signal?: AbortSignal): Promise<Price | null> {
    const chain = getChain(chainId);
    if (!chain) return null;
    return this.get(chainId, chain.nativeAddress, signal);
  }

  async get(chainId: number, token: string, signal?: AbortSignal): Promise<Price | null> {
    const k = key(chainId, token);
    const now = this.opts.now();
    const cached = this.cache.get(k);
    if (cached && now - cached.at < this.opts.ttlMs) return cached.price;

    if (!this.opts.disableMarket) {
      try {
        const url = buildUrl(this.opts.lifiBaseUrl, 'token', { chain: chainId, token });
        const res = (await fetchJson(url, {
          provider: 'price:lifi',
          fetch: this.opts.fetch,
          timeoutMs: this.opts.timeoutMs ?? 3000,
          headers: this.opts.lifiApiKey ? { 'x-lifi-api-key': this.opts.lifiApiKey } : undefined,
          signal,
          maxBytes: 64_000,
        })) as { priceUSD?: unknown; chainId?: unknown; address?: unknown };
        const p = tryParseDecimal(res?.priceUSD, USD_SCALE);
        const sameToken =
          Number(res?.chainId) === chainId && typeof res?.address === 'string' && res.address.toLowerCase() === token.toLowerCase();
        if (p !== null && p > 0n && sameToken) {
          const price = { priceMicro: p, source: 'lifi_token_api' };
          this.cache.set(k, { price, at: now });
          return price;
        }
      } catch {
        /* fall through */
      }
    }

    if (this.opts.allowStablePeg) {
      const asset = findAsset(chainId, token);
      if (asset?.peg === 'USD') return { priceMicro: MICRO, source: 'usd_peg_assumption', assumed: true };
    }
    return null;
  }
}

/** Fixed prices for tests and simulated mode. */
export class StaticPriceOracle implements PriceOracle {
  constructor(private readonly prices: Record<string, bigint>, private readonly source = 'static') {}
  async get(chainId: number, token: string): Promise<Price | null> {
    const p = this.prices[key(chainId, token)];
    return p === undefined ? null : { priceMicro: p, source: this.source };
  }
  async nativePrice(chainId: number): Promise<Price | null> {
    const chain = getChain(chainId);
    return chain ? this.get(chainId, chain.nativeAddress) : null;
  }
}

export const priceKey = key;

export const PROVIDER_HINT_SOURCE = 'provider_hint_median';

function median(values: bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

export interface RequestPrices {
  input: Price | null;
  output: Price | null;
}

/**
 * Resolve ONE price per side for the whole request, before any route is evaluated, so every
 * route is valued with the same numbers (order-independent). Preference: market > peg >
 * median of provider-attached hints (flagged assumed; validation turns it into REVIEW).
 */
export async function resolveRequestPrices(
  oracle: PriceOracle,
  src: { chainId: number; address: string },
  dst: { chainId: number; address: string },
  hints: { input: bigint[]; output: bigint[] },
  signal?: AbortSignal,
): Promise<RequestPrices> {
  const [mIn, mOut] = await Promise.all([oracle.get(src.chainId, src.address, signal), oracle.get(dst.chainId, dst.address, signal)]);
  const fromHints = (h: bigint[]): Price | null => {
    const v = h.filter((x) => x > 0n);
    return v.length ? { priceMicro: median(v), source: PROVIDER_HINT_SOURCE, assumed: true } : null;
  };
  return { input: mIn ?? fromHints(hints.input), output: mOut ?? fromHints(hints.output) };
}
