import { randomUUID } from 'node:crypto';
import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { providerContext } from '../agents/discovery-agent.js';
import { resolveRequest } from '../agents/orchestrator.js';
import { evaluateRoutes } from '../agents/risk-agent.js';
import type { PreparedTx } from '../providers/provider-interface.js';
import type { PrepareRequestInput } from '../schemas/request.schema.js';
import { routeView } from '../schemas/response.schema.js';
import type { Services } from '../services.js';
import type { PreparedRecord } from '../storage/store.js';
import { ApiError, ProviderError } from '../utils/errors.js';
import { formatScaled } from '../utils/units.js';

const DEFAULT_MAX_OUTPUT_DROP_BPS = 30;
/** Tokens that revert when changing a non-zero allowance to another non-zero value. */
const RESET_ALLOWANCE_TOKENS = new Set(['1:0xdac17f958d2ee523a2206206994597c13d831ec7']);

const txView = (t: PreparedTx) => ({
  chain_id: t.chainId,
  to: t.to,
  data: t.data,
  value: t.value.toString(),
  value_hex: `0x${t.value.toString(16)}`,
  gas_limit: t.gasLimit?.toString() ?? null,
});

/**
 * Execution Preparation: fetch a fresh quote, re-run every mandatory check, and return
 * UNSIGNED transactions. It never receives private keys and never moves funds.
 */
