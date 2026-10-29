import { describe, expect, it } from 'vitest';
import { runQuote } from '../src/agents/orchestrator.js';
import { qualityReport } from '../src/agents/quality-agent.js';
import { ApiError } from '../src/utils/errors.js';
import { acrossFeesFixture, acrossRoute, baseQuoteInput, lifiQuoteFixture, lifiQuoteRoute, makeServices, mockFetch, NOW, RECIPIENT, rpcRoute, SENDER, testConfig } from './helpers.js';
import { createServices } from '../src/services.js';
import { StaticPriceOracle } from '../src/providers/price-oracle.js';

type Body = Record<string, any>;

describe('orchestrator end-to-end (mocked providers)', () => {
  it('compares LI.FI and Across and picks the higher net output', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture()), acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const { body } = await runQuote({ ...baseQuoteInput, sender: SENDER, recipient: RECIPIENT }, svc);
    const b = body as Body;
    expect(b.status).toBe('success');
    // Across: 99.88 - 0.0036 deposit gas - 0.00165 approval gas > LI.FI: 99.72 - 0.006 - 0.00165
    expect(b.best_route.provider).toBe('across');
    expect(b.alternatives.map((a: Body) => a.provider)).toEqual(['lifi']);
    expect(b.best_route.costs.net_value_usd).toBe('99.87475');
    expect(b.best_route.costs.items.map((i: Body) => i.label)).toContain('gas:approval (assumed needed; allowance unknown)');
    expect(b.selection_basis).toMatch(/not a guarantee of the cheapest route/);
    expect(b.data_as_of).toBeDefined();
    expect(b.explanation[0]).toMatch(/highest net output/);
  });

  it('survives one provider failing', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute({ message: 'boom' }, 500), acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.status).toBe('success');
    expect(b.best_route.provider).toBe('across');
    expect(b.provider_errors).toEqual([expect.objectContaining({ provider: 'lifi', code: 'HTTP_5XX' })]);
  });

  it('reports providers_unavailable when all fail', async () => {
    const svc = makeServices({ routes: [] });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.status).toBe('providers_unavailable');
    expect(b.best_route).toBeNull();
  });

  it('rejects a tampered quote (wrong destination token) even if it is cheapest', async () => {
    const tampered = lifiQuoteFixture({ toAmount: '99990000', toAmountMin: '99900000', toToken: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' });
    const svc = makeServices({ routes: [lifiQuoteRoute(tampered), acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.best_route.provider).toBe('across');
    expect(b.excluded[0].findings.map((f: Body) => f.code)).toContain('TOKEN_MISMATCH');
  });

  it('rejects a quote routed to a non-allowlisted contract', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture({ to: '0x000000000000000000000000000000000000dEaD' })), acrossRoute({}, 500)] });
    const b = (await runQuote({ ...baseQuoteInput, sender: SENDER }, svc)).body as Body;
    expect(b.status).toBe('no_valid_route');
    expect(b.excluded[0].findings.map((f: Body) => f.code)).toContain('EXECUTION_TARGET_NOT_ALLOWED');
  });

  it('skips unsupported providers with a reason', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture({ fromAmount: (10n ** 17n).toString() }))] });
    const b = (await runQuote({ ...baseQuoteInput, source_token: 'ETH', destination_token: 'ETH', amount: (10n ** 17n).toString() }, svc)).body as Body;
    expect(b.warnings.join(' ')).toMatch(/across skipped/);
  });

  it('rejects invalid requests with structured errors', async () => {
    const svc = makeServices();
    const cases: [Record<string, unknown>, string][] = [
      [{ source_chain: 'solana' }, 'UNSUPPORTED_CHAIN'],
      [{ destination_chain: 'base' }, 'SAME_CHAIN'],
      [{ source_token: 'DOGE' }, 'UNSUPPORTED_ASSET'],
      [{ providers: ['nope'] }, 'UNKNOWN_PROVIDER'],
    ];
    for (const [over, code] of cases) {
      await expect(runQuote({ ...baseQuoteInput, ...over } as never, svc)).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.code === code);
    }
  });

  it('caches quotes only while valid', async () => {
    const log: string[] = [];
    let t = NOW;
    const svc = makeServices({ env: { QUOTE_CACHE_TTL_MS: '10000', ENABLED_PROVIDERS: 'lifi' }, routes: [lifiQuoteRoute(lifiQuoteFixture())], log, now: () => t });
    await runQuote(baseQuoteInput, svc);
    await runQuote(baseQuoteInput, svc);
    expect(log.filter((l) => l.includes('/v1/quote'))).toHaveLength(1);
    t += 11_000;
    await runQuote(baseQuoteInput, svc);
    expect(log.filter((l) => l.includes('/v1/quote'))).toHaveLength(2);
  });

  it('feeds the quality agent with provider history', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute({}, 500), acrossRoute(acrossFeesFixture()), rpcRoute()] });
    for (let i = 0; i < 3; i++) await runQuote(baseQuoteInput, svc);
    const rep = await qualityReport(svc);
    const lifi = rep.providers.find((p) => p.provider === 'lifi')!;
    expect(lifi.calls).toBe(3);
    expect(lifi.errors).toBe(3);
    expect(lifi.error_codes.HTTP_5XX).toBe(3);
  });

  it('a provider cannot price its own quote, and ranking is order-independent (H2)', async () => {
    // No market price at all for USDC: only provider hints exist.
    const emptyOracle = new StaticPriceOracle({});
    const mk = (order: string[]) =>
      runQuote(
        { ...baseQuoteInput, providers: order, constraints: { include_review: true } },
        createServices(testConfig({ ALLOW_STABLE_PEG_FALLBACK: 'false' }), {
          fetch: mockFetch([lifiQuoteRoute(lifiQuoteFixture({ toAmount: '99000000', toAmountMin: '98600000', fromPrice: '1.05', toPrice: '1.05' })), acrossRoute(acrossFeesFixture()), rpcRoute()]),
          now: () => NOW,
          prices: emptyOracle,
        }),
      );
    const a = (await mk(['lifi', 'across'])).body as Body;
    const b = (await mk(['across', 'lifi'])).body as Body;
    expect(a.best_route.provider).toBe(b.best_route.provider);
    expect(a.best_route.provider).toBe('across'); // more tokens out wins when both are valued the same way
    expect(a.best_route.findings.map((f: Body) => f.code)).toContain('PRICE_FROM_PROVIDER');
    // Without include_review, provider-priced routes are not auto-selected.
    const strict = createServices(testConfig({ ALLOW_STABLE_PEG_FALLBACK: 'false' }), { fetch: mockFetch([lifiQuoteRoute(lifiQuoteFixture()), rpcRoute()]), now: () => NOW, prices: emptyOracle });
    expect(((await runQuote({ ...baseQuoteInput, providers: ['lifi'] }, strict)).body as Body).status).toBe('no_valid_route');
  });

  it('missing gas data is never treated as free (M3)', async () => {
    const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture({ noGas: true }))], env: { ENABLED_PROVIDERS: 'lifi' } });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.status).toBe('no_valid_route');
    expect(b.excluded[0].findings.map((f: Body) => f.code)).toContain('COST_INCOMPLETE');
  });

  it('a malformed quote is rejected alone without failing the request (M2)', async () => {
    const bad = lifiQuoteFixture();
    (bad.estimate.feeCosts[0] as Record<string, unknown>).amountUSD = undefined;
    (bad.estimate.feeCosts[0] as Record<string, unknown>).amount = '280000.5';
    const svc = makeServices({ routes: [lifiQuoteRoute(bad), acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.status).toBe('success');
  });

  it('Across amount-too-low is rejected, not just warned (L4)', async () => {
    const svc = makeServices({ routes: [acrossRoute(acrossFeesFixture({ isAmountTooLow: true })), rpcRoute()], env: { ENABLED_PROVIDERS: 'across' } });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.excluded[0].findings.map((f: Body) => f.code)).toContain('AMOUNT_BELOW_MIN');
  });

  it('counts approval gas only when the real allowance is insufficient', async () => {
    const run = async (allowance: bigint) => {
      const svc = makeServices({ routes: [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, allowance)], env: { ENABLED_PROVIDERS: 'lifi' } });
      return ((await runQuote({ ...baseQuoteInput, sender: SENDER, recipient: RECIPIENT }, svc)).body as Body).best_route;
    };
    const needs = await run(0n);
    expect(needs.costs.items.map((i: Body) => i.label)).toContain('gas:approval');
    const has = await run(10n ** 12n);
    expect(has.costs.items.map((i: Body) => i.label)).not.toContain('gas:approval');
    expect(has.warnings.join(' ')).toMatch(/allowance covers/);
    expect(Number(needs.costs.net_value_usd)).toBeLessThan(Number(has.costs.net_value_usd));
  });

  it('a failing provider is skipped by the circuit breaker, then retried after cooldown', async () => {
    let t = NOW;
    const log: string[] = [];
    const svc = makeServices({ routes: [lifiQuoteRoute({}, 500), acrossRoute(acrossFeesFixture()), rpcRoute()], env: { CIRCUIT_FAILURE_THRESHOLD: '3', CIRCUIT_COOLDOWN_MS: '30000' }, now: () => t, log });
    for (let i = 0; i < 3; i++) await runQuote(baseQuoteInput, svc);
    const calls = () => log.filter((l) => l.includes('li.quest/v1/quote')).length;
    expect(calls()).toBe(3);
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(calls()).toBe(3); // skipped, request still succeeds via Across
    expect(b.status).toBe('success');
    expect(b.warnings.join(' ')).toMatch(/circuit open/);
    t += 31_000;
    await runQuote(baseQuoteInput, svc);
    expect(calls()).toBe(4); // one half-open trial
  });

  it('simulated mode works offline and is clearly labelled', async () => {
    const svc = makeServices({ env: { PROVIDER_MODE: 'simulated' } });
    const b = (await runQuote(baseQuoteInput, svc)).body as Body;
    expect(b.simulated).toBe(true);
    expect(b.status).toBe('success');
    expect(b.warnings.join(' ')).toMatch(/SIMULATED/);
  });
});
