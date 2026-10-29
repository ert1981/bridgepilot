import type { AppConfig } from '../config/env.js';
import type { Constraints } from '../schemas/request.schema.js';
import type { EffectivePolicy } from '../schemas/quote.schema.js';
import { parseDecimal, USD_SCALE } from '../utils/units.js';

/**
 * Merge user constraints with server hard caps. Users may tighten limits but never
 * loosen them: a looser value is clamped and reported as a warning.
 */
export function buildPolicy(
  cfg: AppConfig,
  constraints: Constraints | undefined,
  selection: EffectivePolicy['selection'] | undefined,
): { policy: EffectivePolicy; warnings: string[] } {
  const c = constraints ?? {};
  const warnings: string[] = [];

  let slippageBps = c.max_slippage_bps ?? cfg.defaultSlippageBps;
  if (slippageBps > cfg.hardMaxSlippageBps) {
    warnings.push(`max_slippage_bps ${slippageBps} exceeds server cap; clamped to ${cfg.hardMaxSlippageBps}.`);
    slippageBps = cfg.hardMaxSlippageBps;
  }

  let maxValueLossBps = c.max_value_loss_bps ?? cfg.hardMaxValueLossBps;
  if (maxValueLossBps > cfg.hardMaxValueLossBps) {
    warnings.push(`max_value_loss_bps ${maxValueLossBps} exceeds server cap; clamped to ${cfg.hardMaxValueLossBps}.`);
    maxValueLossBps = cfg.hardMaxValueLossBps;
  }

  return {
    policy: {
      selection: selection ?? 'highest_net_output',
      slippageBps,
      maxValueLossBps,
      minOutput: c.min_output !== undefined ? BigInt(c.min_output) : undefined,
      maxTimeSeconds: c.max_time_seconds,
      maxTotalCostUsdMicro: c.max_total_cost_usd !== undefined ? parseDecimal(c.max_total_cost_usd, USD_SCALE) : undefined,
      requireExecutable: c.require_executable ?? false,
      includeReview: c.include_review ?? false,
      raw: c,
    },
    warnings,
  };
}
