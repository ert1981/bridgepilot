import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ASSETS } from '../../src/config/assets.js';
import { CHAINS } from '../../src/config/chains.js';
import { runQuote } from '../../src/agents/orchestrator.js';
import { qualityReport } from '../../src/agents/quality-agent.js';
import { encodeHeader, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, PAYMENT_REQUIRED_HEADER, X402, type Discovery, type PaymentRequirements } from '../../src/billing/x402.js';
import { RateLimiter } from '../../src/billing/usage-limits.js';
import { getTransferStatus } from '../../src/execution/monitor-transaction.js';
import { prepareTransfer } from '../../src/execution/prepare-transaction.js';
import { formatZodError, PrepareRequestSchema, QuoteRequestSchema, StatusQuerySchema } from '../../src/schemas/request.schema.js';
import type { Services } from '../../src/services.js';
import { ApiError } from '../../src/utils/errors.js';
import { header, readJson, readText, send, sendError } from './http-utils.js';
import { identify, type Identity } from './middleware/authentication.js';
import { manifest, openapi, VERSION } from './manifest.js';
import { iconPng } from './icon.js';
import { BAZAAR_DESCRIPTION, bazaarExtension, buildToolManifest, ICON_PATH, MANIFEST_RE, manifestStatus, QUOTE_EXAMPLE, SERVICE_NAME, TOOL_INPUTS, TOOL_PATH, TOOL_TAGS } from './opensea-tool.js';
import { REGISTER_PAGE_CSP, registerPage } from './register-page.js';
import { PREPARE_DESCRIPTION, PREPARE_EXAMPLE, PREPARE_PATH, prepareBazaarExtension, X402_GUIDANCE } from './discovery.js';
import { REGISTER_8004_CSP, register8004Page, registration, WELL_KNOWN_PATH as AGENT_REG_PATH } from './erc8004.js';
import { X402_PAY_CSP, x402PayPage } from './x402-pay.js';
import { errorResult, McpServer, PAYMENT_META, PAYMENT_RESPONSE_META, paymentRequiredResult, textResult } from './mcp.js';

/** 402index.io domain-claim verification hash for bridgepilot.onrender.com (public by design; the claim token is not in the repo). */
export const INDEX402_VERIFY_HASH = 'fb50ebb494bba5bec615badf9a1e777137cebf3ab3c2b9f7ea38ea8150704815';

