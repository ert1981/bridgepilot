import { computeCost } from '../engines/cost-engine.js';
import { validateRoute } from '../engines/validation-engine.js';
import { resolveRequestPrices } from '../providers/price-oracle.js';
import type { CostBreakdown, EvaluatedRoute, NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import type { Services } from '../services.js';
import { usdMicroOf } from '../utils/units.js';

const EMPTY_COST: CostBreakdown = {
  inputUsdMicro: null,
  receivedUsdMicro: null,
  extraCostUsdMicro: null,
  netUsdMicro: null,
  totalCostUsdMicro: null,
  includedFeesUsdMicro: null,
  minOutputUsdMicro: null,
  valueLossBps: null,
  complete: false,
  priceSources: {},
};

/**
 * Add the ERC-20 approval transaction's gas when an approval is (or may be) needed. Providers do not
 * include it (LI.FI only returns SEND gas). With a sender we read the real allowance; without one we
 * assume it is needed and say so. Unknown gas price => unpriced item => REVIEW.
 */
async function withApprovalCost(quotes: NormalizedQuote[], req: ResolvedRequest, svc: Services, signal?: AbortSignal): Promise<NormalizedQuote[]> {
  if (req.sourceAsset.native) return quotes;
  const allowanceCache = new Map<string, Promise<bigint | null>>();
  let gasUsd: Promise<bigint | null> | undefined;
  const priceGas = async () => {
    const [gp, native] = await Promise.all([svc.gas.gasPriceWei(req.sourceChain.id, signal), svc.prices.nativePrice(req.sourceChain.id, signal)]);
    return gp !== null && native ? usdMicroOf(gp * svc.config.approvalGasUnits, req.sourceChain.nativeDecimals, native.priceMicro) : null;
  };
  return Promise.all(
    quotes.map(async (q) => {
      if (q.simulated || !q.approvalSpender) return q;
      let needed: boolean | null = null;
      if (req.sender) {
        const k = q.approvalSpender.toLowerCase();
        if (!allowanceCache.has(k)) allowanceCache.set(k, svc.gas.allowance(req.sourceChain.id, req.sourceAsset.address, req.sender, q.approvalSpender, signal));
        const a = await allowanceCache.get(k)!;
        if (a !== null) needed = a < req.amount;
      }
      if (needed === false) return { ...q, warnings: [...q.warnings, 'Existing allowance covers the amount; no approval transaction needed.'] };
      gasUsd ??= priceGas();
      const usd = await gasUsd;
      return {
        ...q,
        extraCosts: [
          ...q.extraCosts,
          { kind: 'gas' as const, label: needed === null ? 'gas:approval (assumed needed; allowance unknown)' : 'gas:approval', usdMicro: usd, certainty: 'estimated' as const },
        ],
      };
    }),
  );
}

/**
 * Cost Analysis + Risk & Validation (deterministic). Prices are resolved once for the whole
 * request; one malformed quote is rejected on its own and never fails the other routes.
 */
export async function evaluateRoutes(rawQuotes: NormalizedQuote[], req: ResolvedRequest, svc: Services, signal?: AbortSignal): Promise<EvaluatedRoute[]> {
  const quotes = await withApprovalCost(rawQuotes, req, svc, signal);
  const prices = await resolveRequestPrices(
    svc.prices,
    req.sourceAsset,
    req.destinationAsset,
    {
      input: quotes.map((q) => q.priceHints?.input).filter((x): x is bigint => x !== undefined),
      output: quotes.map((q) => q.priceHints?.output).filter((x): x is bigint => x !== undefined),
    },
    signal,
  );
  const out: EvaluatedRoute[] = [];
  for (const q of quotes) {
    let route: EvaluatedRoute;
    try {
      const cost = computeCost(q, req, prices);
      route = { quote: q, cost, risk: validateRoute(q, cost, req, svc.config, svc.now()) };
    } catch (e) {
      route = {
        quote: q,
        cost: EMPTY_COST,
        risk: { status: 'REJECT', findings: [{ code: 'EVALUATION_ERROR', severity: 'reject', message: `Quote could not be evaluated: ${(e as Error).message.slice(0, 120)}` }] },
      };
    }
    for (const f of route.risk.findings) if (f.severity !== 'warn') svc.metrics.inc('bridgepilot_route_findings_total', { provider: q.provider, code: f.code });
    out.push(route);
  }
  return out;
}
