import { describe, expect, it } from 'vitest';
import { computeCost } from '../src/engines/cost-engine.js';
import { rankRoutes } from '../src/engines/ranking-engine.js';
import { validateRoute } from '../src/engines/validation-engine.js';
import type { EvaluatedRoute, NormalizedQuote, ResolvedRequest } from '../src/schemas/quote.schema.js';
import { quote, req } from './engine-fixtures.js';
import { NOW, pricesFor, rng, TEST_SEED, testConfig } from './helpers.js';

const cfg = testConfig();

async function evaluate(q: NormalizedQuote, r: ResolvedRequest = req(), now = NOW, c = cfg): Promise<EvaluatedRoute> {
  const cost = computeCost(q, r, await pricesFor(r));
  return { quote: q, cost, risk: validateRoute(q, cost, r, c, now) };
}
const codes = (e: EvaluatedRoute) => e.risk.findings.map((f) => f.code);

describe('validation engine (mandatory filters)', () => {
  it('passes a clean executable quote', async () => {
    const e = await evaluate(quote());
    expect(e.risk.status).toBe('PASS');
  });

  it.each([
    ['CHAIN_MISMATCH', { destinationChainId: 10 }],
    ['TOKEN_MISMATCH', { destinationToken: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' }],
    ['INPUT_AMOUNT_MISMATCH', { inputAmount: 99_000_000n }],
    ['QUOTE_EXPIRED', { expiresAt: NOW + 1000 }],
    ['OUTPUT_INVALID', { expectedOutput: 0n, minOutput: 0n }],
    ['OUTPUT_INVALID', { minOutput: 99_700_000n }],
    ['OUTPUT_IMPLAUSIBLE', { expectedOutput: 101_000_000n, minOutput: 100_900_000n }],
    ['SLIPPAGE_EXCEEDED', { minOutput: 98_000_000n }],
    ['EXECUTION_TARGET_NOT_ALLOWED', { executionTarget: '0x000000000000000000000000000000000000dEaD' }],
    ['APPROVAL_SPENDER_NOT_ALLOWED', { approvalSpender: '0x000000000000000000000000000000000000dEaD' }],
    ['EXECUTION_DATA_INVALID', { executionTarget: undefined }],
    ['AMOUNT_ABOVE_MAX', { limits: { maxInput: 50_000_000n } }],
    ['AMOUNT_BELOW_MIN', { limits: { minInput: 200_000_000n } }],
    ['VALUE_LOSS_EXCEEDED', { expectedOutput: 94_000_000n, minOutput: 93_600_000n }],
  ] as [string, Partial<NormalizedQuote>][])('rejects %s', async (code, over) => {
    const e = await evaluate(quote(over));
    expect(e.risk.status).toBe('REJECT');
    expect(codes(e)).toContain(code);
  });

  it('rejects providers on the security denylist even when cheapest', async () => {
    const e = await evaluate(quote({ tool: 'evilbridge', expectedOutput: 99_990_000n, minOutput: 99_900_000n }), req(), NOW, testConfig({ SECURITY_DENYLIST: 'evilbridge' }));
    expect(codes(e)).toContain('CRITICAL_SECURITY_ALERT');
    expect(e.risk.status).toBe('REJECT');
  });

  it('applies user constraints', async () => {
    const r = req({ constraints: { min_output: '99700000', max_time_seconds: 60, max_total_cost_usd: '0.30' } });
    const e = await evaluate(quote(), r);
    expect(codes(e)).toEqual(expect.arrayContaining(['BELOW_USER_MIN_OUTPUT', 'TOO_SLOW', 'COST_LIMIT_EXCEEDED']));
  });

  it('treats missing data as REVIEW, never as safe', async () => {
    const e1 = await evaluate(quote({ extraCosts: [{ kind: 'gas', label: 'g', usdMicro: null, certainty: 'estimated' }] }));
    expect(e1.risk.status).toBe('REVIEW');
    expect(codes(e1)).toContain('COST_INCOMPLETE');
    const e2 = await evaluate(quote({ minOutput: null }));
    expect(e2.risk.status).toBe('REVIEW');
    const e3 = await evaluate(quote({ estimatedTimeSeconds: null }), req({ constraints: { max_time_seconds: 300 } }));
    expect(codes(e3)).toContain('TIME_UNKNOWN');
  });

  it('enforces require_executable', async () => {
    const e = await evaluate(quote({ executionAvailable: false }), req({ constraints: { require_executable: true } }));
    expect(codes(e)).toContain('NOT_EXECUTABLE');
    const e2 = await evaluate(quote({ executionAvailable: false }));
    expect(e2.risk.status).toBe('PASS');
    expect(codes(e2)).toContain('QUOTE_ONLY');
  });

  it('clamps user slippage to the server cap', () => {
    const r = req({ constraints: { max_slippage_bps: 9000 } });
    expect(r.policy.slippageBps).toBe(cfg.hardMaxSlippageBps);
  });
});

describe('ranking engine (deterministic)', () => {
  it('selects route B in the document example (net $99.52 > $99.50)', async () => {
    const a = await evaluate(quote({ provider: 'provider_a', quoteId: 'a', expectedOutput: 99_600_000n, minOutput: 99_300_000n }));
    const b = await evaluate(quote({ provider: 'provider_b', quoteId: 'b', expectedOutput: 99_720_000n, minOutput: 99_300_000n, extraCosts: [{ kind: 'gas', label: 'g', usdMicro: 200_000n, certainty: 'estimated' }] }));
    const out = rankRoutes([a, b], req(), 1);
    expect(out.ranked.map((r) => r.quote.provider)).toEqual(['provider_b', 'provider_a']);
    expect(out.reasons.join(' ')).toMatch(/\$0\.02/);
  });

  it('uses time as tiebreak within tolerance', async () => {
    const a = await evaluate(quote({ provider: 'a', quoteId: 'a', estimatedTimeSeconds: 300 }));
    const b = await evaluate(quote({ provider: 'b', quoteId: 'b', expectedOutput: 99_595_000n, minOutput: 99_300_000n, estimatedTimeSeconds: 30 }));
    expect(rankRoutes([a, b], req(), 1).ranked[0]!.quote.provider).toBe('b');
    expect(rankRoutes([a, b], req(), 0).ranked[0]!.quote.provider).toBe('a');
  });

  it('fastest policy orders by time', async () => {
    const a = await evaluate(quote({ provider: 'a', quoteId: 'a', estimatedTimeSeconds: 300, expectedOutput: 99_700_000n, minOutput: 99_300_000n }));
    const b = await evaluate(quote({ provider: 'b', quoteId: 'b', estimatedTimeSeconds: 30 }));
    expect(rankRoutes([a, b], req({ selection_policy: 'fastest' }), 1).ranked[0]!.quote.provider).toBe('b');
  });

  it('excludes REJECT always and REVIEW unless include_review', async () => {
    const bad = await evaluate(quote({ provider: 'bad', quoteId: 'x', expectedOutput: 99_990_000n, minOutput: 99_900_000n, executionTarget: '0x000000000000000000000000000000000000dEaD' }));
    const rev = await evaluate(quote({ provider: 'rev', quoteId: 'y', minOutput: null }));
    const ok = await evaluate(quote({ provider: 'ok', quoteId: 'z', expectedOutput: 99_000_000n, minOutput: 98_600_000n }));
    const r1 = rankRoutes([bad, rev, ok], req(), 1);
    expect(r1.ranked.map((r) => r.quote.provider)).toEqual(['ok']);
    expect(r1.excluded.map((r) => r.quote.provider).sort()).toEqual(['bad', 'rev']);
    const r2 = rankRoutes([bad, rev, ok], req({ constraints: { include_review: true } }), 1);
    expect(r2.ranked.map((r) => r.quote.provider)).toEqual(['rev', 'ok']);
  });

  it('is order-independent: random permutations give identical rankings (property)', async () => {
    const r = rng(TEST_SEED);
    const routes: EvaluatedRoute[] = [];
    for (let i = 0; i < 8; i++) {
      const out = 99_000_000n + BigInt(Math.floor(r() * 900_000));
      routes.push(await evaluate(quote({ provider: `p${i}`, quoteId: `q${i}`, expectedOutput: out, minOutput: out - out / 300n, estimatedTimeSeconds: 10 + Math.floor(r() * 600) })));
    }
    const reference = rankRoutes(routes, req(), 1).ranked.map((x) => x.quote.provider);
    for (let k = 0; k < 50; k++) {
      const shuffled = [...routes].sort(() => r() - 0.5);
      expect(rankRoutes(shuffled, req(), 1).ranked.map((x) => x.quote.provider)).toEqual(reference);
    }
    // Best route is never beaten by more than the tie tolerance.
    const best = rankRoutes(routes, req(), 1).ranked[0]!;
    const tol = (best.cost.inputUsdMicro! * 1n) / 10_000n;
    for (const x of routes) expect(x.cost.netUsdMicro! - best.cost.netUsdMicro! <= tol).toBe(true);
  });

  it('reports no route when everything is rejected', async () => {
    const bad = await evaluate(quote({ expiresAt: NOW }));
    const out = rankRoutes([bad], req(), 1);
    expect(out.ranked).toHaveLength(0);
    expect(out.reasons[0]).toMatch(/No route/);
  });
});
