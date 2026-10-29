import { resolveRequest } from '../src/agents/orchestrator.js';
import type { NormalizedQuote, ResolvedRequest } from '../src/schemas/quote.schema.js';
import type { QuoteRequestInput } from '../src/schemas/request.schema.js';
import { ARB_USDC, BASE_USDC, LIFI_DIAMOND, makeServices, NOW } from './helpers.js';

export function req(over: Partial<QuoteRequestInput> = {}): ResolvedRequest {
  const svc = makeServices({ env: { PROVIDER_MODE: 'simulated' } });
  return resolveRequest({ source_chain: 'base', destination_chain: 'arbitrum', source_token: 'USDC', destination_token: 'USDC', amount: '100000000', ...over }, svc, 'req_test').req;
}

export function quote(over: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    provider: 'provider_a',
    tool: 'tool_a',
    quoteId: 'q_a',
    sourceChainId: 8453,
    destinationChainId: 42161,
    sourceToken: BASE_USDC,
    destinationToken: ARB_USDC,
    inputAmount: 100_000_000n,
    expectedOutput: 99_600_000n,
    minOutput: 99_300_000n,
    estimatedTimeSeconds: 120,
    fetchedAt: NOW,
    expiresAt: NOW + 60_000,
    executionAvailable: true,
    executionTarget: LIFI_DIAMOND,
    approvalSpender: LIFI_DIAMOND,
    extraCosts: [{ kind: 'gas', label: 'gas', usdMicro: 100_000n, certainty: 'estimated' }],
    includedFees: [],
    warnings: [],
    ...over,
  };
}
