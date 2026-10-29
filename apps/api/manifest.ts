import type { AppConfig } from '../../src/config/env.js';
import { atomicToUsdc } from '../../src/billing/x402.js';
import { PREPARE_DESCRIPTION, PREPARE_EXAMPLE, PREPARE_OUTPUTS, prepareInputs, X402_GUIDANCE } from './discovery.js';
import { BAZAAR_DESCRIPTION, QUOTE_EXAMPLE, TOOL_INPUTS, TOOL_OUTPUTS } from './opensea-tool.js';

export const VERSION = '1.0.0';

const quoteInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source_chain', 'destination_chain', 'source_token', 'destination_token', 'amount'],
  properties: {
    source_chain: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Chain key (base, arbitrum, optimism, polygon, ethereum) or chain id.' },
    destination_chain: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    source_token: { type: 'string', description: 'Registry symbol (e.g. USDC) or contract address. See GET /v1/assets.' },
    destination_token: { type: 'string' },
    amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Integer amount in the token smallest unit (USDC: 6 decimals, so 100 USDC = "100000000").' },
    sender: { type: 'string', description: 'Sender EVM address (improves accuracy; required for prepare).' },
    recipient: { type: 'string', description: 'Recipient EVM address (defaults to sender).' },
    selection_policy: { type: 'string', enum: ['highest_net_output', 'fastest'] },
    providers: { type: 'array', items: { type: 'string' } },
    max_alternatives: { type: 'integer', minimum: 0, maximum: 5 },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_slippage_bps: { type: 'integer' },
        min_output: { type: 'string' },
        max_time_seconds: { type: 'integer' },
        max_total_cost_usd: { type: 'string' },
        max_value_loss_bps: { type: 'integer' },
        require_executable: { type: 'boolean' },
        include_review: { type: 'boolean' },
      },
    },
  },
};

/**
 * Tool manifest. The exact schema required by the OpenSea Agent Tools registry must be
 * confirmed against its current spec; this document follows the common
 * name/description/endpoints/input_schema/pricing layout.
 */
export function manifest(cfg: AppConfig) {
  return {
    schema_version: '1.0',
    name: 'bridgepilot',
    display_name: 'BridgePilot — Cross-Chain Route Optimizer',
    version: VERSION,
    description:
      'Finds and compares cross-chain transfer routes across providers (LI.FI, Across), computes net received value in USD, filters unsafe or invalid routes with deterministic checks, and returns the best route with alternatives and reasons. Non-custodial: returns unsigned transactions only.',
    base_url: cfg.publicBaseUrl,
    auth: { type: cfg.x402.mode === 'facilitator' ? 'x402' : cfg.apiKeys.length ? 'api_key' : 'none', header: 'x-api-key' },
    pricing:
      cfg.x402.mode === 'facilitator'
        ? { protocol: 'x402', scheme: 'exact', network: cfg.x402.network, asset: cfg.x402.asset, amount_atomic: cfg.x402.priceAtomic, paid_paths: cfg.x402.paidPaths }
        : { protocol: 'none' },
    tools: [
      {
        name: 'quote_cross_chain_route',
        description: 'Compare cross-chain routes and return the highest net-output safe route.',
        method: 'POST',
        path: '/v1/routes/quote',
        input_schema: quoteInputSchema,
      },
      {
        name: 'prepare_cross_chain_transfer',
        description: 'Re-quote and return unsigned approval + transfer transactions for a chosen provider.',
        method: 'POST',
        path: '/v1/routes/prepare',
        input_schema: {
          ...quoteInputSchema,
          required: [...quoteInputSchema.required, 'sender', 'recipient', 'provider', 'accepted_output'],
          properties: {
            ...quoteInputSchema.properties,
            provider: { type: 'string' },
            accepted_output: { type: 'string' },
            max_output_drop_bps: { type: 'integer', minimum: 0, maximum: 500 },
          },
        },
      },
      { name: 'get_transfer_status', description: 'Track a prepared transfer.', method: 'GET', path: '/v1/routes/status/{prepared_id}', query: { tx_hash: 'string (optional, 0x + 64 hex)' } },
      { name: 'list_supported_assets', description: 'Supported chains, tokens and providers.', method: 'GET', path: '/v1/assets' },
    ],
    links: { openapi: `${cfg.publicBaseUrl}/openapi.json`, health: `${cfg.publicBaseUrl}/health` },
  };
}

/** x402scan `x-payment-info` for a paid operation (USD decimal price), or nothing when x402 is off. */
function paymentInfo(cfg: AppConfig, path: string) {
  if (cfg.x402.mode !== 'facilitator' || !cfg.x402.paidPaths.includes(path)) return {};
  return { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: atomicToUsdc(cfg.x402.priceAtomic) }, protocols: [{ x402: {} }] } };
}

const payment402 = {
  description: 'Payment Required: x402 v1 challenge in the body, v2 in the PAYMENT-REQUIRED header',
  headers: { 'PAYMENT-REQUIRED': { schema: { type: 'string' }, description: 'base64 JSON x402 v2 PaymentRequired' } },
  content: { 'application/json': { schema: { type: 'object', properties: { x402Version: { type: 'integer' }, error: { type: 'string' }, accepts: { type: 'array', items: { type: 'object' } } } } } },
};

export function openapi(cfg: AppConfig) {
  const err = { $ref: '#/components/schemas/Error' };
  const json = (schema: unknown, example?: unknown) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
  return {
    openapi: '3.1.0',
    info: { title: 'BridgePilot API', version: VERSION, description: 'Cross-chain route optimizer for AI agents (LI.FI, Across). Non-custodial.', 'x-guidance': X402_GUIDANCE, contact: { name: 'BridgePilot', url: cfg.publicBaseUrl } },
    servers: [{ url: cfg.publicBaseUrl }],
    paths: {
      '/v1/routes/quote': {
        post: {
          operationId: 'quoteCrossChainRoute', summary: 'Best cross-chain route quote', description: BAZAAR_DESCRIPTION,
          ...paymentInfo(cfg, '/v1/routes/quote'),
          requestBody: { required: true, content: json(TOOL_INPUTS, QUOTE_EXAMPLE) },
          responses: { 200: { description: 'Quote result', content: json(TOOL_OUTPUTS) }, 400: err, 402: payment402, 429: err },
        },
      },
      '/v1/routes/prepare': {
        post: {
          operationId: 'prepareCrossChainTransfer', summary: 'Unsigned transactions for a chosen route', description: PREPARE_DESCRIPTION,
          ...paymentInfo(cfg, '/v1/routes/prepare'),
          requestBody: { required: true, content: json(prepareInputs(), PREPARE_EXAMPLE) },
          responses: { 200: { description: 'Unsigned transactions', content: json(PREPARE_OUTPUTS) }, 400: err, 402: payment402, 409: err, 422: err },
        },
      },
      '/v1/routes/status/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true }, { name: 'tx_hash', in: 'query' }], responses: { 200: { description: 'Status' }, 404: err } } },
      '/v1/assets': { get: { responses: { 200: { description: 'Supported assets' } } } },
      '/health': { get: { responses: { 200: { description: 'OK' } } } },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: { status: { const: 'error' }, request_id: { type: 'string' }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
  };
}
