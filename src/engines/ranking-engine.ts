import type { EvaluatedRoute, ResolvedRequest } from '../schemas/quote.schema.js';
import { formatUsd } from '../utils/units.js';

export interface RankingResult {
  ranked: EvaluatedRoute[];
  excluded: EvaluatedRoute[];
  reasons: string[];
}

const byProvider = (a: EvaluatedRoute, b: EvaluatedRoute) =>
  a.quote.provider === b.quote.provider ? (a.quote.quoteId < b.quote.quoteId ? -1 : a.quote.quoteId > b.quote.quoteId ? 1 : 0) : a.quote.provider < b.quote.provider ? -1 : 1;
const time = (r: EvaluatedRoute) => r.quote.estimatedTimeSeconds ?? Number.MAX_SAFE_INTEGER;

/**
 * Deterministic ranking. No model voting: same inputs always produce the same order.
 *  highest_net_output: net USD desc; within tie tolerance -> faster, then fewer findings, then provider id.
 *  fastest: time asc; then net desc.
 */
export function rankRoutes(routes: EvaluatedRoute[], req: ResolvedRequest, tieToleranceBps: number): RankingResult {
  const eligible = routes.filter((r) => r.risk.status === 'PASS' || (req.policy.includeReview && r.risk.status === 'REVIEW'));
  const excluded = routes.filter((r) => !eligible.includes(r));
  // Routes without a USD net value can only be compared when policy allows review; push them last.
  const net = (r: EvaluatedRoute) => r.cost.netUsdMicro;

  const inputUsd = eligible.find((r) => r.cost.inputUsdMicro !== null)?.cost.inputUsdMicro ?? null;
  const tol = inputUsd !== null ? (inputUsd * BigInt(tieToleranceBps)) / 10_000n : 0n;

  const cmpNet = (a: EvaluatedRoute, b: EvaluatedRoute): number => {
    const na = net(a);
    const nb = net(b);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    const diff = na - nb;
    const abs = diff < 0n ? -diff : diff;
    if (abs <= tol) return 0;
    return diff > 0n ? -1 : 1;
  };
  const cmpExactNet = (a: EvaluatedRoute, b: EvaluatedRoute): number => {
    const na = net(a) ?? -1n;
    const nb = net(b) ?? -1n;
    return na === nb ? 0 : na > nb ? -1 : 1;
  };

  let ranked: EvaluatedRoute[];
  if (req.policy.selection === 'fastest') {
    ranked = [...eligible].sort((a, b) => time(a) - time(b) || cmpExactNet(a, b) || byProvider(a, b));
  } else {
    // Total order by exact net first. The tie tolerance is applied only against the top
    // net value (a single band), which keeps the ordering transitive and input-order independent.
    const byNet = [...eligible].sort((a, b) => cmpExactNet(a, b) || time(a) - time(b) || byProvider(a, b));
    const top = byNet[0] ? net(byNet[0]) : null;
    const inBand = (r: EvaluatedRoute) => top !== null && net(r) !== null && top - net(r)! <= tol;
    const band = byNet
      .filter(inBand)
      .sort((a, b) => time(a) - time(b) || a.risk.findings.length - b.risk.findings.length || cmpExactNet(a, b) || byProvider(a, b));
    ranked = [...band, ...byNet.filter((r) => !inBand(r))];
  }

  const reasons: string[] = [];
  const best = ranked[0];
  if (best) {
    const second = ranked[1];
    if (req.policy.selection === 'fastest') {
      reasons.push(`Selected ${best.quote.provider}: fastest eligible route (${best.quote.estimatedTimeSeconds ?? '?'}s).`);
    } else {
      reasons.push(`Selected ${best.quote.provider}: highest net output among routes that passed mandatory filters.`);
    }
    if (second && best.cost.netUsdMicro !== null && second.cost.netUsdMicro !== null) {
      const d = best.cost.netUsdMicro - second.cost.netUsdMicro;
      if (cmpNet(best, second) === 0) {
        reasons.push(`Net difference vs ${second.quote.provider} is $${formatUsd(d < 0n ? -d : d)}, within tie tolerance; secondary criteria (time, findings) decided.`);
      } else {
        reasons.push(`Beats ${second.quote.provider} by $${formatUsd(d)} net.`);
      }
      if (d >= 0n && d < 50_000n) reasons.push('Margin is under $0.05; quote precision and price movement may change the order.');
    }
  } else {
    reasons.push('No route passed the mandatory filters.');
  }
  for (const r of excluded) {
    const codes = r.risk.findings.filter((x) => x.severity !== 'warn').map((x) => x.code);
    reasons.push(`Excluded ${r.quote.provider} (${r.risk.status}): ${codes.join(', ') || 'policy'}.`);
  }
  return { ranked, excluded, reasons };
}
