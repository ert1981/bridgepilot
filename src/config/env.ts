import { getAddress, isAddress } from 'viem';
import { CHAINS } from './chains.js';
import { PAYAI_FACILITATOR_URL } from '../billing/x402.js';
import { CDP_FACILITATOR_URL, parseCdpSecret, type CdpCredentials } from '../billing/cdp-auth.js';

export type ProviderMode = 'live' | 'simulated';
export type X402Mode = 'off' | 'facilitator';

export interface AppConfig {
  port: number;
  host: string;
  providerMode: ProviderMode;
  enabledProviders: string[];

  lifi: { baseUrl: string; apiKey?: string; integrator: string; quotePlaceholderAddress: `0x${string}` };
  across: { baseUrl: string; apiKey?: string; integratorId?: string; depositGasUnits: bigint; executionEnabled: boolean };

  rpcUrls: Record<number, string>;

  /** Per-request budget. */
  providerTimeoutMs: number;
  providerRetries: number;
  requestBudgetMs: number;
  maxProvidersPerRequest: number;

  /** Quote validity window when the provider does not state one. */
  quoteTtlMs: number;
  quoteSafetyMarginMs: number;
  quoteCacheTtlMs: number;
  priceCacheTtlMs: number;

  /** Hard safety caps. User constraints may tighten but never loosen these. */
  hardMaxSlippageBps: number;
  defaultSlippageBps: number;
  hardMaxValueLossBps: number;
  sameAssetOutputToleranceBps: number;
  tieToleranceBps: number;
  allowStablePegFallback: boolean;

  /** Contract allowlists per chain (lower-case). */
  executionAllowlist: Record<number, string[]>;
  /** Provider/tool ids with a critical security alert. */
  securityDenylist: string[];

  apiKeys: string[];
  adminKeys: string[];
  rateLimit: { capacity: number; refillPerSec: number };
  maxBodyBytes: number;

  x402: {
    mode: X402Mode;
    facilitatorUrl: string;
    /** 'cdp' only when BOTH CDP_API_KEY_ID and CDP_API_KEY_SECRET are set (needed for Bazaar / agentic.market). */
    facilitatorKind: 'payai' | 'cdp';
    /** CDP key pair, in memory only (never logged or returned). */
    cdp?: CdpCredentials;
    network: string;
    asset: string;
    payTo?: `0x${string}`;
    priceAtomic: string;
    maxTimeoutSeconds: number;
    paidPaths: string[];
  };

  auditLogPath?: string;
  publicBaseUrl: string;
  /** ERC-8257 manifest creatorAddress (lower-case) for the OpenSea Tools listing. Unset = manifest disabled. */
  toolCreatorAddress?: string;
  /** SQLite file for durable records + shared payment nonces. Unset = in-memory (single process, dev only). */
  storagePath?: string;
  circuit: { failureThreshold: number; cooldownMs: number };
  approvalGasUnits: bigint;
  /** ERC-8004 agentId after the owner registered in the Identity Registry (listed in agent-registration.json). */
  erc8004AgentId?: string;
  /** 402index.io domain verification hash override (served at /.well-known/402index-verify.txt). */
  index402Verify?: string;
  /** "gateway" only inside an MCPize-hosted container: the gateway bills tool calls, /mcp does not charge again. */
  mcpBilling: 'x402' | 'gateway';
}

