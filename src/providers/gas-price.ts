import type { FetchLike } from '../utils/http.js';
import { fetchJson } from '../utils/http.js';
import { parseUint } from '../utils/units.js';

/** Reads eth_gasPrice from chain RPCs with a short cache. Returns null on failure. */
export class GasPriceService {
  private cache = new Map<number, { value: bigint; at: number }>();

  constructor(
    private readonly rpcUrls: Record<number, string>,
    private readonly fetch: FetchLike,
    private readonly now: () => number,
    private readonly ttlMs = 15_000,
    private readonly timeoutMs = 3000,
  ) {}

  async gasPriceWei(chainId: number, signal?: AbortSignal): Promise<bigint | null> {
    const hit = this.cache.get(chainId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const url = this.rpcUrls[chainId];
    if (!url) return null;
    try {
      const res = (await fetchJson(url, {
        provider: `rpc:${chainId}`,
        fetch: this.fetch,
        timeoutMs: this.timeoutMs,
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] },
        signal,
        maxBytes: 4096,
      })) as { result?: unknown };
      if (typeof res?.result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(res.result)) return null;
      const value = BigInt(res.result);
      if (value <= 0n || value > 10n ** 15n) return null; // > 1M gwei is not plausible
      this.cache.set(chainId, { value, at: this.now() });
      return value;
    } catch {
      return null;
    }
  }

  /** Read an ERC-20 allowance. Returns null when the RPC is unreachable. */
  async allowance(chainId: number, token: string, owner: string, spender: string, signal?: AbortSignal): Promise<bigint | null> {
    const url = this.rpcUrls[chainId];
    if (!url) return null;
    const data = '0xdd62ed3e' + owner.slice(2).toLowerCase().padStart(64, '0') + spender.slice(2).toLowerCase().padStart(64, '0');
    try {
      const res = (await fetchJson(url, {
        provider: `rpc:${chainId}`,
        fetch: this.fetch,
        timeoutMs: this.timeoutMs,
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] },
        signal,
        maxBytes: 4096,
      })) as { result?: unknown };
      if (typeof res?.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(res.result)) return null;
      return parseUint(BigInt(res.result).toString());
    } catch {
      return null;
    }
  }
}
