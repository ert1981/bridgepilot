import type { AppConfig } from '../config/env.js';
import { PROVIDER_HINT_SOURCE } from '../providers/price-oracle.js';
import type { CostBreakdown, NormalizedQuote, ResolvedRequest, RiskFinding, RiskStatus } from '../schemas/quote.schema.js';
import { bps, to18 } from '../utils/units.js';

const eqAddr = (a: string | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Mandatory, deterministic filters. A cheap route never bypasses these, and missing
 * security data is never treated as "safe": it yields REVIEW or REJECT.
 */
export function validateRoute(
  quote: NormalizedQuote,
  cost: CostBreakdown,
  req: ResolvedRequest,
  cfg: AppConfig,
  now: number,
): { status: RiskStatus; findings: RiskFinding[] } {
  const f: RiskFinding[] = [];
  const reject = (code: string, message: string) => f.push({ code, severity: 'reject', message });
  const review = (code: string, message: string) => f.push({ code, severity: 'review', message });
  const warn = (code: string, message: string) => f.push({ code, severity: 'warn', message });
  const p = req.policy;

  // 1. Identity: chain, token, amount must match exactly what was asked.
  if (quote.sourceChainId !== req.sourceChain.id || quote.destinationChainId !== req.destinationChain.id) {
    reject('CHAIN_MISMATCH', `Quote chains ${quote.sourceChainId}->${quote.destinationChainId} differ from request.`);
  }
  if (!eqAddr(quote.sourceToken, req.sourceAsset.address) || !eqAddr(quote.destinationToken, req.destinationAsset.address)) {
    reject('TOKEN_MISMATCH', 'Quote token addresses differ from the requested tokens.');
  }
  if (quote.inputAmount !== req.amount) {
    reject('INPUT_AMOUNT_MISMATCH', `Quote input ${quote.inputAmount} differs from requested ${req.amount}.`);
  }

  // 2. Freshness.
  if (now >= quote.expiresAt - cfg.quoteSafetyMarginMs) reject('QUOTE_EXPIRED', 'Quote is expired or about to expire.');

  // 3. Output sanity.
  if (quote.expectedOutput <= 0n) reject('OUTPUT_INVALID', 'Quoted output is zero.');
  if (quote.minOutput !== null && quote.minOutput > quote.expectedOutput) {
    reject('OUTPUT_INVALID', 'Minimum output is greater than expected output.');
  }
  if (req.sourceAsset.peg === req.destinationAsset.peg) {
    const in18 = to18(req.amount, req.sourceAsset.decimals);
    const out18 = to18(quote.expectedOutput, req.destinationAsset.decimals);
    const ceiling = in18 + (in18 * BigInt(cfg.sameAssetOutputToleranceBps)) / 10_000n;
    if (out18 > ceiling) reject('OUTPUT_IMPLAUSIBLE', 'Output exceeds input for a same-peg transfer beyond tolerance; quote is suspicious.');
  }

  // 4. User limits.
  if (p.minOutput !== undefined) {
    if (quote.expectedOutput < p.minOutput) reject('BELOW_USER_MIN_OUTPUT', 'Expected output is below the requested min_output.');
    else if (quote.minOutput !== null && quote.minOutput < p.minOutput) {
      warn('GUARANTEED_BELOW_USER_MIN', 'Guaranteed minimum output may fall below min_output after slippage.');
    }
  }
  if (quote.minOutput !== null && quote.expectedOutput > 0n) {
    const slip = bps(quote.expectedOutput - quote.minOutput, quote.expectedOutput);
    if (slip !== null && slip > BigInt(p.slippageBps)) {
      reject('SLIPPAGE_EXCEEDED', `Slippage band ${slip} bps exceeds the allowed ${p.slippageBps} bps.`);
    }
  } else if (quote.minOutput === null) {
    review('NO_MIN_OUTPUT', 'Provider did not state a guaranteed minimum output.');
  }
  if (p.maxTimeSeconds !== undefined) {
    if (quote.estimatedTimeSeconds === null) review('TIME_UNKNOWN', 'Transfer time unknown while max_time_seconds is set.');
    else if (quote.estimatedTimeSeconds > p.maxTimeSeconds) reject('TOO_SLOW', `Estimated ${quote.estimatedTimeSeconds}s exceeds max_time_seconds.`);
  }
  if (p.maxTotalCostUsdMicro !== undefined && cost.totalCostUsdMicro !== null && cost.totalCostUsdMicro > p.maxTotalCostUsdMicro) {
    reject('COST_LIMIT_EXCEEDED', 'Total cost exceeds max_total_cost_usd.');
  }
  if (cost.valueLossBps !== null && cost.valueLossBps > BigInt(p.maxValueLossBps)) {
    reject('VALUE_LOSS_EXCEEDED', `Value loss ${cost.valueLossBps} bps exceeds allowed ${p.maxValueLossBps} bps.`);
  }
  if (cost.netUsdMicro !== null && cost.netUsdMicro <= 0n) reject('NON_POSITIVE_NET', 'Costs exceed the received value.');

  // 5. Provider limits & liquidity.
  if (quote.limits?.minInput !== undefined && req.amount < quote.limits.minInput) reject('AMOUNT_BELOW_MIN', 'Amount is below the provider minimum.');
  if (quote.limits?.maxInput !== undefined && req.amount > quote.limits.maxInput) reject('AMOUNT_ABOVE_MAX', 'Amount exceeds provider liquidity limit.');

  // 6. Security.
  const ids = [quote.provider, quote.tool].filter(Boolean).map((s) => s!.toLowerCase());
  if (ids.some((id) => cfg.securityDenylist.includes(id))) reject('CRITICAL_SECURITY_ALERT', 'Provider or bridge is on the security denylist.');
  const allow = cfg.executionAllowlist[req.sourceChain.id] ?? [];
  if (!quote.simulated) {
    if (quote.executionTarget) {
      if (!allow.includes(quote.executionTarget.toLowerCase())) reject('EXECUTION_TARGET_NOT_ALLOWED', `Contract ${quote.executionTarget} is not allowlisted.`);
    } else if (quote.executionAvailable) {
      reject('EXECUTION_DATA_INVALID', 'Executable quote has no target contract.');
    }
    if (quote.approvalSpender && !req.sourceAsset.native && !allow.includes(quote.approvalSpender.toLowerCase())) {
      reject('APPROVAL_SPENDER_NOT_ALLOWED', `Approval spender ${quote.approvalSpender} is not allowlisted.`);
    }
  }

  for (const fl of quote.flags ?? []) reject(fl.code, fl.message);

  // 7. Data completeness.
  if (!cost.complete) review('COST_INCOMPLETE', 'Some costs or prices could not be determined; net value is not reliable.');
  if (cost.priceSources.input === 'usd_peg_assumption' || cost.priceSources.output === 'usd_peg_assumption') {
    warn('PRICE_ASSUMED', 'Stablecoin valued at a $1 peg assumption (no market price available).');
  }
  if (cost.priceSources.input === PROVIDER_HINT_SOURCE || cost.priceSources.output === PROVIDER_HINT_SOURCE) {
    review('PRICE_FROM_PROVIDER', 'No independent market price; valued with provider-supplied prices.');
  }
  if (!quote.executionAvailable) {
    if (p.requireExecutable) reject('NOT_EXECUTABLE', 'Route is quote-only and require_executable is set.');
    else warn('QUOTE_ONLY', 'Route has no execution data yet.');
  }
  if (quote.simulated) warn('SIMULATED', 'Simulated provider; not real market data.');

  const status: RiskStatus = f.some((x) => x.severity === 'reject') ? 'REJECT' : f.some((x) => x.severity === 'review') ? 'REVIEW' : 'PASS';
  return { status, findings: f };
}