type Handler = (ctx: Ctx) => Promise<{ status: number; body: unknown; contentType?: string; headers?: Record<string, string> }>;
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

  /** x402 v2 resource info + Bazaar metadata for a paid HTTP route (402 header, and CDP settle payloads). */
  const discoveryFor = (path: string, reqs: PaymentRequirements): Discovery => {
    const isTool = path === TOOL_PATH;
    const isPrepare = path === PREPARE_PATH;
    const extensions = isTool ? bazaarExtension(x402.priceUsdc) : isPrepare ? prepareBazaarExtension() : undefined;
    return {
      resource: {
        url: reqs.resource,
        description: isTool ? BAZAAR_DESCRIPTION : isPrepare ? PREPARE_DESCRIPTION : reqs.description,
        mimeType: 'application/json',
        serviceName: SERVICE_NAME,
        iconUrl: `${cfg.publicBaseUrl}${ICON_PATH}`,
        ...(isTool || isPrepare ? { tags: TOOL_TAGS } : {}),
      },
      ...(extensions ? { extensions } : {}),
    };
  };

  /** 402: x402 v1 JSON body (what OpenSea's tool-sdk reads) + base64 x402 v2 PAYMENT-REQUIRED header (Bazaar). */
  const paymentRequired = (res: ServerResponse, reqs: PaymentRequirements, path: string, base: Record<string, string>, error?: string) => {
    const body = x402.challenge(reqs.resource, reqs.description, error);
    const d = discoveryFor(path, reqs);
    const v2 = x402.challengeV2(d.resource, body.error, d.extensions);
    return send(res, 402, body, {
      ...base,
      'x-accept-payment': 'x402',
      [PAYMENT_REQUIRED_HEADER]: encodeHeader(v2),
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE',
    });
  };

  const notConfigured = (reason: string) => new ApiError(503, 'TOOL_NOT_CONFIGURED', `OpenSea tool listing is not configured: ${reason}`);

  const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new ApiError(400, 'INVALID_REQUEST', 'Request validation failed.', formatZodError(r.error));
    return r.data;
  };

  const requireAdmin = (ctx: Ctx) => {
    if (!cfg.adminKeys.length) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (!ctx.identity.admin) throw new ApiError(401, 'UNAUTHORIZED', 'Admin key required.');
  };

  const describePaid = (path: string) => `BridgePilot cross-chain route ${path === TOOL_PATH ? 'quote' : 'preparation'} (${x402.priceUsdc} USDC)`;

  // ------------------------------------------------------------------ MCP (streamable HTTP) + x402
  const MCP_TOOL = 'quote_cross_chain_route';
  const mcp = new McpServer<Ctx>(
    { name: 'io.github.ert1981/bridgepilot', title: 'BridgePilot', version: VERSION },
    'Cross-chain route quotes (LI.FI, Across) for EVM chains. Each call is paid with x402: the first call answers a PaymentRequired ' +
      "object; retry with the signed payment in _meta['x402/payment']. Amounts are integers in the token smallest unit. Non-custodial.",
    [{
      name: MCP_TOOL,
      title: 'Cross-chain route quote',
      description: BAZAAR_DESCRIPTION,
      inputSchema: TOOL_INPUTS,
      price: x402.enabled ? { price_usdc: x402.priceUsdc, network: x402.caip2, asset: cfg.x402.asset, payTo: cfg.x402.payTo, transport: 'x402 MCP (_meta x402/payment)' } : undefined,
      handler: async (args, meta, ctx) => {
        const rl = limiter.take(ctx.identity.id, 1);
        if (!rl.allowed) return errorResult('Too many requests.');
        if (keysRequired && !ctx.identity.apiKey) return errorResult('API key required (x-api-key header).');
        const parsed = QuoteRequestSchema.safeParse(args);
        if (!parsed.success) return errorResult('Request validation failed.', formatZodError(parsed.error));
        const run = async () => (await runQuote(parsed.data, svc, ctx.requestId)).body as unknown as Record<string, unknown>;
        const mustPay = x402.isPaidPath(TOOL_PATH) && !ctx.identity.apiKey && cfg.mcpBilling !== 'gateway';
        try {
          if (!mustPay) return textResult(await run());
          const reqs = x402.requirements(`${cfg.publicBaseUrl}${TOOL_PATH}`, describePaid(TOOL_PATH));
          const resource = { url: `mcp://tool/${MCP_TOOL}`, description: BAZAAR_DESCRIPTION, mimeType: 'application/json' as const };
          const pay = meta[PAYMENT_META];
          if (!pay || typeof pay !== 'object' || Array.isArray(pay)) return paymentRequiredResult(x402.challengeV2(resource, pay ? 'invalid payment payload' : 'Payment required'));
          const verified = await x402.verify(encodeHeader(pay), reqs, (pay as { x402Version?: unknown }).x402Version === 2);
          if (!verified.ok) return paymentRequiredResult(x402.challengeV2(resource, verified.reason));
          let body: Record<string, unknown>;
          try {
            body = await run();
          } catch (e) {
            x402.release(verified.replayKey); // failed work is never charged
            throw e;
          }
          if (body?.status === 'providers_unavailable') {
            x402.release(verified.replayKey);
            return textResult(body, { [PAYMENT_RESPONSE_META]: { success: false, errorReason: 'not charged: no provider answered' } });
          }
          const settle = await x402.settle(verified.payload, reqs, verified.version);
          if (!settle.success) {
            svc.metrics.inc('bridgepilot_payment_settle_failed_total');
            return paymentRequiredResult(x402.challengeV2(resource, `settlement failed: ${settle.errorReason ?? 'unknown'}`));
          }
          svc.metrics.inc('bridgepilot_payments_settled_total');
          const receipt = { success: true, transaction: settle.transaction, network: settle.network ?? (verified.version === 2 ? x402.caip2 : cfg.x402.network), payer: settle.payer ?? verified.payer };
          return textResult(body, { [PAYMENT_RESPONSE_META]: receipt });
        } catch (e) {
          return errorResult(e instanceof ApiError ? e.message : 'Unexpected error.', e instanceof ApiError ? e.details : undefined);
        }
      },
    }],
  );

  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; paid?: boolean; cost?: number }[] = [
    {
      method: 'POST', pattern: /^\/mcp$/, keys: [],
      handler: async (ctx) => {
        let raw: string;
        try {
          raw = await readText(ctx.req, Math.max(cfg.maxBodyBytes, 65_536));
        } catch (e) {
          return { status: 413, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: (e as Error).message } } };
        }
        const [status, payload] = await mcp.handle(raw, ctx);
        return payload ? { status, body: payload } : { status, body: '' };
      },
    },
    {
      method: 'GET', pattern: /^\/\.well-known\/x402$/, keys: [],
      handler: async () => ({
        status: 200,
        body: { version: 1, resources: x402.enabled ? cfg.x402.paidPaths.map((p) => `${cfg.publicBaseUrl}${p}`) : [], instructions: X402_GUIDANCE },
        headers: { 'access-control-allow-origin': '*' },
      }),
    },
    {
      method: 'GET', pattern: /^\/\.well-known\/402index-verify\.txt$/, keys: [],
      handler: async () => ({ status: 200, body: cfg.index402Verify ?? INDEX402_VERIFY_HASH, contentType: 'text/plain; charset=utf-8' }),
    },
    ...[AGENT_REG_PATH, '/agent-registration.json'].map((p) => ({
      method: 'GET', pattern: new RegExp(`^${p.replace(/[.\/]/g, (c) => `\\${c}`)}$`), keys: [] as string[],
      handler: (async () => ({ status: 200, body: registration(cfg), headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' } })) as Handler,
    })),
    {
      // Owner registers BridgePilot in the ERC-8004 Identity Registry with their own wallet.
      method: 'GET', pattern: /^\/register-8004$/, keys: [],
      handler: async () => ({
        status: 200, body: register8004Page(cfg), contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': REGISTER_8004_CSP, 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY' },
      }),
    },
    {
      // Owner pays each paid route once with their own wallet (x402 v2) so the CDP Bazaar indexes it.
      method: 'GET', pattern: /^\/x402-pay$/, keys: [],
      handler: async () => ({
        status: 200, contentType: 'text/html; charset=utf-8',
        body: x402PayPage('BridgePilot', cfg.x402.payTo ?? '', [
          { id: 'quote', name: 'Route quote (quote)', path: TOOL_PATH, example: QUOTE_EXAMPLE },
          { id: 'prepare', name: 'Route preparation (prepare; pay the quote first, it uses that quote and your address)', path: PREPARE_PATH,
            // Across routes are quote-only unless ACROSS_EXECUTION_ENABLED, so the page prepares with a provider that
            // can execute here, at the output that provider quoted (a 30 bps drop is allowed by the API's own guard).
            example: { ...PREPARE_EXAMPLE, provider: 'lifi', accepted_output: '99700000' }, useAccount: ['sender', 'recipient'], fromQuote: true,
            executableProviders: cfg.across.executionEnabled ? ['lifi', 'across'] : ['lifi'] },
        ], 5_000_000n),
        headers: { 'content-security-policy': X402_PAY_CSP, 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY' },
      }),
    },
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
    {
      // ERC-8257 manifest for OpenSea Tools (only the quote endpoint is listed).
      method: 'GET', pattern: MANIFEST_RE, keys: [],
      handler: async () => {
        const st = manifestStatus(cfg);
        if (!st.ok) throw notConfigured(st.reason);
        return { status: 200, body: buildToolManifest(cfg), headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } };
      },
    },
    {
      method: 'GET', pattern: /^\/static\/icon\.png$/, keys: [],
      handler: async () => ({ status: 200, body: iconPng(), contentType: 'image/png', headers: { 'cache-control': 'public, max-age=86400' } }),
    },
    {
      // Creator signs registerTool with their own wallet; the server never holds a key.
      method: 'GET', pattern: /^\/register-onchain$/, keys: [],
      handler: async () => {
        const st = manifestStatus(cfg);
        if (!st.ok) throw notConfigured(st.reason);
        return {
          status: 200, body: registerPage(cfg), contentType: 'text/html; charset=utf-8',
          headers: { 'content-security-policy': REGISTER_PAGE_CSP, 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY' },
        };
      },
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

    // GET/HEAD probes of a paid POST route (x402dash, x402scan): the same 402 challenge, instantly, with no
    // provider calls. A GET carrying a payment is refused without verifying or charging it (invoke with POST).
    if ((req.method === 'GET' || req.method === 'HEAD') && x402.isPaidPath(path)) {
      if (header(req, PAYMENT_SIGNATURE_HEADER) ?? header(req, 'x-payment')) {
        return sendError(res, new ApiError(405, 'METHOD_NOT_ALLOWED', `Use POST ${path} with a JSON body; the payment was not used or charged.`), requestId, { ...baseHeaders, allow: 'POST' });
      }
      return paymentRequired(res, x402.requirements(`${cfg.publicBaseUrl}${path}`, describePaid(path)), path, baseHeaders);
    }

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
          paidReqs = x402.requirements(`${cfg.publicBaseUrl}${path}`, describePaid(path));
          // v2 clients pay with PAYMENT-SIGNATURE, v1 clients (OpenSea tool-sdk) with X-PAYMENT.
          const payV2 = header(req, PAYMENT_SIGNATURE_HEADER);
          const pay = payV2 ?? header(req, 'x-payment');
          if (!pay) return paymentRequired(res, paidReqs, path, baseHeaders);
          verified = await x402.verify(pay, paidReqs, !!payV2, discoveryFor(path, paidReqs));
          if (!verified.ok) return paymentRequired(res, paidReqs, path, baseHeaders, verified.reason);
        }
      }

      const out = await route.handler(ctx);
      const headers: Record<string, string> = { ...baseHeaders };
      if (out.contentType) headers['content-type'] = out.contentType;
      if (out.headers) Object.assign(headers, out.headers);

      const unbillable = (out.body as { status?: string } | null)?.status === 'providers_unavailable';
      if (paidReqs && verified?.ok && unbillable) {
        // No provider answered: return the result but do not charge; free the payment nonce.
        x402.release(verified.replayKey);
        headers['x-payment-status'] = 'not-charged';
      } else if (paidReqs && verified?.ok) {
        const settle = await x402.settle(verified.payload, paidReqs, verified.version);
        if (!settle.success) {
          // Work was done but payment did not settle: do not release the result.
          svc.metrics.inc('bridgepilot_payment_settle_failed_total');
          return paymentRequired(res, paidReqs, path, baseHeaders, `settlement failed: ${settle.errorReason ?? 'unknown'}`);
        }
        const receipt = { success: true, transaction: settle.transaction, network: settle.network ?? (verified.version === 2 ? x402.caip2 : cfg.x402.network), payer: settle.payer ?? verified.payer };
        headers['x-payment-response'] = encodeHeader(receipt);
        if (verified.version === 2) headers[PAYMENT_RESPONSE_HEADER] = encodeHeader(receipt);
        headers['access-control-expose-headers'] = 'PAYMENT-RESPONSE, X-PAYMENT-RESPONSE';
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
