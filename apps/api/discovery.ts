/**
 * x402 discovery metadata beyond the OpenSea listing: Bazaar extension for /v1/routes/prepare, schemas for
 * openapi.json (x402scan reads `x-payment-info`, input and output schemas) and /.well-known/x402.
 * Nothing here feeds the ERC-8257 manifest (its onchain hash must not change).
 */
import { TOOL_INPUTS } from './opensea-tool.js';

export const PREPARE_PATH = '/v1/routes/prepare';

export const PREPARE_DESCRIPTION =
  'Re-quotes a chosen cross-chain route and returns unsigned approval and transfer transactions after deterministic checks ' +
  '(allowlisted contract, decoded calldata, output tolerance). Non-custodial: the caller signs with their own wallet.';

/** A function, not a constant: opensea-tool.ts and manifest.ts import each other (ESM cycle). */
export const prepareInputs = () => ({
  ...TOOL_INPUTS,
  required: [...TOOL_INPUTS.required, 'sender', 'recipient', 'provider', 'accepted_output'],
  properties: {
    ...TOOL_INPUTS.properties,
    sender: { type: 'string', description: 'Sender EVM address (signs the transactions).' },
    recipient: { type: 'string', description: 'Recipient EVM address on the destination chain.' },
    provider: { type: 'string', enum: ['lifi', 'across'], description: 'Provider chosen from the quote.' },
    accepted_output: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Output accepted from the quote, destination token base units.' },
    max_output_drop_bps: { type: 'integer', minimum: 0, maximum: 500 },
  },
});

export const PREPARE_OUTPUTS = {
  type: 'object',
  description: 'Unsigned transactions to sign with your own wallet, plus a human-readable summary and the checks passed.',
  properties: {
    request_id: { type: 'string' },
    prepared_id: { type: 'string' },
    status: { type: 'string' },
    expires_at: { type: 'string' },
    summary: { type: 'object' },
    route: { type: 'object' },
    transactions: { type: 'object', properties: { approvals: { type: 'array' }, main: { type: 'object' }, order: { type: 'array', items: { type: 'string' } } } },
    checks_passed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    next_step: { type: 'string' },
  },
};

export const PREPARE_EXAMPLE = {
  source_chain: 'base', destination_chain: 'arbitrum', source_token: 'USDC', destination_token: 'USDC', amount: '100000000',
  sender: '0x1111111111111111111111111111111111111111', recipient: '0x1111111111111111111111111111111111111111',
  provider: 'across', accepted_output: '99981420',
};

export const X402_GUIDANCE =
  'BridgePilot sells cross-chain route data per call with x402 (USDC on Base). POST /v1/routes/quote with {source_chain, destination_chain, ' +
  'source_token, destination_token, amount (smallest unit)} returns the best route from LI.FI and Across with alternatives and net value in USD; ' +
  'POST /v1/routes/prepare returns unsigned transactions for a chosen route. Without payment both answer HTTP 402 with x402 v1 (body) and v2 ' +
  '(PAYMENT-REQUIRED header) requirements; sign and resend with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Supported chains and tokens: GET /v1/assets. ' +
  'Also available as a remote MCP server at /mcp. Non-custodial; estimates, not guarantees.';

export function prepareBazaarExtension() {
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: PREPARE_EXAMPLE },
        output: { type: 'json', example: { prepared_id: 'prep_00000000-0000-0000-0000-000000000000', status: 'awaiting_signature', transactions: { approvals: [], main: {}, order: ['main'] } } },
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
              body: prepareInputs(),
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: { type: 'object', properties: { type: { type: 'string' }, example: { ...PREPARE_OUTPUTS } }, required: ['type'] },
        },
        required: ['input'],
      },
    },
  };
}
