import { describe, expect, it } from 'vitest';
import { ASSETS, resolveAsset } from '../src/config/assets.js';
import { CHAINS, resolveChain } from '../src/config/chains.js';
import { bps, formatScaled, formatUsd, parseDecimal, parseUint, to18, usdMicroOf, MICRO } from '../src/utils/units.js';
import { rng, TEST_SEED } from './helpers.js';

describe('fixed-point units', () => {
  it('parses decimals with half-up rounding', () => {
    expect(parseDecimal('0.9999', 6)).toBe(999_900n);
    expect(parseDecimal('1.0000005', 6)).toBe(1_000_001n);
    expect(parseDecimal('1.0000004', 6)).toBe(1_000_000n);
    expect(parseDecimal('3150', 6)).toBe(3_150_000_000n);
    expect(parseDecimal('1e-7', 6)).toBe(0n);
    expect(parseDecimal('2.5e-6', 6)).toBe(3n);
  });

  it('rejects malformed decimals', () => {
    for (const bad of ['', '-1', '1.', '.5', 'abc', '1,000', '01.5x', 'NaN']) expect(() => parseDecimal(bad, 6)).toThrow();
  });

  it('parses only canonical uint strings within uint256', () => {
    expect(parseUint('0')).toBe(0n);
    expect(parseUint('123')).toBe(123n);
    expect(parseUint('0123')).toBeNull();
    expect(parseUint('-1')).toBeNull();
    expect(parseUint('1.5')).toBeNull();
    expect(parseUint((1n << 256n).toString())).toBeNull();
    expect(parseUint(((1n << 256n) - 1n).toString())).toBe((1n << 256n) - 1n);
  });

  it('formats scaled values', () => {
    expect(formatScaled(99_720_000n, 6)).toBe('99.72');
    expect(formatScaled(100_000_000n, 6)).toBe('100');
    expect(formatScaled(-1_500_000n, 6)).toBe('-1.5');
    expect(formatUsd(280_000n)).toBe('0.28');
    expect(formatUsd(0n)).toBe('0.00');
  });

  it('computes USD value exactly for token amounts', () => {
    expect(usdMicroOf(100_000_000n, 6, MICRO)).toBe(100n * MICRO);
    expect(usdMicroOf(10n ** 18n, 18, 3000n * MICRO)).toBe(3000n * MICRO);
    expect(usdMicroOf(2_000_000_000_000n, 18, 3000n * MICRO)).toBe(6000n); // 0.006 USD
  });

  it('round-trips random values (property)', () => {
    const r = rng(TEST_SEED);
    for (let i = 0; i < 500; i++) {
      const v = BigInt(Math.floor(r() * 1e12));
      const scale = Math.floor(r() * 18);
      expect(parseDecimal(formatScaled(v, scale), scale)).toBe(v);
    }
  });

  it('bps and decimal normalisation', () => {
    expect(bps(28n, 10_000n)).toBe(28n);
    expect(bps(1n, 0n)).toBeNull();
    expect(to18(1_000_000n, 6)).toBe(10n ** 18n);
  });
});

describe('chain and asset registry', () => {
  it('resolves chains by key or id only', () => {
    expect(resolveChain('base')?.id).toBe(8453);
    expect(resolveChain('BASE')?.id).toBe(8453);
    expect(resolveChain(42161)?.key).toBe('arbitrum');
    expect(resolveChain('42161')?.key).toBe('arbitrum');
    expect(resolveChain('basee')).toBeUndefined();
    expect(resolveChain(999)).toBeUndefined();
    expect(resolveChain('0x2105')).toBeUndefined();
  });

  it('has unique (chain, symbol) and (chain, address) pairs', () => {
    const sym = new Set<string>();
    const addr = new Set<string>();
    for (const a of ASSETS) {
      const s = `${a.chainId}:${a.symbol}`;
      const d = `${a.chainId}:${a.address.toLowerCase()}`;
      expect(sym.has(s), s).toBe(false);
      expect(addr.has(d), d).toBe(false);
      sym.add(s);
      addr.add(d);
    }
    for (const c of CHAINS) expect(ASSETS.some((a) => a.chainId === c.id && a.native)).toBe(true);
  });

  it('resolves tokens by symbol or address and never guesses', () => {
    const base = resolveChain('base')!;
    const ok = resolveAsset(base, 'usdc');
    expect(ok.ok && ok.asset.decimals).toBe(6);
    const byAddr = resolveAsset(base, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(byAddr.ok && byAddr.asset.symbol).toBe('USDC');
    const unknownAddr = resolveAsset(base, '0x000000000000000000000000000000000000dEaD');
    expect(unknownAddr.ok ? null : unknownAddr.code).toBe('UNSUPPORTED_ASSET');
    const usdt = resolveAsset(base, 'USDT');
    expect(usdt.ok ? null : usdt.code).toBe('UNSUPPORTED_ASSET');
    const bad = resolveAsset(base, '0x1234');
    expect(bad.ok ? null : bad.code).toBe('INVALID_ASSET');
  });
});
