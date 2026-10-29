/**
 * ERC-8257 tool manifest for listing BridgePilot's route-quote endpoint on OpenSea Tools.
 *
 * Spec: https://docs.opensea.io/docs/tool-manifest — validated with `npx @opensea/tool-sdk validate`.
 * The manifest is served from the same origin as the endpoint, at /.well-known/ai-tool/<slug>.json.
 * Its JCS keccak256 hash is what gets registered onchain, so its content must stay stable: changing
 * PUBLIC_BASE_URL, TOOL_CREATOR_ADDRESS, X402_PAY_TO, X402_PRICE_ATOMIC or X402_NETWORK changes the
 * hash and requires `updateToolMetadata` onchain.
 *
 * Only the routing API (POST /v1/routes/quote) is exposed as the tool. The testnet bridge protocol
 * (contracts/, protocol/) is NOT part of the listing.
 */
import { keccak256, toBytes } from 'viem';
import type { AppConfig } from '../../src/config/env.js';
import { atomicToUsdc, USDC_NETWORKS } from '../../src/billing/x402.js';
import { VERSION } from './manifest.js';

export const TOOL_SLUG = 'bridgepilot-cross-chain-quote';
export const TOOL_PATH = '/v1/routes/quote';
export const MANIFEST_PATH = `/.well-known/ai-tool/${TOOL_SLUG}.json`;
export const MANIFEST_RE = new RegExp(`^${MANIFEST_PATH.replace(/[.\/]/g, (c) => `\\${c}`)}$`);
export const ICON_PATH = '/static/icon.png';
export const MANIFEST_TYPE = 'https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1';
export const SERVICE_NAME = 'BridgePilot';

const chainRef = { type: ['string', 'integer'], description: 'Chain key (ethereum, base, arbitrum, optimism, polygon) or numeric chain id.' };

/** Same contract as QuoteRequestSchema (request.schema.ts); kept in sync by tests. */
export const TOOL_INPUTS = {
  type: 'object',
  additionalProperties: false,
  required: ['source_chain', 'destination_chain', 'source_token', 'destination_token', 'amount'],
  properties: {
    source_chain: chainRef,
    destination_chain: chainRef,
    source_token: { type: 'string', maxLength: 64, description: 'Token symbol from GET /v1/assets (e.g. USDC, ETH) or token contract address.' },
    destination_token: { type: 'string', maxLength: 64, description: 'Token symbol or contract address on the destination chain.' },
    amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Integer amount in the token smallest unit (USDC has 6 decimals: 100 USDC = "100000000").' },
    sender: { type: 'string', description: 'Optional sender EVM address (improves quote accuracy).' },
    recipient: { type: 'string', description: 'Optional recipient EVM address (defaults to sender).' },
    selection_policy: { type: 'string', enum: ['highest_net_output', 'fastest'], default: 'highest_net_output' },
    providers: { type: 'array', items: { type: 'string', enum: ['lifi', 'across'] }, description: 'Optional subset of providers to query.' },
    max_alternatives: { type: 'integer', minimum: 0, maximum: 5 },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_slippage_bps: { type: 'integer', minimum: 1, maximum: 10000 },
        min_output: { type: 'string', description: 'Minimum acceptable output in destination token base units.' },
        max_time_seconds: { type: 'integer', minimum: 1 },
        max_total_cost_usd: { type: 'string', description: 'USD decimal string, e.g. "1.50".' },
        max_value_loss_bps: { type: 'integer', minimum: 1, maximum: 10000 },
        require_executable: { type: 'boolean' },
        include_review: { type: 'boolean' },
      },
    },
  },
};

export const TOOL_OUTPUTS = {
  type: 'object',
  description: 'Best cross-chain route among the quotes received (LI.FI, Across), with alternatives, net value in USD, costs and safety findings. Estimates, not a guarantee.',
  properties: {
    request_id: { type: 'string' },
    status: { type: 'string', enum: ['success', 'no_valid_route', 'providers_unavailable'] },
    simulated: { type: 'boolean' },
    selection_policy: { type: 'string' },
    data_as_of: { type: 'string' },
    providers_queried: { type: 'array', items: { type: 'string' } },
    input: { type: 'object' },
    effective_constraints: { type: 'object' },
    best_route: {
      type: ['object', 'null'],
      properties: {
        provider: { type: 'string' },
        tool: { type: 'string' },
        expected_output: { type: 'string' },
        min_output: { type: 'string' },
        estimated_time_seconds: { type: ['integer', 'null'] },
        quote_expires_at: { type: 'string' },
        costs: { type: 'object' },
        risk_status: { type: 'string', enum: ['pass', 'review', 'reject'] },
        findings: { type: 'array' },
      },
    },
    alternatives: { type: 'array', items: { type: 'object' } },
    excluded: { type: 'array', items: { type: 'object' }, description: 'Quotes removed by the safety filters, with reasons.' },
    provider_errors: { type: 'array', items: { type: 'object' } },
    explanation: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array' },
    next_step: { type: 'string' },
    execution_required: { type: 'boolean' },
    generated_at: { type: 'string' },
  },
};