export async function prepareTransfer(input: PrepareRequestInput, svc: Services, ownerId: string) {
  const { provider: providerId, accepted_output, max_output_drop_bps, ...quoteInput } = input;
  const { req, warnings } = resolveRequest(
    { ...quoteInput, providers: [providerId], constraints: { ...(quoteInput.constraints ?? {}), require_executable: true } },
    svc,
  );
  if (svc.config.providerMode === 'simulated') {
    throw new ApiError(409, 'SIMULATED_MODE', 'Transaction preparation is disabled in simulated mode.');
  }
  const provider = svc.registry.get(providerId)!;
  if (!provider.buildTransaction || !provider.verifyTransaction) {
    throw new ApiError(422, 'EXECUTION_UNSUPPORTED', `Provider ${providerId} does not support verified execution.`);
  }
  const support = provider.supports(req);
  if (!support.ok) throw new ApiError(422, 'ROUTE_UNSUPPORTED', support.reason);

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), svc.config.requestBudgetMs);
  try {
    const ctx = providerContext(svc, budget.signal);
    let quotes;
    try {
      quotes = await provider.quote(req, ctx); // always fresh: no cache for execution
    } catch (e) {
      const pe = e instanceof ProviderError ? e : undefined;
      throw new ApiError(502, 'PROVIDER_ERROR', `Fresh quote failed: ${pe?.code ?? 'ERROR'}`, { provider: providerId });
    }
    const evaluated = await evaluateRoutes(quotes, req, svc, budget.signal);
    const route = evaluated[0];
    if (!route) throw new ApiError(422, 'NO_ROUTE', 'Provider returned no route.');
    if (route.risk.status === 'REJECT') {
      throw new ApiError(422, 'ROUTE_REJECTED', 'Fresh quote failed mandatory checks.', route.risk.findings.filter((f) => f.severity !== 'warn'));
    }
    if (route.risk.status === 'REVIEW' && !req.policy.includeReview) {
      throw new ApiError(422, 'ROUTE_NEEDS_REVIEW', 'Fresh quote needs review; set constraints.include_review=true to accept explicitly.', route.risk.findings);
    }

    // Guard against a materially worse quote than what the user accepted.
    const accepted = BigInt(accepted_output);
    const drop = BigInt(max_output_drop_bps ?? DEFAULT_MAX_OUTPUT_DROP_BPS);
    const floor = accepted - (accepted * drop) / 10_000n;
    if (route.quote.expectedOutput < floor) {
      throw new ApiError(409, 'QUOTE_CHANGED', 'Fresh quote is worse than the accepted output beyond tolerance; re-confirm with the user.', {
        accepted_output: accepted.toString(),
        fresh_expected_output: route.quote.expectedOutput.toString(),
        allowed_floor: floor.toString(),
      });
    }

    let main: PreparedTx;
    try {
      main = await provider.buildTransaction(route.quote, req, ctx);
    } catch (e) {
      throw new ApiError(422, 'EXECUTION_DATA_INVALID', (e as Error).message.slice(0, 200));
    }

    // Independent transaction checks (do not trust provider data blindly).
    const allow = svc.config.executionAllowlist[req.sourceChain.id] ?? [];
    const problems: string[] = [];
    if (main.chainId !== req.sourceChain.id) problems.push(`chainId ${main.chainId} != source chain ${req.sourceChain.id}`);
    if (!allow.includes(main.to.toLowerCase())) problems.push(`target ${main.to} is not allowlisted`);
    if (route.quote.executionTarget && main.to.toLowerCase() !== route.quote.executionTarget.toLowerCase()) problems.push('target differs from quoted target');
    if (main.data.length < 10) problems.push('calldata is empty');
    const expectedValue = req.sourceAsset.native ? req.amount : 0n;
    if (main.value !== expectedValue) problems.push(`native value ${main.value} != expected ${expectedValue}`);
    const txFrom = (route.quote.executionData as { transactionRequest?: { from?: string } } | undefined)?.transactionRequest?.from;
    if (txFrom && txFrom.toLowerCase() !== req.sender!.toLowerCase()) problems.push('transaction "from" differs from sender');
    // Decode the calldata itself: receiver, destination, token and amount must match the request.
    problems.push(...provider.verifyTransaction!(main, route.quote, req));
    if (problems.length) throw new ApiError(422, 'EXECUTION_DATA_INVALID', 'Provider transaction failed validation.', problems);

    // Exact-amount approval only (never unlimited).
    const approvals: PreparedTx[] = [];
    const notes: string[] = [];
    if (!req.sourceAsset.native) {
      const spender = route.quote.approvalSpender ?? main.to;
      if (!allow.includes(spender.toLowerCase())) throw new ApiError(422, 'EXECUTION_DATA_INVALID', `approval spender ${spender} is not allowlisted`);
      const current = await svc.gas.allowance(req.sourceChain.id, req.sourceAsset.address, req.sender!, spender, budget.signal);
      const approve = (amt: bigint): PreparedTx => ({
        chainId: req.sourceChain.id,
        to: req.sourceAsset.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(spender), amt] }),
        value: 0n,
      });
      if (current === null) {
        notes.push('Allowance could not be read; approval included. Skip it if the current allowance already covers the amount.');
        if (RESET_ALLOWANCE_TOKENS.has(`${req.sourceChain.id}:${req.sourceAsset.address.toLowerCase()}`)) {
          notes.push('This token requires resetting allowance to 0 first if a non-zero allowance exists.');
        }
        approvals.push(approve(req.amount));
      } else if (current < req.amount) {
        if (current > 0n && RESET_ALLOWANCE_TOKENS.has(`${req.sourceChain.id}:${req.sourceAsset.address.toLowerCase()}`)) approvals.push(approve(0n));
        approvals.push(approve(req.amount));
      } else {
        notes.push('Existing allowance covers the amount; no approval needed.');
      }
    }

    const id = `prep_${randomUUID()}`;
    const q = route.quote;
    const record: PreparedRecord = {
      id,
      requestId: req.requestId,
      provider: q.provider,
      tool: q.tool,
      sourceChainId: q.sourceChainId,
      destinationChainId: q.destinationChainId,
      sender: req.sender!,
      recipient: req.recipient!,
      sourceToken: req.sourceAsset.address,
      destinationToken: req.destinationAsset.address,
      inputAmount: req.amount.toString(),
      expectedOutput: q.expectedOutput.toString(),
      minOutput: q.minOutput?.toString() ?? null,
      estimatedTimeSeconds: q.estimatedTimeSeconds,
      netUsdMicro: route.cost.netUsdMicro?.toString() ?? null,
      createdAt: svc.now(),
      expiresAt: q.expiresAt,
      state: 'AWAITING_SIGNATURE',
      transactions: { approvals, main },
      ownerId,
    };
    await svc.store.savePrepared(record);
    svc.metrics.inc('bridgepilot_prepare_total', { provider: q.provider });
    svc.audit.record('prepare', { requestId: req.requestId, preparedId: id, provider: q.provider, amount: record.inputAmount, to: main.to });

    return {
      prepared_id: id,
      status: 'awaiting_signature',
      expires_at: new Date(q.expiresAt).toISOString(),
      summary: {
        // Everything the user must see before signing.
        source_chain: req.sourceChain.key,
        destination_chain: req.destinationChain.key,
        send: `${formatScaled(req.amount, req.sourceAsset.decimals)} ${req.sourceAsset.symbol}`,
        receive_expected: `${formatScaled(q.expectedOutput, req.destinationAsset.decimals)} ${req.destinationAsset.symbol}`,
        receive_minimum: q.minOutput !== null ? `${formatScaled(q.minOutput, req.destinationAsset.decimals)} ${req.destinationAsset.symbol}` : null,
        recipient: req.recipient,
        provider: q.provider,
        bridge: q.tool ?? null,
      },
      route: routeView(route, req),
      transactions: {
        approvals: approvals.map(txView),
        main: txView(main),
        order: [...approvals.map((_, i) => `approval_${i}`), 'main'],
      },
      checks_passed: [
        'fresh quote re-validated',
        'chain id matches source chain',
        'target contract allowlisted',
        'native value matches asset type',
        'calldata decoded: receiver, destination chain, token and amount match',
        'output within accepted tolerance',
        ...(req.sourceAsset.native ? [] : ['approval limited to exact amount']),
      ],
      notes: [...warnings, ...notes, 'Sign with your own wallet. BridgePilot never holds keys or funds.'],
      next_step: `After broadcasting the main transaction, GET /v1/routes/status/${id}?tx_hash=<hash>.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
