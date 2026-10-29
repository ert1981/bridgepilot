import { randomUUID } from 'node:crypto';
import { resolveAsset } from '../config/assets.js';
import { resolveChain } from '../config/chains.js';
import { buildPolicy } from '../engines/policy-engine.js';
import { rankRoutes } from '../engines/ranking-engine.js';
import type { QuoteRequestInput } from '../schemas/request.schema.js';
import type { EvaluatedRoute, ResolvedRequest } from '../schemas/quote.schema.js';
import { assetView, routeView } from '../schemas/response.schema.js';
import type { Services } from '../services.js';
import { ApiError } from '../utils/errors.js';
import { formatScaled } from '../utils/units.js';
import { discoverRoutes } from './discovery-agent.js';
import { evaluateRoutes } from './risk-agent.js';

export type OrchestratorStage = 'RECEIVED' | 'VALIDATED' | 'DISCOVERED' | 'EVALUATED' | 'RANKED' | 'RESPONDED' | 'FAILED';

/** Turn validated input into a fully resolved request. Ambiguity is rejected, never guessed. */
export function resolveRequest(input: QuoteRequestInput, svc: Services, requestId = `req_${randomUUID()}`): { req: ResolvedRequest; warnings: string[] } {
  const src = resolveChain(input.source_chain);
  const dst = resolveChain(input.destination_chain);
  if (!src) throw new ApiError(400, 'UNSUPPORTED_CHAIN', `Unsupported source_chain "${input.source_chain}".`);
  if (!dst) throw new ApiError(400, 'UNSUPPORTED_CHAIN', `Unsupported destination_chain "${input.destination_chain}".`);
  if (src.id === dst.id) throw new ApiError(400, 'SAME_CHAIN', 'Source and destination chain are the same; BridgePilot only routes cross-chain transfers.');

  const sa = resolveAsset(src, input.source_token);
  if (!sa.ok) throw new ApiError(400, sa.code, sa.message);
  const da = resolveAsset(dst, input.destination_token);
  if (!da.ok) throw new ApiError(400, da.code, da.message);

  const { policy, warnings } = buildPolicy(svc.config, input.constraints, input.selection_policy);

  const registered = svc.registry.ids();
  let providers = registered;
  if (input.providers) {
    const unknown = input.providers.filter((p) => !registered.includes(p));
    if (unknown.length) throw new ApiError(400, 'UNKNOWN_PROVIDER', `Unknown provider(s): ${unknown.join(', ')}.`, { available: registered });
    providers = [...new Set(input.providers)];
  }
  if (providers.length === 0) throw new ApiError(503, 'NO_PROVIDERS', 'No route providers are enabled.');

  return {
    req: {
      requestId,
      sourceChain: src,
      destinationChain: dst,
      sourceAsset: sa.asset,
      destinationAsset: da.asset,
      amount: BigInt(input.amount),
      sender: input.sender,
      recipient: input.recipient ?? input.sender,
      policy,
      providers,
      maxAlternatives: input.max_alternatives ?? 2,
    },
    warnings,
  };
}

export interface QuoteOutcome {
  body: Record<string, unknown>;
  ranked: EvaluatedRoute[];
  req: ResolvedRequest;
  stages: { stage: OrchestratorStage; atMs: number }[];
}

/**
 * Orchestrator: a deterministic state machine. It may not change security criteria,
 * bypass mandatory filters, or sign anything.
 */
