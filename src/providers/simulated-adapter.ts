import { createHash } from 'node:crypto';
import type { NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import { ProviderError } from '../utils/errors.js';
import { MICRO, pow10 } from '../utils/units.js';
import type { ProviderContext, RouteProvider, Support } from './provider-interface.js';

/** Simulated reference prices (micro-USD). Only used in PROVIDER_MODE=simulated. */
export const SIM_PRICES: Record<string, bigint> = { USD: MICRO, ETH: 3000n * MICRO, POL: 400_000n };

/**
 * Deterministic offline provider for demos and integration tests. Every quote is
 * flagged `simulated` and is never executable.
 */
export class SimulatedAdapter implements RouteProvider {
  readonly displayName: string;
  constructor(
    readonly id: string,
    private readonly feeBps: bigint,
    private readonly flatFeeUsdMicro: bigint,
    private readonly gasUsdMicro: bigint,
    private readonly timeSeconds: number,
    private readonly opts: { failWith?: ProviderError['code']; delayMs?: number } = {},
  ) {
    this.displayName = `Simulated ${id}`;
  }

  supports(req: ResolvedRequest): Support {
    return req.sourceAsset.peg === req.destinationAsset.peg ? { ok: true } : { ok: false, reason: 'simulated provider only quotes same-peg pairs' };
  }

  async quote(req: ResolvedRequest, ctx: ProviderContext): Promise<NormalizedQuote[]> {
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError(this.id, 'ABORTED', 'aborted')); }, { once: true });
      });
    }
    if (this.opts.failWith) throw new ProviderError(this.id, this.opts.failWith, 'simulated failure');
    const s = req.sourceAsset;
    const d = req.destinationAsset;
    const price = SIM_PRICES[s.peg]!;
    // Normalise input to destination decimals, subtract proportional + flat fee.
    let out = s.decimals >= d.decimals ? req.amount / pow10(s.decimals - d.decimals) : req.amount * pow10(d.decimals - s.decimals);
    out -= (out * this.feeBps) / 10_000n;
    const flatInTokens = (this.flatFeeUsdMicro * pow10(d.decimals)) / price;
    out = out > flatInTokens ? out - flatInTokens : 0n;
    const now = ctx.now();
    const quoteId = createHash('sha256').update(`${this.id}:${req.requestId}:${req.amount}`).digest('hex').slice(0, 16);
    return [{
      provider: this.id,
      tool: this.id,
      quoteId,
      sourceChainId: req.sourceChain.id,
      destinationChainId: req.destinationChain.id,
      sourceToken: s.address,
      destinationToken: d.address,
      inputAmount: req.amount,
      expectedOutput: out,
      minOutput: out - (out * BigInt(req.policy.slippageBps)) / 10_000n,
      estimatedTimeSeconds: this.timeSeconds,
      fetchedAt: now,
      expiresAt: now + ctx.config.quoteTtlMs,
      executionAvailable: false,
      extraCosts: [{ kind: 'gas', label: 'gas:simulated', usdMicro: this.gasUsdMicro, certainty: 'estimated' }],
      includedFees: [],
      priceHints: { input: price, output: price },
      warnings: ['SIMULATED quote — not real market data.'],
      simulated: true,
    }];
  }
}
