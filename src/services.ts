import type { AppConfig } from './config/env.js';
import { AuditLog } from './observability/audit-log.js';
import { Metrics } from './observability/metrics.js';
import { GasPriceService } from './providers/gas-price.js';
import { LayeredPriceOracle, StaticPriceOracle, type PriceOracle } from './providers/price-oracle.js';
import { defaultRegistry, type ProviderRegistry } from './providers/provider-registry.js';
import { SIM_PRICES } from './providers/simulated-adapter.js';
import { ASSETS } from './config/assets.js';
import { MemoryStore, type Store } from './storage/store.js';
import type { FetchLike } from './utils/http.js';
import { priceKey } from './providers/price-oracle.js';
import type { NormalizedQuote } from './schemas/quote.schema.js';
import { MemoryNonceStore, SqliteNonceStore, type NonceStore } from './billing/nonce-store.js';
import { SqliteStore } from './storage/sqlite-store.js';
import { CircuitBreaker } from './providers/circuit-breaker.js';

export interface Services {
  config: AppConfig;
  fetch: FetchLike;
  now: () => number;
  registry: ProviderRegistry;
  prices: PriceOracle;
  gas: GasPriceService;
  store: Store;
  metrics: Metrics;
  audit: AuditLog;
  quoteCache: Map<string, { quotes: NormalizedQuote[]; storedAt: number }>;
  nonces: NonceStore;
  circuit: CircuitBreaker;
}

export function createServices(config: AppConfig, overrides: Partial<Services> = {}): Services {
  const fetchImpl: FetchLike = overrides.fetch ?? ((input, init) => fetch(input, init));
  const now = overrides.now ?? (() => Date.now());
  let prices = overrides.prices;
  if (!prices) {
    if (config.providerMode === 'simulated') {
      const table: Record<string, bigint> = {};
      for (const a of ASSETS) table[priceKey(a.chainId, a.address)] = SIM_PRICES[a.peg]!;
      prices = new StaticPriceOracle(table, 'simulated_static');
    } else {
      prices = new LayeredPriceOracle({
        fetch: fetchImpl,
        now,
        lifiBaseUrl: config.lifi.baseUrl,
        lifiApiKey: config.lifi.apiKey,
        ttlMs: config.priceCacheTtlMs,
        allowStablePeg: config.allowStablePegFallback,
      });
    }
  }
  let store = overrides.store;
  let nonces = overrides.nonces;
  if (config.storagePath && (!store || !nonces)) {
    const sq = new SqliteStore(config.storagePath);
    store ??= sq;
    nonces ??= new SqliteNonceStore(sq.db);
  }
  return {
    config,
    fetch: fetchImpl,
    now,
    registry: overrides.registry ?? defaultRegistry(config),
    prices,
    gas: overrides.gas ?? new GasPriceService(config.rpcUrls, fetchImpl, now),
    store: store ?? new MemoryStore(),
    nonces: nonces ?? new MemoryNonceStore(),
    circuit: overrides.circuit ?? new CircuitBreaker(config.circuit.failureThreshold, config.circuit.cooldownMs, now),
    metrics: overrides.metrics ?? new Metrics(),
    audit: overrides.audit ?? new AuditLog(config.auditLogPath),
    quoteCache: overrides.quoteCache ?? new Map(),
  };
}
