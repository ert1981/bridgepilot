import { getAddress, isAddress } from 'viem';
import { CHAINS, NATIVE_ADDRESS, type ChainInfo } from './chains.js';

/**
 * Curated asset registry. Decimals and addresses come from here, never from a
 * symbol guess. A token address that is not listed is rejected as unsupported,
 * because the service cannot verify its decimals or identity.
 */
export type PegGroup = 'USD' | 'ETH' | 'POL';

export interface AssetInfo {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
  peg: PegGroup;
}

type Row = [chainId: number, symbol: string, name: string, address: string, decimals: number, peg: PegGroup];

const ROWS: Row[] = [
  // Native USDC (Circle)
  [1, 'USDC', 'USD Coin', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USD'],
  [10, 'USDC', 'USD Coin', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, 'USD'],
  [137, 'USDC', 'USD Coin', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6, 'USD'],
  [8453, 'USDC', 'USD Coin', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USD'],
  [42161, 'USDC', 'USD Coin', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USD'],
  // Tether
  [1, 'USDT', 'Tether USD', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'USD'],
  [10, 'USDT', 'Tether USD', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6, 'USD'],
  [137, 'USDT', 'Tether USD', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'USD'],
  [42161, 'USDT', 'Tether USD', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USD'],
  // Wrapped ether
  [1, 'WETH', 'Wrapped Ether', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'ETH'],
  [10, 'WETH', 'Wrapped Ether', '0x4200000000000000000000000000000000000006', 18, 'ETH'],
  [137, 'WETH', 'Wrapped Ether', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18, 'ETH'],
  [8453, 'WETH', 'Wrapped Ether', '0x4200000000000000000000000000000000000006', 18, 'ETH'],
  [42161, 'WETH', 'Wrapped Ether', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'ETH'],
];

function buildRegistry(): AssetInfo[] {
  const out: AssetInfo[] = ROWS.map(([chainId, symbol, name, address, decimals, peg]) => ({
    chainId,
    symbol,
    name,
    address: getAddress(address),
    decimals,
    native: false,
    peg,
  }));
  for (const c of CHAINS) {
    out.push({
      chainId: c.id,
      symbol: c.nativeSymbol,
      name: c.nativeSymbol === 'ETH' ? 'Ether' : 'Polygon Ecosystem Token',
      address: NATIVE_ADDRESS,
      decimals: c.nativeDecimals,
      native: true,
      peg: c.nativeSymbol === 'ETH' ? 'ETH' : 'POL',
    });
  }
  return out;
}

export const ASSETS: readonly AssetInfo[] = buildRegistry();

export type AssetResolution =
  | { ok: true; asset: AssetInfo }
  | { ok: false; code: 'UNSUPPORTED_ASSET' | 'AMBIGUOUS_ASSET' | 'INVALID_ASSET'; message: string };

/** Resolve a symbol or contract address on a given chain. Never guesses. */
export function resolveAsset(chain: ChainInfo, input: string): AssetResolution {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 64) {
    return { ok: false, code: 'INVALID_ASSET', message: 'Token identifier is empty or too long.' };
  }
  const onChain = ASSETS.filter((a) => a.chainId === chain.id);
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    if (!isAddress(raw, { strict: false })) {
      return { ok: false, code: 'INVALID_ASSET', message: `"${raw}" is not a valid EVM address.` };
    }
    const lower = raw.toLowerCase();
    const hit = onChain.find((a) => a.address.toLowerCase() === lower);
    if (!hit) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ASSET',
        message: `Token ${raw} is not in the verified registry for ${chain.key}. Use GET /v1/assets for supported tokens.`,
      };
    }
    return { ok: true, asset: hit };
  }
  const matches = onChain.filter((a) => a.symbol.toUpperCase() === raw.toUpperCase());
  if (matches.length === 0) {
    return { ok: false, code: 'UNSUPPORTED_ASSET', message: `Symbol "${raw}" is not supported on ${chain.key}.` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_ASSET',
      message: `Symbol "${raw}" matches ${matches.length} tokens on ${chain.key}; pass the contract address instead.`,
    };
  }
  return { ok: true, asset: matches[0]! };
}

export function findAsset(chainId: number, address: string): AssetInfo | undefined {
  const lower = address.toLowerCase();
  return ASSETS.find((a) => a.chainId === chainId && a.address.toLowerCase() === lower);
}
