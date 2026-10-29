import { ProviderError } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  provider: string;
  fetch: FetchLike;
  timeoutMs: number;
  retries?: number;
  retryBaseDelayMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Parent signal (request budget). Aborting it stops retries too. */
  signal?: AbortSignal;
  /** Max response size accepted from a provider. */
  maxBytes?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

async function once(url: string, o: FetchJsonOptions): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), o.timeoutMs);
  const onParent = () => ctrl.abort(new Error('aborted'));
  o.signal?.addEventListener('abort', onParent, { once: true });
  try {
    let res: Response;
    try {
      res = await o.fetch(url, {
        method: o.method ?? 'GET',
        headers: { accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw new ProviderError(o.provider, 'ABORTED', 'request budget exhausted');
      if (ctrl.signal.aborted) throw new ProviderError(o.provider, 'TIMEOUT', `timed out after ${o.timeoutMs}ms`);
      throw new ProviderError(o.provider, 'NETWORK', `network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (o.maxBytes && text.length > o.maxBytes) {
      throw new ProviderError(o.provider, 'BAD_RESPONSE', 'response too large', res.status);
    }
    if (res.status === 429) throw new ProviderError(o.provider, 'RATE_LIMITED', 'rate limited', 429);
    if (res.status >= 500) throw new ProviderError(o.provider, 'HTTP_5XX', `HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = text.length ? JSON.parse(text) : null;
    } catch {
      throw new ProviderError(o.provider, 'BAD_RESPONSE', 'invalid JSON', res.status);
    }
    if (res.status >= 400) {
      const msg = (json as { message?: unknown } | null)?.message;
      const err = new ProviderError(
        o.provider,
        'HTTP_4XX',
        `HTTP ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : ''}`,
        res.status,
      );
      (err as ProviderError & { body?: unknown }).body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onParent);
  }
}

/** GET/POST JSON with per-attempt timeout and bounded retry on transient errors. */
export async function fetchJson(url: string, o: FetchJsonOptions): Promise<unknown> {
  const retries = o.retries ?? 0;
  let last: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, o);
    } catch (e) {
      last = e instanceof ProviderError ? e : new ProviderError(o.provider, 'NETWORK', String(e));
      if (!last.retryable || attempt === retries || o.signal?.aborted) break;
      try {
        await sleep((o.retryBaseDelayMs ?? 150) * 2 ** attempt, o.signal);
      } catch {
        throw new ProviderError(o.provider, 'ABORTED', 'request budget exhausted');
      }
    }
  }
  throw last!;
}

export function buildUrl(base: string, path: string, params: Record<string, string | number | boolean | undefined>): string {
  const u = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}
