/**
 * Fixed-point helpers. All money math uses bigint; USD values are carried in
 * micro-USD (1e-6) so cent-level comparisons are exact and reproducible.
 */
export const USD_SCALE = 6;
export const MICRO = 10n ** 6n;

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
export const MAX_UINT256 = (1n << 256n) - 1n;

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 77) throw new RangeError(`bad exponent ${n}`);
  return 10n ** BigInt(n);
}

/** Parse a non-negative decimal string into a scaled integer (round half up). */
export function parseDecimal(value: string, scale: number): bigint {
  const s = value.trim();
  // Accept scientific notation that providers sometimes return (e.g. "1e-7").
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid decimal "${value}"`);
    return parseDecimal(n.toFixed(Math.min(scale + 2, 20)), scale);
  }
  if (!DECIMAL_RE.test(s)) throw new RangeError(`invalid decimal "${value}"`);
  const [intPart, fracRaw = ''] = s.split('.') as [string, string?];
  const frac = (fracRaw ?? '').replace(/^\./, '');
  const kept = frac.slice(0, scale).padEnd(scale, '0');
  let result = BigInt(intPart) * pow10(scale) + BigInt(kept || '0');
  const next = frac.charAt(scale);
  if (next && Number(next) >= 5) result += 1n;
  return result;
}

export function tryParseDecimal(value: unknown, scale: number): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = value.toString();
  }
  if (typeof value !== 'string') return null;
  try {
    return parseDecimal(value, scale);
  } catch {
    return null;
  }
}

export function parseUint(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== 'string' || !UINT_RE.test(value) || value.length > 78) return null;
  const v = BigInt(value);
  return v <= MAX_UINT256 ? v : null;
}

/** Format a scaled integer as a decimal string, trimming trailing zeros past minFrac. */
export function formatScaled(value: bigint, scale: number, minFrac = 0): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = pow10(scale);
  const int = abs / base;
  let frac = (abs % base).toString().padStart(scale, '0');
  frac = frac.replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export function formatUsd(micro: bigint): string {
  return formatScaled(micro, USD_SCALE, 2);
}

/** USD value (micro) of a token amount given its price in micro-USD per whole token. */
export function usdMicroOf(amount: bigint, decimals: number, priceMicro: bigint): bigint {
  return (amount * priceMicro) / pow10(decimals);
}

/** Scale a token amount to 18 decimals for cross-decimal comparison. */
export function to18(amount: bigint, decimals: number): bigint {
  return decimals <= 18 ? amount * pow10(18 - decimals) : amount / pow10(decimals - 18);
}

/** Basis points of `part` relative to `whole` (floored). Returns null when whole is 0. */
export function bps(part: bigint, whole: bigint): bigint | null {
  if (whole === 0n) return null;
  return (part * 10_000n) / whole;
}

export function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
