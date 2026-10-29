import { describe, expect, it } from 'vitest';
import { computeCost } from '../src/engines/cost-engine.js';
import { formatUsd, MICRO } from '../src/utils/units.js';
import { quote, req } from './engine-fixtures.js';
import { pricesFor } from './helpers.js';
import { priceKey, StaticPriceOracle } from '../src/providers/price-oracle.js';

describe('cost engine: V_net = V_received - C_extra', () => {
  it('reproduces the architecture document example (A=$99.50, B=$99.52)', async () => {
    const r = req();
    const a = computeCost(quote({ expectedOutput: 99_600_000n, extraCosts: [{ kind: 'gas', label: 'g', usdMicro: 100_000n, certainty: 'estimated' }] }), r, await pricesFor(r));
    const b = computeCost(quote({ provider: 'provider_b', expectedOutput: 99_720_000n, extraCosts: [{ kind: 'gas', label: 'g', usdMicro: 200_000n, certainty: 'estimated' }] }), r, await pricesFor(r));
    expect(formatUsd(a.netUsdMicro!)).toBe('99.50');
    expect(formatUsd(b.netUsdMicro!)).toBe('99.52');
    expect(formatUsd(a.inputUsdMicro!)).toBe('100.00');
    expect(formatUsd(a.totalCostUsdMicro!)).toBe('0.50');
    expect(formatUsd(b.totalCostUsdMicro!)).toBe('0.48');
    expect(a.valueLossBps).toBe(50n);
  });

  it('never subtracts included fees a second time', async () => {
    const withIncluded = quote({ includedFees: [{ kind: 'fee', label: 'lp', usdMicro: 280_000n, certainty: 'quoted' }] });
    const without = quote();
    const c1 = computeCost(withIncluded, req(), await pricesFor(req()));
    const c2 = computeCost(without, req(), await pricesFor(req()));
    expect(c1.netUsdMicro).toBe(c2.netUsdMicro);
    expect(c1.includedFeesUsdMicro).toBe(280_000n);
  });

  it('prices included fees given in token units', async () => {
    const q = quote({ includedFees: [{ kind: 'fee', label: 'relay', usdMicro: null, certainty: 'quoted', token: { symbol: 'USDC', chainId: 8453, amount: '120000', decimals: 6 } }] });
    const c = computeCost(q, req(), await pricesFor(req()));
    expect(c.includedFeesUsdMicro).toBe(120_000n);
  });

  it('marks cost incomplete when an extra cost cannot be priced', async () => {
    const q = quote({ extraCosts: [{ kind: 'gas', label: 'g', usdMicro: null, certainty: 'estimated' }] });
    const c = computeCost(q, req(), await pricesFor(req()));
    expect(c.complete).toBe(false);
    expect(c.netUsdMicro).toBe(99_600_000n);
  });

  it('marks cost incomplete when the output token has no price', async () => {
    const r = req();
    const noOut = new StaticPriceOracle({ [priceKey(8453, r.sourceAsset.address)]: MICRO });
    const c = computeCost(quote(), r, await pricesFor(r, noOut));
    expect(c.complete).toBe(false);
    expect(c.netUsdMicro).toBeNull();
    expect(c.totalCostUsdMicro).toBeNull();
  });

  it('never crashes on malformed provider fee amounts (M2)', async () => {
    const q = quote({ includedFees: [{ kind: 'fee', label: 'x', usdMicro: null, certainty: 'quoted', token: { symbol: 'USDC', chainId: 8453, amount: '280000.5' } }] });
    const c = computeCost(q, req(), await pricesFor(req()));
    expect(c.includedFeesUsdMicro).toBeNull();
  });

  it('values cross-asset routes with each side priced separately', async () => {
    const r = req({ source_token: 'WETH', destination_token: 'USDC', amount: (10n ** 18n).toString() });
    const q = quote({ sourceToken: r.sourceAsset.address, inputAmount: 10n ** 18n, expectedOutput: 2_990_000_000n, minOutput: 2_980_000_000n, extraCosts: [] });
    const c = computeCost(q, r, await pricesFor(r));
    expect(formatUsd(c.inputUsdMicro!)).toBe('3000.00');
    expect(formatUsd(c.netUsdMicro!)).toBe('2990.00');
    expect(c.valueLossBps).toBe(33n);
  });
});
