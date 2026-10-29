import type { ProviderContext, RouteProvider } from '../providers/provider-interface.js';
import type { NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import type { Services } from '../services.js';
import { ProviderError } from '../utils/errors.js';

export interface DiscoveryResult {
  quotes: NormalizedQuote[];
  errors: { provider: string; code: string; message: string }[];
  skipped: { provider: string; reason: string }[];
}

function cacheKey(p: RouteProvider, r: ResolvedRequest): string {
  return [
    p.id,
    r.sourceChain.id,
    r.sourceAsset.address,
    r.destinationChain.id,
    r.destinationAsset.address,
    r.amount,
    r.sender ?? '-',
    r.recipient ?? '-',
    r.policy.slippageBps,
  ].join('|');
}

export function providerContext(svc: Services, signal?: AbortSignal): ProviderContext {
  return { config: svc.config, fetch: svc.fetch, now: svc.now, signal, gas: svc.gas, prices: svc.prices };
}

/**
 * Route Discovery: queries providers in parallel within the request budget. One provider
 * failing never blocks the others. It does not judge which route is cheapest.
 */
export async function discoverRoutes(req: ResolvedRequest, svc: Services, signal: AbortSignal): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { quotes: [], errors: [], skipped: [] };
  const chosen: RouteProvider[] = [];
  for (const id of req.providers) {
    const p = svc.registry.get(id);
    if (!p) continue;
    const s = p.supports(req);
    if (!s.ok) {
      result.skipped.push({ provider: id, reason: s.reason });
      continue;
    }
    if (!svc.circuit.allow(id)) {
      result.skipped.push({ provider: id, reason: 'temporarily disabled after repeated failures (circuit open)' });
      svc.metrics.inc('bridgepilot_provider_circuit_skips_total', { provider: id });
      continue;
    }
    if (chosen.length >= svc.config.maxProvidersPerRequest) {
      result.skipped.push({ provider: id, reason: 'per-request provider budget reached' });
      continue;
    }
    chosen.push(p);
  }

  const ctx = providerContext(svc, signal);
  const settled = await Promise.allSettled(
    chosen.map(async (p) => {
      const key = cacheKey(p, req);
      const now = svc.now();
      const hit = svc.quoteCache.get(key);
      if (hit && now - hit.storedAt < svc.config.quoteCacheTtlMs && hit.quotes.every((q) => q.expiresAt - svc.config.quoteSafetyMarginMs > now)) {
        svc.metrics.inc('bridgepilot_quote_cache_hits_total', { provider: p.id });
        return hit.quotes;
      }
      const started = svc.now();
      try {
        const quotes = await p.quote(req, ctx);
        const latency = svc.now() - started;
        svc.metrics.observe('bridgepilot_provider_latency_ms', latency, { provider: p.id });
        svc.metrics.inc('bridgepilot_provider_calls_total', { provider: p.id, outcome: 'ok' });
        await svc.store.recordProviderCall({ provider: p.id, at: started, latencyMs: latency, outcome: 'ok', quotes: quotes.length, rejectedCodes: [] });
        svc.circuit.success(p.id);
        if (svc.config.quoteCacheTtlMs > 0) svc.quoteCache.set(key, { quotes, storedAt: svc.now() });
        return quotes;
      } catch (e) {
        const latency = svc.now() - started;
        const err = e instanceof ProviderError ? e : new ProviderError(p.id, 'BAD_RESPONSE', (e as Error).message ?? 'unknown');
        // "No route" is a valid answer, not a provider failure.
        if (err.code === 'NO_ROUTE' || err.code === 'ABORTED') svc.circuit.success(p.id);
        else svc.circuit.failure(p.id);
        svc.metrics.inc('bridgepilot_provider_calls_total', { provider: p.id, outcome: 'error', code: err.code });
        await svc.store.recordProviderCall({ provider: p.id, at: started, latencyMs: latency, outcome: 'error', errorCode: err.code, quotes: 0, rejectedCodes: [] });
        throw err;
      }
    }),
  );

  const seen = new Set<string>();
  settled.forEach((s, i) => {
    const p = chosen[i]!;
    if (s.status === 'fulfilled') {
      for (const q of s.value) {
        const k = `${q.provider}:${q.quoteId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        result.quotes.push(q);
      }
    } else {
      const e = s.reason as ProviderError;
      result.errors.push({ provider: p.id, code: e.code, message: e.message.slice(0, 300) });
    }
  });
  // Prune stale cache entries opportunistically.
  if (svc.quoteCache.size > 5000) {
    const now = svc.now();
    for (const [k, v] of svc.quoteCache) if (now - v.storedAt > svc.config.quoteCacheTtlMs) svc.quoteCache.delete(k);
  }
  return result;
}
