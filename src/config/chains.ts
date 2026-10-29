/**
 * Supported EVM chains. Chain identity is always resolved to a numeric chain id;
 * a request that names an unknown chain is rejected instead of guessed.
 */
export interface ChainInfo {
  id: number;
  key: string;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Address used by aggregators for the native coin. */
  nativeAddress: `0x${string}`;
  /** Default public RPC; override with RPC_URL_<KEY> env var. */
  defaultRpcUrl: string;
}

export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const CHAINS: readonly ChainInfo[] = [
  { id: 1, key: 'ethereum', name: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18, nativeAddress: NATIVE_ADDRESS, defaultRpcUrl: 'https://ethereum-rpc.publicnode.com' },
  { id: 10, key: 'optimism', name: 'OP Mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, nativeAddress: NATIVE_ADDRESS, defaultRpcUrl: 'https://mainnet.optimism.io' },
  { id: 137, key: 'polygon', name: 'Polygon PoS', nativeSymbol: 'POL', nativeDecimals: 18, nativeAddress: NATIVE_ADDRESS, defaultRpcUrl: 'https://polygon-rpc.com' },
  { id: 8453, key: 'base', name: 'Base', nativeSymbol: 'ETH', nativeDecimals: 18, nativeAddress: NATIVE_ADDRESS, defaultRpcUrl: 'https://mainnet.base.org' },
  { id: 42161, key: 'arbitrum', name: 'Arbitrum One', nativeSymbol: 'ETH', nativeDecimals: 18, nativeAddress: NATIVE_ADDRESS, defaultRpcUrl: 'https://arb1.arbitrum.io/rpc' },
];

const byId = new Map(CHAINS.map((c) => [c.id, c]));
const byKey = new Map(CHAINS.map((c) => [c.key, c]));

/** Resolve "base", "8453" or 8453 to a chain. Returns undefined for anything else. */
export function resolveChain(input: string | number): ChainInfo | undefined {
  if (typeof input === 'number') return Number.isSafeInteger(input) ? byId.get(input) : undefined;
  const s = input.trim().toLowerCase();
  if (/^[1-9][0-9]{0,9}$/.test(s)) return byId.get(Number(s));
  return byKey.get(s);
}

export function getChain(id: number): ChainInfo | undefined {
  return byId.get(id);
}