export async function runQuote(input: QuoteRequestInput, svc: Services, requestId?: string): Promise<QuoteOutcome> {
  const t0 = svc.now();
  const stages: QuoteOutcome['stages'] = [{ stage: 'RECEIVED', atMs: 0 }];
  const mark = (stage: OrchestratorStage) => stages.push({ stage, atMs: svc.now() - t0 });

  const { req, warnings } = resolveRequest(input, svc, requestId);
  mark('VALIDATED');

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error('budget')), svc.config.requestBudgetMs);
  try {
    const discovery = await discoverRoutes(req, svc, budget.signal);
    mark('DISCOVERED');
    const evaluated = await evaluateRoutes(discovery.quotes, req, svc, budget.signal);
    mark('EVALUATED');
    const ranking = rankRoutes(evaluated, req, svc.config.tieToleranceBps);
    mark('RANKED');

    const best = ranking.ranked[0];
    const alts = ranking.ranked.slice(1, 1 + req.maxAlternatives);
    const simulated = discovery.quotes.some((q) => q.simulated);
    const allWarnings = [...warnings];
    for (const s of discovery.skipped) allWarnings.push(`Provider ${s.provider} skipped: ${s.reason}`);
    if (simulated) allWarnings.push('SIMULATED MODE: quotes are synthetic and must not be used for real transfers.');

    let status: string;
    if (best) status = 'success';
    else if (discovery.quotes.length === 0 && discovery.errors.length > 0) status = 'providers_unavailable';
    else status = 'no_valid_route';

    const body: Record<string, unknown> = {
      request_id: req.requestId,
      status,
      simulated,
      selection_policy: req.policy.selection,
      selection_basis:
        'Best net output among the quotes BridgePilot received for this request, after mandatory safety filters. ' +
        'It is not a guarantee of the cheapest route available on the market; values are estimates as of data_as_of.',
      data_as_of: new Date(svc.now()).toISOString(),
      providers_queried: req.providers.filter((p) => !discovery.skipped.some((s) => s.provider === p)),
      input: {
        source_chain: { id: req.sourceChain.id, key: req.sourceChain.key },
        destination_chain: { id: req.destinationChain.id, key: req.destinationChain.key },
        source_token: assetView(req.sourceAsset),
        destination_token: assetView(req.destinationAsset),
        amount: req.amount.toString(),
        amount_formatted: formatScaled(req.amount, req.sourceAsset.decimals),
        sender: req.sender ?? null,
        recipient: req.recipient ?? null,
      },
      effective_constraints: {
        max_slippage_bps: req.policy.slippageBps,
        max_value_loss_bps: req.policy.maxValueLossBps,
        min_output: req.policy.minOutput?.toString() ?? null,
        max_time_seconds: req.policy.maxTimeSeconds ?? null,
        require_executable: req.policy.requireExecutable,
        include_review: req.policy.includeReview,
      },
      best_route: best ? routeView(best, req) : null,
      alternatives: alts.map((r) => routeView(r, req)),
      excluded: ranking.excluded.map((r) => ({
        provider: r.quote.provider,
        quote_id: r.quote.quoteId,
        risk_status: r.risk.status.toLowerCase(),
        findings: r.risk.findings.filter((f) => f.severity !== 'warn'),
      })),
      provider_errors: discovery.errors,
      explanation: ranking.reasons,
      warnings: allWarnings,
      execution_required: false,
      next_step: best
        ? best.quote.simulated
          ? 'Simulated route: switch PROVIDER_MODE=live for executable routes.'
          : `POST /v1/routes/prepare with provider="${best.quote.provider}" and accepted_output="${best.quote.expectedOutput}" plus sender/recipient to get unsigned transactions.`
        : 'Adjust amount, tokens or constraints and retry.',
      generated_at: new Date(svc.now()).toISOString(),
    };
    mark('RESPONDED');
    svc.metrics.inc('bridgepilot_quote_requests_total', { status });
    svc.audit.record('quote', {
      requestId: req.requestId,
      status,
      route: `${req.sourceChain.key}:${req.sourceAsset.symbol}->${req.destinationChain.key}:${req.destinationAsset.symbol}`,
      amount: req.amount.toString(),
      best: best?.quote.provider ?? null,
      providers: discovery.quotes.map((q) => q.provider),
      errors: discovery.errors.map((e) => `${e.provider}:${e.code}`),
    });
    return { body, ranked: ranking.ranked, req, stages };
  } catch (e) {
    mark('FAILED');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
