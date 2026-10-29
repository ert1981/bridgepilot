import type { EvaluatedRoute, ResolvedRequest } from './quote.schema.js';
import { formatScaled, formatUsd } from '../utils/units.js';

const usd = (v: bigint | null) => (v === null ? null : formatUsd(v));

export function assetView(a: ResolvedRequest['sourceAsset']) {
  return { chain_id: a.chainId, address: a.address, symbol: a.symbol, decimals: a.decimals, native: a.native };
}

export function routeView(r: EvaluatedRoute, req: ResolvedRequest) {
  const q = r.quote;
  const dd = req.destinationAsset.decimals;
  return {
    provider: q.provider,
    tool: q.tool ?? null,
    quote_id: q.quoteId,
    expected_output: q.expectedOutput.toString(),
    expected_output_formatted: formatScaled(q.expectedOutput, dd),
    min_output: q.minOutput?.toString() ?? null,
    min_output_formatted: q.minOutput !== null ? formatScaled(q.minOutput, dd) : null,
    estimated_time_seconds: q.estimatedTimeSeconds,
    quote_fetched_at: new Date(q.fetchedAt).toISOString(),
    quote_expires_at: new Date(q.expiresAt).toISOString(),
    execution_available: q.executionAvailable,
    simulated: q.simulated === true,
    costs: {
      input_value_usd: usd(r.cost.inputUsdMicro),
      received_value_usd: usd(r.cost.receivedUsdMicro),
      extra_costs_usd: usd(r.cost.extraCostUsdMicro),
      net_value_usd: usd(r.cost.netUsdMicro),
      /** input_value_usd - net_value_usd: everything the user gives up. */
      total_cost_usd: usd(r.cost.totalCostUsdMicro),
      included_fees_usd: usd(r.cost.includedFeesUsdMicro),
      min_output_value_usd: usd(r.cost.minOutputUsdMicro),
      value_loss_bps: r.cost.valueLossBps === null ? null : Number(r.cost.valueLossBps),
      complete: r.cost.complete,
      price_sources: r.cost.priceSources,
      items: [
        ...q.extraCosts.map((c) => ({ kind: c.kind, label: c.label, usd: usd(c.usdMicro), certainty: c.certainty, included_in_output: false })),
        ...q.includedFees.map((c) => ({ kind: c.kind, label: c.label, usd: usd(c.usdMicro), certainty: c.certainty, included_in_output: true, token: c.token ?? null })),
      ],
    },
    risk_status: r.risk.status.toLowerCase(),
    findings: r.risk.findings,
    warnings: q.warnings,
  };
}

export type RouteView = ReturnType<typeof routeView>;
