import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import type { FetchLike } from '../utils/http.js';
import { fetchJson } from '../utils/http.js';
import { MemoryNonceStore, type NonceStore } from './nonce-store.js';
import { cdpAuthHeaders } from './cdp-auth.js';

/** PayAI hosted facilitator: the default of @opensea/tool-sdk's x402 gate (what OpenSea-listed tools use). */
export const PAYAI_FACILITATOR_URL = 'https://facilitator.payai.network/';
export const PAYMENT_REQUIRED_HEADER = 'payment-required';
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';
export const PAYMENT_RESPONSE_HEADER = 'payment-response';

/** network -> [chain id, USDC address, EIP-712 domain name of that USDC contract]. */
export const USDC_NETWORKS: Record<string, [number, string, string]> = {
  base: [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USD Coin'],
  'base-sepolia': [84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'USDC'],
};

/** x402 v1 PaymentRequirements (what @opensea/tool-sdk's hosted gate emits and reads). */
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

/** x402 v2 PaymentRequirements (CAIP-2 network, `amount` instead of `maxAmountRequired`). */
export interface PaymentRequirementsV2 {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

interface Authorization { from?: string; to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string }

interface PaymentPayload {
  x402Version: number;
  scheme?: string;
  network?: string;
  /** v2 only: the requirements the client chose to pay. */
  accepted?: Partial<PaymentRequirementsV2>;
  payload: { signature?: string; authorization?: Authorization };
  /** v2 only: the resource being paid for (CDP Bazaar catalogs it on settle). */
  resource?: unknown;
  /** v2 only: extensions echoed by the client, e.g. `bazaar` discovery metadata. */
  extensions?: Record<string, unknown>;
}

/** What the CDP Facilitator needs on the payload to index the route in the Bazaar (agentic.market). */
export interface Discovery { resource: V2Resource; extensions?: Record<string, unknown> }

export type VerifyResult =
  | { ok: true; payer: string; payload: PaymentPayload; replayKey: string; version: 1 | 2 }
  | { ok: false; reason: string };

export interface SettleResult { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }

/** Resource info + Bazaar discovery metadata for the x402 v2 PAYMENT-REQUIRED header. */
export interface V2Resource {
  url: string;
  description: string;
  mimeType: 'application/json';
  serviceName?: string;
  iconUrl?: string;
  tags?: string[];
}

/** Atomic USDC units (6 decimals) -> decimal string, e.g. "10000" -> "0.01". */
export function atomicToUsdc(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

/**
 * x402 "exact" scheme using a hosted facilitator (PayAI by default) for signature verification and
 * settlement. v1 (`X-PAYMENT`) is what OpenSea's tool-sdk speaks; v2 (`PAYMENT-SIGNATURE`) is accepted
 * too, and every 402 also carries a base64 v2 `PAYMENT-REQUIRED` header (agentic.market / Bazaar).
 * Settlement only happens after the paid request succeeded, so failed calls are not charged.
 * BridgePilot never holds a key: the facilitator broadcasts the payer's signed EIP-3009 authorization
 * and the USDC goes straight to X402_PAY_TO.
 */
/** Facilitator failure as "HTTP <status>: <reason>" for logs and the payer; long hex (signatures) elided. */
export function facilitatorFailure(e: unknown): string {
  const err = e as { httpStatus?: number; message?: string; body?: unknown };
  const b = (err?.body && typeof err.body === 'object' ? err.body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const code = str(b.invalidReason) ?? str(b.errorReason) ?? str(b.errorType) ?? str(b.error);
  const msg = str(b.invalidMessage) ?? str(b.errorMessage) ?? str(b.message);
  const reason = code || msg ? [code, msg].filter(Boolean).join(': ') : (str(err?.message) ?? 'unknown error');
  const text = (err?.httpStatus ? `HTTP ${err.httpStatus}: ` : '') + reason;
  return text.replace(/0x[0-9a-fA-F]{80,}/g, '0x…').replace(/\s+/g, ' ').slice(0, 200);
}

const warn = (event: string, detail: string) => console.warn(JSON.stringify({ level: 'warn', event, detail }));

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

  private get usdc(): [number, string, string] {
    return USDC_NETWORKS[this.cfg.network] ?? [8453, this.cfg.asset, 'USD Coin'];
  }

  /** 'cdp' when both CDP API key env vars are set, else 'payai' (or whatever X402_FACILITATOR_URL points to). */
  get facilitatorKind(): 'payai' | 'cdp' {
    return this.cfg.facilitatorKind === 'cdp' && this.cfg.cdp ? 'cdp' : 'payai';
  }

  /**
   * CDP Bazaar indexing needs `paymentPayload.resource` and `paymentPayload.extensions.bazaar` on settle.
   * Only for v2 payments through the CDP Facilitator; fields the client already sent are kept. The signed
   * EIP-3009 authorization is not touched (its signature does not cover these fields). PayAI payloads are
   * forwarded exactly as before.
   */
  withDiscovery(payload: PaymentPayload, version: 1 | 2, discovery?: Discovery): PaymentPayload {
    if (this.facilitatorKind !== 'cdp' || version !== 2 || !discovery) return payload;
    const out: PaymentPayload = { ...payload };
    if (out.resource === undefined || out.resource === null) out.resource = discovery.resource;
    const bazaar = discovery.extensions?.bazaar;
    if (bazaar !== undefined) {
      const ext = out.extensions && typeof out.extensions === 'object' && !Array.isArray(out.extensions) ? { ...out.extensions } : {};
      if (ext.bazaar === undefined) ext.bazaar = bazaar;
      out.extensions = ext;
    }
    return out;
  }

  get caip2(): string {
    return `eip155:${this.usdc[0]}`;
  }

  get priceUsdc(): string {
    return atomicToUsdc(this.cfg.priceAtomic);
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
      extra: { name: this.usdc[2], version: '2' },
    };
  }

  requirementsV2(): PaymentRequirementsV2 {
    return {
      scheme: 'exact',
      network: this.caip2,
      asset: this.cfg.asset,
      amount: this.cfg.priceAtomic,
      payTo: this.cfg.payTo!,
      maxTimeoutSeconds: this.cfg.maxTimeoutSeconds,
      extra: { name: this.usdc[2], version: '2' },
    };
  }

  challenge(resource: string, description: string, error = 'X-PAYMENT header is required') {
    return { x402Version: 1, error, accepts: [this.requirements(resource, description)] };
  }

  /** x402 v2 PaymentRequired object (sent base64-encoded in the PAYMENT-REQUIRED header). */
  challengeV2(resource: V2Resource, error: string, extensions?: Record<string, unknown>) {
    return { x402Version: 2, error, resource, accepts: [this.requirementsV2()], ...(extensions ? { extensions } : {}) };
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

  /**
   * @param header  X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) value
   * @param viaV2Header true when the value came from PAYMENT-SIGNATURE
   */
  async verify(header: string, reqs: PaymentRequirements, viaV2Header = false, discovery?: Discovery): Promise<VerifyResult> {
    const decoded = this.decode(header);
    if (!decoded) return { ok: false, reason: 'malformed X-PAYMENT header' };
    const version: 1 | 2 = viaV2Header || decoded.x402Version === 2 ? 2 : 1;
    const p = this.withDiscovery(decoded, version, discovery);
    const v2 = this.requirementsV2();
    if (version === 2) {
      const acc = p.accepted;
      if (p.x402Version !== 2 || !acc || typeof acc !== 'object') return { ok: false, reason: 'unsupported scheme or network' };
      for (const k of ['scheme', 'network', 'asset', 'amount', 'payTo'] as const) {
        if (String(acc[k] ?? '').toLowerCase() !== String(v2[k]).toLowerCase()) return { ok: false, reason: 'payment requirements mismatch' };
      }
    } else if (p.x402Version !== 1 || p.scheme !== 'exact' || p.network !== reqs.network) {
      return { ok: false, reason: 'unsupported scheme or network' };
    }
    const a = p.payload.authorization;
    if (!a || typeof a.to !== 'string' || typeof a.value !== 'string' || typeof a.nonce !== 'string' || typeof a.from !== 'string') {
      return { ok: false, reason: 'missing authorization' };
    }
    if (a.to.toLowerCase() !== reqs.payTo.toLowerCase()) return { ok: false, reason: 'wrong payee' };
    if (!/^[0-9]+$/.test(a.value) || BigInt(a.value) < BigInt(reqs.maxAmountRequired)) return { ok: false, reason: 'insufficient amount' };
    const nowSec = Math.floor(this.now() / 1000);
    if (!/^[0-9]+$/.test(a.validBefore ?? '') || Number(a.validBefore) <= nowSec) return { ok: false, reason: 'authorization expired' };
    if (/^[0-9]+$/.test(a.validAfter ?? '') && Number(a.validAfter) > nowSec) return { ok: false, reason: 'authorization not yet valid' };

    // Same (payer, nonce) identity for v1 and v2: one onchain authorization can be used once.
    const replayKey = createHash('sha256').update(`${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`).digest('hex');
    // Atomic reservation BEFORE any await, shared across processes when a durable store is used.
    // Kept until the authorization can no longer be settled (validBefore) plus a safety hour.
    const expiresAt = Math.max(Number(a.validBefore) * 1000, this.now()) + 3_600_000;
    if (!this.nonces.reserve(replayKey, expiresAt, this.now())) return { ok: false, reason: 'payment already used' };

    let res: { isValid?: boolean; invalidReason?: string; payer?: string };
    try {
      res = (await this.post('verify', 8000, p, version === 2 ? v2 : reqs, version)) as typeof res;
    } catch (e) {
      // Facilitators answer an invalid payment with 4xx + {isValid:false, invalidReason}.
      const body = (e as { body?: { isValid?: boolean; invalidReason?: string } }).body;
      this.nonces.release(replayKey);
      const why = facilitatorFailure(e);
      if (body && body.isValid === false) {
        warn('x402_verify_rejected', why);
        return { ok: false, reason: why.replace(/^HTTP \d+: /, '').slice(0, 200) };
      }
      warn('x402_verify_failed', why);
      return { ok: false, reason: `payment facilitator unavailable (${why})`.slice(0, 240) };
    }
    if (res?.isValid !== true) {
      this.nonces.release(replayKey);
      const why = facilitatorFailure({ body: res }) || 'payment invalid';
      warn('x402_verify_rejected', why);
      return { ok: false, reason: why.slice(0, 200) };
    }
    return { ok: true, payer: res.payer ?? a.from, payload: p, replayKey, version };
  }

  async settle(payload: PaymentPayload, reqs: PaymentRequirements, version: 1 | 2 = 1): Promise<SettleResult> {
    try {
      const r = (await this.post('settle', 15_000, payload, version === 2 ? this.requirementsV2() : reqs, version)) as SettleResult;
      if (!r || r.success !== true || !r.transaction) {
        const why = r?.errorReason ? facilitatorFailure({ body: r }) : 'settlement not confirmed';
        warn('x402_settle_failed', why);
        return { success: false, errorReason: why };
      }
      return r;
    } catch (e) {
      const why = facilitatorFailure(e);
      warn('x402_settle_failed', why);
      return { success: false, errorReason: `facilitator unavailable (${why})`.slice(0, 240) };
    }
  }

  private post(path: 'verify' | 'settle', timeoutMs: number, paymentPayload: PaymentPayload, paymentRequirements: unknown, version: 1 | 2) {
    // CDP: a fresh short-lived Bearer JWT per call. PayAI: no auth headers, exactly as before.
    const auth = this.facilitatorKind === 'cdp' ? cdpAuthHeaders(this.cfg.cdp!, path, this.now()) : undefined;
    return fetchJson(new URL(path, this.cfg.facilitatorUrl).toString(), {
      provider: 'x402',
      fetch: this.fetch,
      timeoutMs,
      method: 'POST',
      ...(auth ? { headers: auth } : {}),
      body: { x402Version: version, paymentPayload, paymentRequirements },
      maxBytes: 32_000,
    });
  }

  /** Release a reserved nonce when the paid request failed before settlement. */
  release(replayKey: string): void {
    this.nonces.release(replayKey);
  }
}
