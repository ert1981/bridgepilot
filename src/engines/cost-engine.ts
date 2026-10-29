import type { RequestPrices } from '../providers/price-oracle.js';
import type { CostBreakdown, CostItem, NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import { bps, parseUint, usdMicroOf } from '../utils/units.js';

/**
 * V_net = V_received - C_extra
 *
 * V_received: USD value of the quoted output (fees with included=true are already inside it).
 * C_extra:    only costs paid on top of the input (source gas, non-included fees).
 * Included fees are priced for transparency but never subtracted a second time.
 * All routes of one request are valued with the same request-level prices.
 */
export function computeCost(quote: NormalizedQuote, req: ResolvedRequest, prices: RequestPrices): CostBreakdown {
  const src = req.sourceAsset;
  const dst = req.destinationAsset;
  const pIn = prices.input;
  const pOut = prices.output;

  const inputUsd = pIn ? usdMicroOf(req.amount, src.decimals, pIn.priceMicro) : null;
  const receivedUsd = pOut ? usdMicroOf(quote.expectedOutput, dst.decimals, pOut.priceMicro) : null;
  const minOutputUsd = pOut && quote.minOutput !== null ? usdMicroOf(quote.minOutput, dst.decimals, pOut.priceMicro) : null;

  let extraKnown = 0n;
  let extraComplete = true;
  for (const item of quote.extraCosts) {
    if (item.usdMicro === null || item.usdMicro < 0n) extraComplete = false;
    else extraKnown += item.usdMicro;
  }

  const priceItem = (item: CostItem): bigint | null => {
    if (item.usdMicro !== null) return item.usdMicro;
    if (!item.token) return null;
    const amt = parseUint(item.token.amount); // malformed provider data => unpriced, never a crash
    if (amt === null) return null;
    if (item.token.chainId === src.chainId && item.token.symbol === src.symbol && pIn) return usdMicroOf(amt, src.decimals, pIn.priceMicro);
    if (item.token.chainId === dst.chainId && item.token.symbol === dst.symbol && pOut) return usdMicroOf(amt, dst.decimals, pOut.priceMicro);
    return null;
  };
  let included: bigint | null = 0n;
  for (const item of quote.includedFees) {
    const v = priceItem(item);
    if (v === null) {
      included = null;
      break;
    }
    included += v;
  }

  const netUsd = receivedUsd !== null ? receivedUsd - extraKnown : null;
  const totalCost = inputUsd !== null && netUsd !== null ? inputUsd - netUsd : null;

  return {
    inputUsdMicro: inputUsd,
    receivedUsdMicro: receivedUsd,
    extraCostUsdMicro: extraKnown,
    netUsdMicro: netUsd,
    totalCostUsdMicro: totalCost,
    includedFeesUsdMicro: included,
    minOutputUsdMicro: minOutputUsd,
    valueLossBps: totalCost !== null && inputUsd !== null ? bps(totalCost, inputUsd) : null,
    complete: extraComplete && inputUsd !== null && receivedUsd !== null,
    priceSources: { input: pIn?.source, output: pOut?.source },
  };
}
