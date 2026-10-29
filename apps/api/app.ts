import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ASSETS } from '../../src/config/assets.js';
import { CHAINS } from '../../src/config/chains.js';
import { runQuote } from '../../src/agents/orchestrator.js';
import { qualityReport } from '../../src/agents/quality-agent.js';
import { X402, type PaymentRequirements } from '../../src/billing/x402.js';
import { RateLimiter } from '../../src/billing/usage-limits.js';
import { getTransferStatus } from '../../src/execution/monitor-transaction.js';
import { prepareTransfer } from '../../src/execution/prepare-transaction.js';
import { formatZodError, PrepareRequestSchema, QuoteRequestSchema, StatusQuerySchema } from '../../src/schemas/request.schema.js';
import type { Services } from '../../src/services.js';
import { ApiError } from '../../src/utils/errors.js';
import { header, readJson, send, sendError } from './http-utils.js';
import { identify, type Identity } from './middleware/authentication.js';
import { manifest, openapi, VERSION } from './manifest.js';

type Handler = (ctx: Ctx) => Promise<{ status: number; body: unknown; contentType?: string }>;
interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  identity: Identity;
  requestId: string;
  svc: Services;
}

export function createApp(svc: Services) {
  const cfg = svc.config;
  const limiter = new RateLimiter(cfg.rateLimit.capacity, cfg.rateLimit.refillPerSec, svc.now);
  const x402 = new X402(cfg.x402, svc.fetch, svc.now, svc.nonces);
  const keysRequired = cfg.apiKeys.length > 0 && !x402.enabled;

  const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new ApiError(400, 'INVALID_REQUEST', 'Request validation failed.', formatZodError(r.error));
    return r.data;
  };

  const requireAdmin = (ctx: Ctx) => {
    if (!cfg.adminKeys.length) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (!ctx.identity.admin) throw new ApiError(401, 'UNAUTHORIZED', 'Admin key required.');
  };

  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; paid?: boolean; cost?: number }[] = [
    {
      method: 'GET', pattern: /^\/health$/, keys: [],
      handler: async () => ({
        status: 200,
        body: {
          status: 'ok',
          version: VERSION,
          provider_mode: cfg.providerMode,
          providers: svc.registry.ids(),
          provider_health: Object.fromEntries(svc.registry.ids().map((id) => [id, svc.circuit.state(id)])),
          durable_storage: !!cfg.storagePath,
          time: new Date(svc.now()).toISOString(),
        },
      }),
    },
    {
      method: 'GET', pattern: /^\/v1\/assets$/, keys: [],
      handler: async () => ({
        status: 200,
        body: {
          chains: CHAINS.map((c) => ({ id: c.id, key: c.key, name: c.name, native_symbol: c.nativeSymbol })),
          assets: ASSETS.map((a) => ({ chain_id: a.chainId, symbol: a.symbol, name: a.name, address: a.address, decimals: a.decimals, native: a.native })),
          providers: svc.registry.all().map((p) => ({ id: p.id, name: p.displayName, execution: typeof p.buildTransaction === 'function' })),
          amount_unit: 'Amounts are integers in the token smallest unit.',
        },
      }),
    },
    {
      method: 'POST', pattern: /^\/v1\/routes\/quote$/, keys: [], paid: true, cost: 1,
      handler: async (ctx) => {
        const input = parse(QuoteRequestSchema, await readJson(ctx.req, cfg.maxBodyBytes));
        const out = await runQuote(input, svc, ctx.requestId);
        return { status: 200, body: out.body };
      },
    },
    {
      method: 'POST', pattern: /^\/v1\/routes\/prepare$/, keys: [], paid: true, cost: 2,
      handler: async (ctx) => {
        const input = parse(PrepareRequestSchema, await readJson(ctx.req, cfg.maxBodyBytes));
        return { status: 200, body: { request_id: ctx.requestId, ...(await prepareTransfer(input, svc, ownerOf(ctx.identity))) } };
      },
    },
    {
      method: 'GET', pattern: /^\/v1\/routes\/status\/(prep_[0-9a-f-]{36})$/, keys: ['id'],
      handler: async (ctx) => {
        const q = parse(StatusQuerySchema, Object.fromEntries(ctx.url.searchParams));
        return { status: 200, body: await getTransferStatus(ctx.params.id!, q.tx_hash, svc, ownerOf(ctx.identity)) };
      },
    },
    {
      method: 'GET', pattern: /^\/\.well-known\/ai-tool(\.json|\/)?$/, keys: [],
      handler: async () => ({ status: 200, body: manifest(cfg) }),
    },
    { method: 'GET', pattern: /^\/openapi\.json$/, keys: [], handler: async () => ({ status: 200, body: openapi(cfg) }) },
    {
      method: 'GET', pattern: /^\/metrics$/, keys: [],
      handler: async (ctx) => {
        requireAdmin(ctx);
        return { status: 200, body: svc.metrics.render(), contentType: 'text/plain; version=0.0.4' };
      },
    },
    {
      method: 'GET', pattern: /^\/v1\/quality\/report$/, keys: [],
      handler: async (ctx) => {
        requireAdmin(ctx);
        return { status: 200, body: await qualityReport(svc) };
      },
    },
  ];

  /** Record ownership: API-key callers own their records; open/x402 callers use unguessable ids. */
  const ownerOf = (id: Identity) => (id.apiKey ? id.id : 'anonymous');

  let handled = 0;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (++handled % 1000 === 0) limiter.prune();
    const requestId = `req_${randomUUID()}`;
    const started = svc.now();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendError(res, new ApiError(400, 'BAD_URL', 'Malformed URL.'), requestId);
    }
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;
    const pathForMatch = url.pathname.startsWith('/.well-known/') ? url.pathname : path;
    const baseHeaders = { 'x-request-id': requestId };
    const identity = identify(req, cfg.apiKeys, cfg.adminKeys);

    const route = routes.find((r) => r.pattern.test(pathForMatch) && r.method === req.method);
    if (!route) {
      const exists = routes.some((r) => r.pattern.test(pathForMatch));
      return sendError(res, exists ? new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.') : new ApiError(404, 'NOT_FOUND', 'Not found.'), requestId, baseHeaders);
    }
    const m = pathForMatch.match(route.pattern)!;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = m[i + 1]!));
    const ctx: Ctx = { req, url, params, identity, requestId, svc };

    let paidReqs: PaymentRequirements | undefined;
    let verified: Awaited<ReturnType<X402['verify']>> | undefined;
    try {
      // Rate limit every caller (API keys get their own bucket).
      const rl = limiter.take(identity.id, route.cost ?? 1);
      if (!rl.allowed) throw Object.assign(new ApiError(429, 'RATE_LIMITED', 'Too many requests.'), { retryAfter: rl.retryAfterSec });

      if (route.paid) {
        if (keysRequired && !identity.apiKey) throw new ApiError(401, 'UNAUTHORIZED', 'API key required (x-api-key header).');
        if (x402.isPaidPath(path) && !identity.apiKey) {
          paidReqs = x402.requirements(`${cfg.publicBaseUrl}${path}`, 'BridgePilot cross-chain route optimization');
          const pay = header(req, 'x-payment');
          if (!pay) return send(res, 402, x402.challenge(paidReqs.resource, paidReqs.description), baseHeaders);
          verified = await x402.verify(pay, paidReqs);
          if (!verified.ok) return send(res, 402, x402.challenge(paidReqs.resource, paidReqs.description, verified.reason), baseHeaders);
        }
      }

      const out = await route.handler(ctx);
      const headers: Record<string, string> = { ...baseHeaders };
      if (out.contentType) headers['content-type'] = out.contentType;

      const unbillable = (out.body as { status?: string } | null)?.status === 'providers_unavailable';
      if (paidReqs && verified?.ok && unbillable) {
        // No provider answered: return the result but do not charge; free the payment nonce.
        x402.release(verified.replayKey);
        headers['x-payment-status'] = 'not-charged';
      } else if (paidReqs && verified?.ok) {
        const settle = await x402.settle(verified.payload, paidReqs);
        if (!settle.success) {
          // Work was done but payment did not settle: do not release the result.
          svc.metrics.inc('bridgepilot_payment_settle_failed_total');
          return send(res, 402, x402.challenge(paidReqs.resource, paidReqs.description, `settlement failed: ${settle.errorReason ?? 'unknown'}`), baseHeaders);
        }
        headers['x-payment-response'] = Buffer.from(JSON.stringify(settle)).toString('base64');
        svc.metrics.inc('bridgepilot_payments_settled_total');
      }
      svc.metrics.inc('bridgepilot_http_requests_total', { path: route.pattern.source.slice(0, 40), status: String(out.status) });
      send(res, out.status, out.body, headers);
    } catch (e) {
      // A failed paid request releases its nonce and is never settled (caller is not charged).
      if (verified?.ok) x402.release(verified.replayKey);
      const err = e instanceof ApiError ? e : new ApiError(500, 'INTERNAL_ERROR', 'Unexpected error.');
      if (!(e instanceof ApiError)) svc.audit.record('internal_error', { requestId, message: (e as Error)?.message?.slice(0, 300) });
      const headers: Record<string, string> = { ...baseHeaders };
      const ra = (e as { retryAfter?: number }).retryAfter;
      if (ra) headers['retry-after'] = String(ra);
      svc.metrics.inc('bridgepilot_http_errors_total', { code: err.code });
      sendError(res, err, requestId, headers);
    } finally {
      svc.metrics.observe('bridgepilot_http_latency_ms', svc.now() - started);
    }
  };
}