export const TOOL_TAGS = ['ai', 'defi', 'bridge', 'cross-chain', 'routing', 'trading', 'base'];

export const BAZAAR_DESCRIPTION =
  'Cross-chain bridge route quotes: compares LI.FI and Across for EVM transfers (Ethereum, Base, Arbitrum, Optimism, Polygon), ' +
  'computes net received value in USD, filters unsafe routes and ranks the best one with alternatives. Quote only, non-custodial.';

export const QUOTE_EXAMPLE = {
  source_chain: 'base', destination_chain: 'arbitrum', source_token: 'USDC', destination_token: 'USDC', amount: '100000000',
};

export class ManifestNotConfigured extends Error {}

export function manifestStatus(cfg: AppConfig): { ok: true; base: string; creator: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(cfg.publicBaseUrl);
  } catch {
    return { ok: false, reason: 'PUBLIC_BASE_URL is not a valid URL.' };
  }
  if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    return { ok: false, reason: 'PUBLIC_BASE_URL must be a bare https:// origin.' };
  }
  if (!cfg.toolCreatorAddress || !/^0x[0-9a-f]{40}$/.test(cfg.toolCreatorAddress)) return { ok: false, reason: 'TOOL_CREATOR_ADDRESS is not set.' };
  if (cfg.x402.mode !== 'facilitator' || !cfg.x402.payTo) return { ok: false, reason: 'X402_MODE=facilitator and X402_PAY_TO are required.' };
  if (!cfg.x402.paidPaths.includes(TOOL_PATH)) return { ok: false, reason: `${TOOL_PATH} must be in X402_PAID_PATHS.` };
  if (cfg.providerMode !== 'live') return { ok: false, reason: 'PROVIDER_MODE=live is required (simulated quotes are never listed).' };
  if (!USDC_NETWORKS[cfg.x402.network]) return { ok: false, reason: `X402_NETWORK ${cfg.x402.network} is not supported.` };
  return { ok: true, base: u.origin, creator: cfg.toolCreatorAddress };
}

/** Manifest `pricing`, identical to @opensea/tool-sdk x402UsdcPricing(). */
export function pricing(cfg: AppConfig) {
  const [chainId, asset] = USDC_NETWORKS[cfg.x402.network]!;
  return [{
    amount: cfg.x402.priceAtomic,
    asset: `eip155:${chainId}/erc20:${asset}`,
    recipient: `eip155:${chainId}:${cfg.x402.payTo!.toLowerCase()}`,
    protocol: 'x402',
  }];
}

export function buildToolManifest(cfg: AppConfig) {
  const st = manifestStatus(cfg);
  if (!st.ok) throw new ManifestNotConfigured(st.reason);
  return {
    type: MANIFEST_TYPE,
    name: 'BridgePilot Cross-Chain Route Quote',
    description:
      `Compares cross-chain transfer routes from LI.FI and Across across Ethereum, Base, Arbitrum, Optimism and Polygon, computes the net amount received in USD after fees and gas, ` +
      `filters unsafe or invalid quotes with deterministic checks and returns the best route with alternatives and reasons. Quote only and non-custodial. ${atomicToUsdc(cfg.x402.priceAtomic)} USDC per call via x402.`,
    version: VERSION,
    endpoint: `${st.base}${TOOL_PATH}`,
    image: `${st.base}${ICON_PATH}`,
    inputs: TOOL_INPUTS,
    outputs: TOOL_OUTPUTS,
    creatorAddress: st.creator,
    tags: TOOL_TAGS,
    pricing: pricing(cfg),
    verifiability: {
      tier: 'self-attested',
      execution: 'server',
      description: 'Queries the public LI.FI and Across quote APIs and public RPC gas prices at request time; ranking and safety filters are deterministic code, no language model.',
      dataRetention: 'metadata-only',
    },
  };
}

/** RFC 8785 JSON Canonicalization Scheme (same output as the `canonicalize` package used by tool-sdk). */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalize(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}

/** JCS keccak256 manifest hash, equal to `npx @opensea/tool-sdk hash`. */
export function manifestHash(manifest: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalize(manifest)));
}

/** `extensions.bazaar` for the JSON-body POST route (x402 v2 discovery metadata). */
export function bazaarExtension(priceUsdc: string) {
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: QUOTE_EXAMPLE },
        output: {
          type: 'json',
          example: {
            status: 'success', simulated: false, selection_policy: 'highest_net_output',
            best_route: { provider: 'across', expected_output: '99981420', estimated_time_seconds: 2, risk_status: 'pass' },
            alternatives: [{ provider: 'lifi', expected_output: '99750000' }],
            price_usdc: priceUsdc,
          },
        },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: TOOL_INPUTS,
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: { ...TOOL_OUTPUTS } },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  };
}
