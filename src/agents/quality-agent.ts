import type { Services } from '../services.js';

export interface ProviderQuality {
  provider: string;
  calls: number;
  errors: number;
  error_rate: number;
  timeouts: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  error_codes: Record<string, number>;
  transfers_completed: number;
  transfers_failed: number;
  avg_output_deviation_bps: number | null;
  max_output_deviation_bps: number | null;
}

/**
 * Quality & Optimization: deterministic analysis of history. It only PROPOSES changes for
 * engineering review; it never weakens safety limits or edits configuration by itself.
 */
export async function qualityReport(svc: Services, windowMs = 24 * 3600 * 1000) {
  const since = svc.now() - windowMs;
  const calls = await svc.store.providerCalls(since);
  const prepared = (await svc.store.listPrepared()).filter((p) => p.createdAt >= since);
  const byProvider = new Map<string, ProviderQuality>();
  const get = (id: string) => {
    let q = byProvider.get(id);
    if (!q) {
      q = { provider: id, calls: 0, errors: 0, error_rate: 0, timeouts: 0, avg_latency_ms: 0, max_latency_ms: 0, error_codes: {}, transfers_completed: 0, transfers_failed: 0, avg_output_deviation_bps: null, max_output_deviation_bps: null };
      byProvider.set(id, q);
    }
    return q;
  };
  const latencySum = new Map<string, number>();
  for (const c of calls) {
    const q = get(c.provider);
    q.calls++;
    latencySum.set(c.provider, (latencySum.get(c.provider) ?? 0) + c.latencyMs);
    q.max_latency_ms = Math.max(q.max_latency_ms, c.latencyMs);
    if (c.outcome === 'error') {
      q.errors++;
      if (c.errorCode === 'TIMEOUT') q.timeouts++;
      if (c.errorCode) q.error_codes[c.errorCode] = (q.error_codes[c.errorCode] ?? 0) + 1;
    }
  }
  const devs = new Map<string, number[]>();
  for (const p of prepared) {
    const q = get(p.provider);
    if (p.state === 'DONE' || p.state === 'PARTIAL') q.transfers_completed++;
    if (p.state === 'FAILED' || p.state === 'REFUNDED') q.transfers_failed++;
    if (p.outputDeviationBps !== undefined) devs.set(p.provider, [...(devs.get(p.provider) ?? []), p.outputDeviationBps]);
  }

  const suggestions: { provider: string; severity: 'info' | 'warning' | 'critical'; suggestion: string }[] = [];
  for (const q of byProvider.values()) {
    q.avg_latency_ms = q.calls ? Math.round((latencySum.get(q.provider) ?? 0) / q.calls) : 0;
    q.error_rate = q.calls ? Number((q.errors / q.calls).toFixed(4)) : 0;
    const d = devs.get(q.provider);
    if (d?.length) {
      q.avg_output_deviation_bps = Math.round(d.reduce((a, b) => a + b, 0) / d.length);
      q.max_output_deviation_bps = Math.max(...d);
    }
    if (q.calls >= 20 && q.error_rate > 0.2) suggestions.push({ provider: q.provider, severity: 'warning', suggestion: `Error rate ${(q.error_rate * 100).toFixed(1)}% — investigate or temporarily disable this provider.` });
    if (q.calls >= 20 && q.timeouts / q.calls > 0.1) suggestions.push({ provider: q.provider, severity: 'info', suggestion: 'Frequent timeouts — review PROVIDER_TIMEOUT_MS for this provider (do not raise beyond the request budget).' });
    if (q.max_output_deviation_bps !== null && q.max_output_deviation_bps > 50) suggestions.push({ provider: q.provider, severity: 'critical', suggestion: `Received output deviated up to ${q.max_output_deviation_bps} bps from quote — investigate before further use.` });
    const t = q.transfers_completed + q.transfers_failed;
    if (t >= 5 && q.transfers_failed / t > 0.1) suggestions.push({ provider: q.provider, severity: 'warning', suggestion: 'Transfer failure rate above 10%.' });
  }
  return {
    window_hours: windowMs / 3_600_000,
    generated_at: new Date(svc.now()).toISOString(),
    providers: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    suggestions,
    note: 'Suggestions require engineering review; safety limits are never changed automatically.',
  };
}
