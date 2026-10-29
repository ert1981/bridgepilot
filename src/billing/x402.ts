import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import type { FetchLike } from '../utils/http.js';
import { fetchJson } from '../utils/http.js';
import { MemoryNonceStore, type NonceStore } from './nonce-store.js';

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: 'application/json';
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature?: string;
    authorization?: { from?: string; to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string };
  };
}

export type VerifyResult =
  | { ok: true; payer: string; payload: PaymentPayload; replayKey: string }
  | { ok: false; reason: string };

/**
 * x402 "exact" scheme (v1) using a facilitator for signature verification and settlement.
 * Settlement only happens after the paid request succeeded, so failed calls are not charged.
 */
export class X402 {
  constructor(
    private readonly cfg: AppConfig['x402'],
    private readonly fetch: FetchLike,
    private readonly now: () => number,
    private readonly nonces: NonceStore = new MemoryNonceStore(),
  ) {}

  get enabled(): boolean {
    return this.cfg.mode === 'facilitator';
  }

  isPaidPath(path: string): boolean {
    return this.enabled && this.cfg.paidPaths.includes(path);
  }

  requirements(resource: string, description: string): PaymentRequirements {
    return {
      scheme: 'exact',
      network: this.cfg.network,
      maxAmountRequired: this.cfg.priceAtomic,
      resource,
      description,
      mimeType: 'application/json',
      payTo: this.cfg.payTo!,
      maxTimeoutSeconds: this.cfg.maxTimeoutSeconds,
      asset: this.cfg.asset,
      extra: { name: 'USD Coin', version: '2' },
    };
  }

  challenge(resource: string, description: string, error = 'X-PAYMENT header is required') {
    return { x402Version: 1, error, accepts: [this.requirements(resource, description)] };
  }

  decode(header: string): PaymentPayload | null {
    if (header.length > 8192) return null;
    try {
      const json = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
      return json && typeof json === 'object' && json.payload && typeof json.payload === 'object' ? json : null;
    } catch {
      return null;
    }
  }

  async verify(header: string, reqs: PaymentRequirements): Promise<VerifyResult> {
    const p = this.decode(header);
    if (!p) return { ok: false, reason: 'malformed X-PAYMENT header' };
    if (p.x402Version !== 1 || p.scheme !== 'exact' || p.network !== reqs.network) return { ok: false, reason: 'unsupported scheme or network' };
    const a = p.payload.authorization;
    if (!a || typeof a.to !== 'string' || typeof a.value !== 'string' || typeof a.nonce !== 'string' || typeof a.from !== 'string') {
      return { ok: false, reason: 'missing authorization' };
    }
    if (a.to.toLowerCase() !== reqs.payTo.toLowerCase()) return { ok: false, reason: 'wrong payee' };
    if (!/^[0-9]+$/.test(a.value) || BigInt(a.value) < BigInt(reqs.maxAmountRequired)) return { ok: false, reason: 'insufficient amount' };
    const nowSec = Math.floor(this.now() / 1000);
    if (!/^[0-9]+$/.test(a.validBefore ?? '') || Number(a.validBefore) <= nowSec) return { ok: false, reason: 'authorization expired' };
    if (/^[0-9]+$/.test(a.validAfter ?? '') && Number(a.validAfter) > nowSec) return { ok: false, reason: 'authorization not yet valid' };

    const replayKey = createHash('sha256').update(`${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`).digest('hex');
    // Atomic reservation BEFORE any await, shared across processes when a durable store is used.
    // Kept until the authorization can no longer be settled (validBefore) plus a safety hour.
    const expiresAt = Math.max(Number(a.validBefore) * 1000, this.now()) + 3_600_000;
    if (!this.nonces.reserve(replayKey, expiresAt, this.now())) return { ok: false, reason: 'payment already used' };

    let res: { isValid?: boolean; invalidReason?: string; payer?: string };
    try {
      res = (await fetchJson(new URL('verify', this.cfg.facilitatorUrl).toString(), {
        provider: 'x402',
        fetch: this.fetch,
        timeoutMs: 8000,
        method: 'POST',
        body: { x402Version: 1, paymentPayload: p, paymentRequirements: reqs },
        maxBytes: 32_000,
      })) as typeof res;
    } catch {
      this.nonces.release(replayKey);
      return { ok: false, reason: 'payment facilitator unavailable' };
    }
    if (res?.isValid !== true) {
      this.nonces.release(replayKey);
      return { ok: false, reason: res?.invalidReason ?? 'payment invalid' };
    }
    return { ok: true, payer: res.payer ?? a.from, payload: p, replayKey };
  }

  async settle(payload: PaymentPayload, reqs: PaymentRequirements): Promise<{ success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }> {
    try {
      return (await fetchJson(new URL('settle', this.cfg.facilitatorUrl).toString(), {
        provider: 'x402',
        fetch: this.fetch,
        timeoutMs: 15_000,
        method: 'POST',
        body: { x402Version: 1, paymentPayload: payload, paymentRequirements: reqs },
        maxBytes: 32_000,
      })) as { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string };
    } catch {
      return { success: false, errorReason: 'facilitator unavailable' };
    }
  }

  /** Release a reserved nonce when the paid request failed before settlement. */
  release(replayKey: string): void {
    this.nonces.release(replayKey);
  }

}
