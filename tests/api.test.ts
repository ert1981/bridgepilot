import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { startServer } from '../apps/api/server.js';
import { createServices } from '../src/services.js';
import { acrossFeesFixture, acrossRoute, baseQuoteInput, lifiCalldata, lifiQuoteFixture, lifiQuoteRoute, mockFetch, NOW, RECIPIENT, rpcRoute, SENDER, staticPrices, testConfig, type Route } from './helpers.js';

type Body = Record<string, any>;
const servers: { close(): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function boot(opts: { env?: Record<string, string>; routes?: Route[]; now?: () => number } = {}) {
  const svc = createServices(testConfig({ HOST: '127.0.0.1', ...opts.env }), { fetch: mockFetch(opts.routes ?? []), now: opts.now ?? (() => NOW), prices: staticPrices() });
  const { server } = await startServer(svc, 0, '127.0.0.1');
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Body | undefined;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json ?? ({ text } as Body), headers: res.headers };
  };
  return { svc, call };
}

const prepareBody = { ...baseQuoteInput, sender: SENDER, recipient: RECIPIENT, provider: 'lifi', accepted_output: '99720000' };

describe('HTTP API', () => {
  it('serves health, assets, manifest and openapi', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated' } });
    expect((await call('GET', '/health')).body.status).toBe('ok');
    const assets = (await call('GET', '/v1/assets')).body;
    expect(assets.chains.length).toBeGreaterThanOrEqual(5);
    expect(assets.assets.find((a: Body) => a.chain_id === 8453 && a.symbol === 'USDC').decimals).toBe(6);
    const man = await call('GET', '/.well-known/ai-tool.json');
    expect(man.body.tools.map((t: Body) => t.name)).toContain('quote_cross_chain_route');
    expect((await call('GET', '/.well-known/ai-tool/')).status).toBe(200);
    expect((await call('GET', '/openapi.json')).body.openapi).toBe('3.1.0');
  });

  it('returns a quote and security headers', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated' } });
    const r = await call('POST', '/v1/routes/quote', baseQuoteInput);
    expect(r.status).toBe(200);
    expect(r.body.best_route.provider).toBeDefined();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-request-id')).toMatch(/^req_/);
    expect(r.body.request_id).toBe(r.headers.get('x-request-id'));
  });

  it('validates input strictly', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated' } });
    const cases: [unknown, number, string][] = [
      [{ ...baseQuoteInput, amount: '100.5' }, 400, 'INVALID_REQUEST'],
      [{ ...baseQuoteInput, amount: '0' }, 400, 'INVALID_REQUEST'],
      [{ ...baseQuoteInput, amount: (1n << 256n).toString() }, 400, 'INVALID_REQUEST'],
      [{ ...baseQuoteInput, extra_field: 1 }, 400, 'INVALID_REQUEST'],
      [{ ...baseQuoteInput, recipient: '0x123' }, 400, 'INVALID_REQUEST'],
      [{ ...baseQuoteInput, source_token: 'USDT' }, 400, 'UNSUPPORTED_ASSET'],
      ['[1,2]', 400, 'INVALID_JSON'],
      ['{bad', 400, 'INVALID_JSON'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('POST', '/v1/routes/quote', body);
      expect([r.status, r.body.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
  });

  it('enforces content type, body size, methods and unknown paths', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated', MAX_BODY_BYTES: '512' } });
    expect((await call('POST', '/v1/routes/quote', JSON.stringify(baseQuoteInput), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call('POST', '/v1/routes/quote', { ...baseQuoteInput, source_token: 'x'.repeat(600) })).status).toBe(413);
    expect((await call('GET', '/v1/routes/quote')).status).toBe(405);
    expect((await call('GET', '/nope')).status).toBe(404);
  });

  it('rate limits per caller', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated', RATE_LIMIT_CAPACITY: '3', RATE_LIMIT_REFILL_PER_SEC: '0' } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await call('GET', '/health')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('requires API keys when configured, and protects admin endpoints', async () => {
    const { call } = await boot({ env: { PROVIDER_MODE: 'simulated', API_KEYS: 'user-key-123456', ADMIN_KEYS: 'admin-key-123456' } });
    expect((await call('POST', '/v1/routes/quote', baseQuoteInput)).status).toBe(401);
    expect((await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-api-key': 'wrong-key-000000' })).status).toBe(401);
    expect((await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-api-key': 'user-key-123456' })).status).toBe(200);
    expect((await call('GET', '/metrics', undefined, { 'x-api-key': 'user-key-123456' })).status).toBe(401);
    const m = await call('GET', '/metrics', undefined, { authorization: 'Bearer admin-key-123456' });
    expect(m.status).toBe(200);
    expect(m.body.text).toMatch(/bridgepilot_quote_requests_total/);
    expect((await call('GET', '/v1/quality/report', undefined, { 'x-api-key': 'admin-key-123456' })).body.providers).toBeDefined();
  });
});

describe('x402 payments', () => {
  const PAY_TO = '0x3333333333333333333333333333333333333333';
  const env = { PROVIDER_MODE: 'simulated', X402_MODE: 'facilitator', X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: 'https://facilitator.test/' };
  const payment = (nonce: string, over: Record<string, string> = {}) =>
    Buffer.from(JSON.stringify({
      x402Version: 1, scheme: 'exact', network: 'base',
      payload: { signature: '0xsig', authorization: { from: SENDER, to: PAY_TO, value: '10000', validAfter: '0', validBefore: String(Math.floor(NOW / 1000) + 600), nonce, ...over } },
    })).toString('base64');

  function facilitator(state: { verify: number; settle: number; settleOk?: boolean }): Route {
    return (url) => {
      if (url.host !== 'facilitator.test') return undefined;
      if (url.pathname === '/verify') { state.verify++; return { status: 200, body: { isValid: true, payer: SENDER } }; }
      if (url.pathname === '/settle') { state.settle++; return { status: 200, body: { success: state.settleOk ?? true, transaction: '0xpaid', network: 'base', payer: SENDER } }; }
      return undefined;
    };
  }

  it('challenges, verifies, settles, and blocks replay', async () => {
    const st = { verify: 0, settle: 0 };
    const { call } = await boot({ env, routes: [facilitator(st)] });
    const c = await call('POST', '/v1/routes/quote', baseQuoteInput);
    expect(c.status).toBe(402);
    expect(c.body.accepts[0]).toMatchObject({ scheme: 'exact', network: 'base', payTo: PAY_TO, maxAmountRequired: '10000' });

    const ok = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': payment('0x01') });
    expect(ok.status).toBe(200);
    expect(JSON.parse(Buffer.from(ok.headers.get('x-payment-response')!, 'base64').toString()).transaction).toBe('0xpaid');
    expect(st).toEqual({ verify: 1, settle: 1 });

    const replay = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': payment('0x01') });
    expect(replay.status).toBe(402);
    expect(replay.body.error).toMatch(/already used/);
  });

  it('rejects wrong payee, low amount, expired and malformed payments locally', async () => {
    const st = { verify: 0, settle: 0 };
    const { call } = await boot({ env, routes: [facilitator(st)] });
    for (const [hdr, reason] of [
      [payment('0x02', { to: SENDER }), /payee/],
      [payment('0x03', { value: '9999' }), /insufficient/],
      [payment('0x04', { validBefore: '1' }), /expired/],
      ['%%%notbase64', /malformed/],
    ] as [string, RegExp][]) {
      const r = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': hdr });
      expect(r.status).toBe(402);
      expect(r.body.error).toMatch(reason);
    }
    expect(st.verify).toBe(0);
  });

  it('does not charge (no settle) when the paid request fails, and frees the nonce', async () => {
    const st = { verify: 0, settle: 0 };
    const { call } = await boot({ env, routes: [facilitator(st)] });
    const bad = await call('POST', '/v1/routes/quote', { ...baseQuoteInput, source_chain: 'solana' }, { 'x-payment': payment('0x05') });
    expect(bad.status).toBe(400);
    expect(st.settle).toBe(0);
    const retry = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': payment('0x05') });
    expect(retry.status).toBe(200);
    expect(st.settle).toBe(1);
  });

  it('concurrent requests with the same payment are charged once (M1)', async () => {
    const st = { verify: 0, settle: 0 };
    const slowFacilitator: Route = async (url) => {
      if (url.host !== 'facilitator.test') return undefined;
      await new Promise((r) => setTimeout(r, 30));
      return facilitator(st)(url);
    };
    const { call } = await boot({ env, routes: [slowFacilitator] });
    const hdr = payment('0x07');
    const res = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': hdr })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 402, 402]);
    expect(st.settle).toBe(1);
  });

  it('does not charge when no provider answered', async () => {
    const st = { verify: 0, settle: 0 };
    const { call } = await boot({ env: { ...env, PROVIDER_MODE: 'live' }, routes: [facilitator(st)] });
    const r = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': payment('0x08') });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('providers_unavailable');
    expect(r.headers.get('x-payment-status')).toBe('not-charged');
    expect(st.settle).toBe(0);
  });

  it('payment nonces are shared atomically across API instances (durable store)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-api-'));
    const st = { verify: 0, settle: 0 };
    const shared = { ...env, STORAGE_PATH: join(dir, 'api.sqlite') };
    const a = await boot({ env: shared, routes: [facilitator(st)] });
    const b = await boot({ env: shared, routes: [facilitator(st)] });
    const hdr = payment('0x09');
    const [r1, r2] = await Promise.all([a.call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': hdr }), b.call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': hdr })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 402]);
    expect(st.settle).toBe(1);
    const c = await boot({ env: shared, routes: [facilitator(st)] }); // "restarted" instance
    expect((await c.call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': hdr })).status).toBe(402);
  });

  it('withholds the result if settlement fails', async () => {
    const st = { verify: 0, settle: 0, settleOk: false };
    const { call } = await boot({ env, routes: [facilitator(st)] });
    const r = await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-payment': payment('0x06') });
    expect(r.status).toBe(402);
    expect(r.body.best_route).toBeUndefined();
  });

  it('lets API-key subscribers skip payment', async () => {
    const st = { verify: 0, settle: 0 };
    const { call } = await boot({ env: { ...env, API_KEYS: 'sub-key-12345678' }, routes: [facilitator(st)] });
    expect((await call('POST', '/v1/routes/quote', baseQuoteInput, { 'x-api-key': 'sub-key-12345678' })).status).toBe(200);
    expect(st.verify).toBe(0);
  });
});

describe('prepare + status', () => {
  it('returns unsigned txs with an exact-amount approval', async () => {
    const { call } = await boot({ routes: [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, 0n)] });
    const r = await call('POST', '/v1/routes/prepare', prepareBody);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary).toMatchObject({ send: '100 USDC', receive_expected: '99.72 USDC', receive_minimum: '99.2214 USDC', recipient: RECIPIENT });
    expect(r.body.transactions.approvals).toHaveLength(1);
    const appr = decodeFunctionData({ abi: erc20Abi, data: r.body.transactions.approvals[0].data });
    expect(appr.functionName).toBe('approve');
    expect(appr.args).toEqual(['0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', 100_000_000n]);
    expect(r.body.transactions.main.to).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');
    expect(r.body.transactions.main.value).toBe('0');
    expect(r.body.prepared_id).toMatch(/^prep_/);
  });

  it('skips approval when allowance already covers the amount', async () => {
    const { call } = await boot({ routes: [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, 10n ** 12n)] });
    const r = await call('POST', '/v1/routes/prepare', prepareBody);
    expect(r.body.transactions.approvals).toHaveLength(0);
  });

  it.each([
    ['non-allowlisted target', { to: '0x000000000000000000000000000000000000dEaD' }, 'ROUTE_REJECTED'],
    ['unexpected native value', { value: '0x1' }, 'EXECUTION_DATA_INVALID'],
    ['wrong chain id', { fromChainId: 10 }, 'ROUTE_REJECTED'],
    ['different from address', { from: '0x4444444444444444444444444444444444444444' }, 'EXECUTION_DATA_INVALID'],
    ['calldata receiver redirected', { data: lifiCalldata({ receiver: '0x000000000000000000000000000000000000dEaD' }) }, 'EXECUTION_DATA_INVALID'],
    ['calldata wrong destination chain', { data: lifiCalldata({ destChain: 10n }) }, 'EXECUTION_DATA_INVALID'],
    ['calldata wrong amount', { data: lifiCalldata({ minAmount: 1n }) }, 'EXECUTION_DATA_INVALID'],
    ['calldata destination call', { data: lifiCalldata({ destCall: true }) }, 'EXECUTION_DATA_INVALID'],
    ['undecodable calldata', { data: '0x4630a0d8' + '00'.repeat(64) }, 'EXECUTION_DATA_INVALID'],
    ['action.toAddress redirected', { toAddress: '0x000000000000000000000000000000000000dEaD' }, 'EXECUTION_DATA_INVALID'],
  ])('refuses tampered execution data: %s', async (_name, over, code) => {
    const { call } = await boot({ routes: [lifiQuoteRoute(lifiQuoteFixture(over as never)), rpcRoute(10_000_000n, 0n)] });
    const r = await call('POST', '/v1/routes/prepare', prepareBody);
    expect([r.status, r.body.error?.code]).toEqual([422, code]);
  });

  it('refuses when the fresh quote is materially worse than accepted', async () => {
    const { call } = await boot({ routes: [lifiQuoteRoute(lifiQuoteFixture({ toAmount: '99300000', toAmountMin: '98900000' })), rpcRoute()] });
    const r = await call('POST', '/v1/routes/prepare', prepareBody);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('QUOTE_CHANGED');
  });

  it('refuses execution in simulated mode and for quote-only providers', async () => {
    const sim = await boot({ env: { PROVIDER_MODE: 'simulated' } });
    expect((await sim.call('POST', '/v1/routes/prepare', { ...prepareBody, provider: 'sim_alpha' })).body.error.code).toBe('SIMULATED_MODE');
    const ac = await boot({ routes: [acrossRoute(acrossFeesFixture()), rpcRoute()] });
    const r = await ac.call('POST', '/v1/routes/prepare', { ...prepareBody, provider: 'across' });
    expect(r.body.error.code).toBe('ROUTE_REJECTED');
    expect(r.body.error.details.map((f: Body) => f.code)).toContain('NOT_EXECUTABLE');
  });

  it('tracks status through to completion and records deviation', async () => {
    let t = NOW;
    let lifiStatus: Body = { status: 'PENDING' };
    const statusRoute: Route = (u) => (u.pathname === '/v1/status' ? { status: 200, body: lifiStatus } : undefined);
    const { call, svc } = await boot({ now: () => t, routes: [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, 0n), statusRoute] });
    const prep = await call('POST', '/v1/routes/prepare', prepareBody);
    const id = prep.body.prepared_id;
    expect((await call('GET', `/v1/routes/status/${id}`)).body.state).toBe('awaiting_signature');
    const hash = '0x' + 'ab'.repeat(32);
    expect((await call('GET', `/v1/routes/status/${id}?tx_hash=${hash}`)).body.state).toBe('pending');
    expect((await call('GET', `/v1/routes/status/${id}?tx_hash=${'0x' + 'cd'.repeat(32)}`)).status).toBe(409);
    lifiStatus = { status: 'DONE', substatus: 'COMPLETED', receiving: { txHash: '0xdest', amount: '99700000' } };
    expect((await call('GET', `/v1/routes/status/${id}`)).body.state).toBe('pending'); // poll throttled
    t += 6000;
    const done = (await call('GET', `/v1/routes/status/${id}`)).body;
    expect(done).toMatchObject({ state: 'done', received_amount: '99700000', output_deviation_bps: 2, destination_tx_hash: '0xdest' });
    expect(svc.audit.recent.some((e) => e.type === 'transfer_terminal')).toBe(true);
    expect((await call('GET', '/v1/routes/status/prep_00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await call('GET', `/v1/routes/status/${id}?tx_hash=nothex`)).status).toBe(400);
  });

  it('prepared transfers survive a restart with durable storage', async () => {
    const env2 = { STORAGE_PATH: join(mkdtempSync(join(tmpdir(), 'bp-api-')), 'api.sqlite') };
    const routes = [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, 0n)];
    const first = await boot({ env: env2, routes });
    const id = (await first.call('POST', '/v1/routes/prepare', prepareBody)).body.prepared_id;
    expect((await first.call('GET', '/health')).body.durable_storage).toBe(true);
    const second = await boot({ env: env2, routes });
    const s = await second.call('GET', `/v1/routes/status/${id}`);
    expect(s.status).toBe(200);
    expect(s.body.state).toBe('awaiting_signature');
  });

  it('marks unbroadcast preparations as expired', async () => {
    let t = NOW;
    const { call } = await boot({ now: () => t, routes: [lifiQuoteRoute(lifiQuoteFixture()), rpcRoute(10_000_000n, 0n)] });
    const id = (await call('POST', '/v1/routes/prepare', prepareBody)).body.prepared_id;
    t += 120_000;
    expect((await call('GET', `/v1/routes/status/${id}`)).body.state).toBe('expired');
  });
});