const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const ACROSS_SPOKE: Record<number, string> = {
  1: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
  10: '0x6f26bf09b1c792e3228e5467807a900a503c0281',
  137: '0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096',
  8453: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64',
  42161: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a',
};

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function int(v: string | undefined, d: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid integer config value "${v}"`);
  return n;
}
function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const providerMode = (env.PROVIDER_MODE ?? 'live') as ProviderMode;
  if (!['live', 'simulated'].includes(providerMode)) throw new Error('PROVIDER_MODE must be live|simulated');
  const x402Mode = (env.X402_MODE ?? 'off') as X402Mode;
  if (!['off', 'facilitator'].includes(x402Mode)) throw new Error('X402_MODE must be off|facilitator');

  const rpcUrls: Record<number, string> = {};
  for (const c of CHAINS) rpcUrls[c.id] = env[`RPC_URL_${c.key.toUpperCase()}`] ?? c.defaultRpcUrl;

  const executionAllowlist: Record<number, string[]> = {};
  for (const c of CHAINS) {
    const extra = list(env[`EXTRA_ALLOWED_CONTRACTS_${c.key.toUpperCase()}`]).map((a) => a.toLowerCase());
    executionAllowlist[c.id] = [LIFI_DIAMOND, ...(ACROSS_SPOKE[c.id] ? [ACROSS_SPOKE[c.id]!] : []), ...extra];
  }

  const payTo = env.X402_PAY_TO;
  if (payTo && !isAddress(payTo)) throw new Error('X402_PAY_TO is not a valid address');
  if (x402Mode === 'facilitator' && !payTo) throw new Error('X402_PAY_TO is required when X402_MODE=facilitator');

  const toolCreator = env.TOOL_CREATOR_ADDRESS;
  if (toolCreator && !isAddress(toolCreator, { strict: false })) throw new Error('TOOL_CREATOR_ADDRESS is not a valid address');
  const priceAtomic = env.X402_PRICE_ATOMIC || '10000';
  if (!/^[1-9][0-9]{0,15}$/.test(priceAtomic)) throw new Error('X402_PRICE_ATOMIC must be a positive integer (USDC 6-decimal units)');
  const facilitatorUrl = env.X402_FACILITATOR_URL || PAYAI_FACILITATOR_URL;
  if (!/^https:\/\//.test(facilitatorUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(facilitatorUrl)) {
    throw new Error('X402_FACILITATOR_URL must use https');
  }

  // CDP Facilitator only when BOTH key env vars are set; otherwise the configured (PayAI) facilitator, unchanged.
  const cdpKeyId = (env.CDP_API_KEY_ID ?? '').trim();
  const cdpKeySecret = (env.CDP_API_KEY_SECRET ?? '').trim();
  let cdp: CdpCredentials | undefined;
  if (cdpKeyId && cdpKeySecret) {
    try {
      parseCdpSecret(cdpKeySecret);
      cdp = { keyId: cdpKeyId, keySecret: cdpKeySecret };
    } catch {
      // Unusable secret: keep serving with the default facilitator rather than failing to start (key never logged).
      console.warn('CDP_API_KEY_ID/CDP_API_KEY_SECRET set but the secret is not a usable key; using the default facilitator');
    }
  }
  const effectiveFacilitatorUrl = cdp ? CDP_FACILITATOR_URL : facilitatorUrl.endsWith('/') ? facilitatorUrl : `${facilitatorUrl}/`;

  const hardMaxSlippageBps = int(env.HARD_MAX_SLIPPAGE_BPS, 300, 1, 5000);

  return {
    port: int(env.PORT, 8080, 0, 65535),
    host: env.HOST ?? '0.0.0.0',
    providerMode,
    enabledProviders: list(env.ENABLED_PROVIDERS).length ? list(env.ENABLED_PROVIDERS) : ['lifi', 'across'],
    lifi: {
      baseUrl: env.LIFI_BASE_URL ?? 'https://li.quest/v1/',
      apiKey: env.LIFI_API_KEY || undefined,
      integrator: env.LIFI_INTEGRATOR ?? 'bridgepilot',
      quotePlaceholderAddress: getAddress(env.LIFI_QUOTE_PLACEHOLDER ?? '0x0000000000000000000000000000000000000001'),
    },
    across: {
      baseUrl: env.ACROSS_BASE_URL ?? 'https://app.across.to/api/',
      apiKey: env.ACROSS_API_KEY || undefined,
      integratorId: env.ACROSS_INTEGRATOR_ID || undefined,
      depositGasUnits: BigInt(int(env.ACROSS_DEPOSIT_GAS_UNITS, 120_000, 21_000, 5_000_000)),
      executionEnabled: bool(env.ACROSS_EXECUTION_ENABLED, false),
    },
    rpcUrls,
    providerTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 6000, 100, 60_000),
    providerRetries: int(env.PROVIDER_RETRIES, 1, 0, 3),
    requestBudgetMs: int(env.REQUEST_BUDGET_MS, 12_000, 200, 120_000),
    maxProvidersPerRequest: int(env.MAX_PROVIDERS_PER_REQUEST, 4, 1, 20),
    quoteTtlMs: int(env.QUOTE_TTL_MS, 60_000, 1000),
    quoteSafetyMarginMs: int(env.QUOTE_SAFETY_MARGIN_MS, 5000, 0),
    quoteCacheTtlMs: int(env.QUOTE_CACHE_TTL_MS, 10_000, 0),
    priceCacheTtlMs: int(env.PRICE_CACHE_TTL_MS, 30_000, 0),
    hardMaxSlippageBps,
    defaultSlippageBps: Math.min(int(env.DEFAULT_SLIPPAGE_BPS, 50, 1, 5000), hardMaxSlippageBps),
    hardMaxValueLossBps: int(env.HARD_MAX_VALUE_LOSS_BPS, 500, 1, 10_000),
    sameAssetOutputToleranceBps: int(env.SAME_ASSET_OUTPUT_TOLERANCE_BPS, 50, 0, 10_000),
    tieToleranceBps: int(env.TIE_TOLERANCE_BPS, 1, 0, 1000),
    allowStablePegFallback: bool(env.ALLOW_STABLE_PEG_FALLBACK, true),
    executionAllowlist,
    securityDenylist: list(env.SECURITY_DENYLIST).map((s) => s.toLowerCase()),
    apiKeys: list(env.API_KEYS),
    adminKeys: list(env.ADMIN_KEYS),
    rateLimit: { capacity: int(env.RATE_LIMIT_CAPACITY, 30, 1), refillPerSec: Number(env.RATE_LIMIT_REFILL_PER_SEC ?? 0.5) },
    maxBodyBytes: int(env.MAX_BODY_BYTES, 16_384, 256, 1_048_576),
    x402: {
      mode: x402Mode,
      facilitatorUrl: effectiveFacilitatorUrl,
      facilitatorKind: cdp ? 'cdp' : 'payai',
      ...(cdp ? { cdp } : {}),
      network: env.X402_NETWORK ?? 'base',
      asset: env.X402_ASSET ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: payTo ? getAddress(payTo) : undefined,
      priceAtomic,
      maxTimeoutSeconds: int(env.X402_MAX_TIMEOUT_SECONDS, 60, 5, 3600),
      paidPaths: list(env.X402_PAID_PATHS).length ? list(env.X402_PAID_PATHS) : ['/v1/routes/quote', '/v1/routes/prepare'],
    },
    auditLogPath: env.AUDIT_LOG_PATH || undefined,
    storagePath: env.STORAGE_PATH || undefined,
    circuit: { failureThreshold: int(env.CIRCUIT_FAILURE_THRESHOLD, 5, 1, 1000), cooldownMs: int(env.CIRCUIT_COOLDOWN_MS, 30_000, 0) },
    approvalGasUnits: BigInt(int(env.APPROVAL_GAS_UNITS, 55_000, 21_000, 1_000_000)),
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
    toolCreatorAddress: toolCreator ? toolCreator.toLowerCase() : undefined,
    erc8004AgentId: /^[0-9]{1,30}$/.test((env.ERC8004_AGENT_ID ?? '').trim()) ? env.ERC8004_AGENT_ID!.trim() : undefined,
    index402Verify: /^[A-Za-z0-9_-]{8,200}$/.test((env.INDEX402_VERIFY ?? '').trim()) ? env.INDEX402_VERIFY!.trim() : undefined,
    mcpBilling: (env.MCP_BILLING ?? '').trim().toLowerCase() === 'gateway' ? 'gateway' : 'x402',
  };
}
