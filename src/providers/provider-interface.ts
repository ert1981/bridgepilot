import type { AppConfig } from '../config/env.js';
import type { NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import type { FetchLike } from '../utils/http.js';
import type { GasPriceService } from './gas-price.js';
import type { PriceOracle } from './price-oracle.js';

export interface ProviderContext {
  config: AppConfig;
  fetch: FetchLike;
  now: () => number;
  signal?: AbortSignal;
  gas: GasPriceService;
  prices: PriceOracle;
}

export interface PreparedTx {
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasLimit?: bigint;
}

export type TransferState = 'PENDING' | 'DONE' | 'FAILED' | 'REFUNDED' | 'PARTIAL' | 'NOT_FOUND' | 'UNKNOWN';

export interface ProviderStatus {
  state: TransferState;
  substatus?: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  receivedAmount?: bigint;
  message?: string;
}

export type Support = { ok: true } | { ok: false; reason: string };

export interface RouteProvider {
  readonly id: string;
  readonly displayName: string;
  supports(req: ResolvedRequest): Support;
  quote(req: ResolvedRequest, ctx: ProviderContext): Promise<NormalizedQuote[]>;
  buildTransaction?(quote: NormalizedQuote, req: ResolvedRequest, ctx: ProviderContext): Promise<PreparedTx>;
  /** Independently decode the calldata and list mismatches with the request. Required for execution. */
  verifyTransaction?(tx: PreparedTx, quote: NormalizedQuote, req: ResolvedRequest): string[];
  status?(
    args: { txHash: string; sourceChainId: number; destinationChainId: number; tool?: string },
    ctx: ProviderContext,
  ): Promise<ProviderStatus>;
}
