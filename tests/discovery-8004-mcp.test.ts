/**
 * x402scan discovery (openapi x-payment-info, /.well-known/x402), instant GET/HEAD 402 probes (x402dash),
 * ERC-8004 registration file + /register-8004 page, the remote MCP server with x402 pay-per-call (x402 MCP
 * transport), 402index verification, and the ERC-8257 manifest for tool #818 staying byte-identical.
 */
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { startServer } from '../apps/api/server.js';
import { createServices } from '../src/services.js';
import { buildToolManifest, manifestHash, MANIFEST_PATH, TOOL_INPUTS, TOOL_PATH } from '../apps/api/opensea-tool.js';
import { encodeRegister, IDENTITY_REGISTRY, SCRIPT_8004_CSP_HASH } from '../apps/api/erc8004.js';
import { PREPARE_PATH, prepareInputs } from '../apps/api/discovery.js';
import { PrepareRequestSchema } from '../src/schemas/request.schema.js';
import { baseQuoteInput, mockFetch, NOW, SENDER, staticPrices, testConfig, type Route } from './helpers.js';

type Body = Record<string, any>;
const REZA = '0x93714D5970f511Ac22f0E5635D3fBF538f717cd4';
const PROD_ORIGIN = 'https://bridgepilot.onrender.com';
const PROD = { PROVIDER_MODE: 'live', X402_MODE: 'facilitator', X402_PAY_TO: REZA, TOOL_CREATOR_ADDRESS: REZA, PUBLIC_BASE_URL: PROD_ORIGIN };
const SIM = { ...PROD, PROVIDER_MODE: 'simulated', X402_FACILITATOR_URL: 'https://facilitator.test/' };
/** sha256 of the manifest bytes served live on 2026-10-29 and its JCS keccak256 registered onchain (tool #818). */
const LIVE_SHA256 = 'db6c736a215c6d7a76aa59a749102af48e0fa58c14bd440a1333235832c77fdf';
const ONCHAIN_HASH_818 = '0x3b0ce4ab967d54c38dfa63eb83e84ed0bdb817763c07758084d0c07788390524';

const servers: { close(): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function boot(env: Record<string, string>, routes: Route[] = [], log: string[] = []) {
  const svc = createServices(testConfig({ HOST: '127.0.0.1', ...env }), { fetch: mockFetch(routes, log), now: () => NOW, prices: staticPrices() });
  const { server } = await startServer(svc, 0, '127.0.0.1');
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: Body | undefined;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
    return { status: res.status, body: json ?? ({} as Body), raw: buf, headers: res.headers };
  };
}
const b64json = (h: string | null) => JSON.parse(Buffer.from(h ?? '', 'base64').toString('utf8'));

const facilitator = (st: { calls: Body[] }): Route => (url, init) => {
  if (url.host !== 'facilitator.test') return undefined;
  const body = JSON.parse(String(init?.body ?? '{}'));
  st.calls.push({ path: url.pathname, ...body });
  if (url.pathname === '/verify') return { status: 200, body: { isValid: true, payer: SENDER } };
  if (url.pathname === '/settle') return { status: 200, body: { success: true, transaction: '0xsettled', network: 'eip155:8453', payer: SENDER } };
  return undefined;
};
const v2Payload = (nonce: string) => ({
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: REZA, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
  payload: { signature: '0xsig', authorization: { from: SENDER, to: REZA, value: '10000', validAfter: '0', validBefore: String(Math.floor(NOW / 1000) + 600), nonce } },
});

describe('ERC-8257 manifest of tool #818 is unchanged', () => {
  it('serves the exact live bytes and the onchain JCS hash', async () => {
    const call = await boot(PROD);
    const r = await call('GET', MANIFEST_PATH);
    expect(r.status).toBe(200);
    expect(createHash('sha256').update(r.raw).digest('hex')).toBe(LIVE_SHA256);
    expect(manifestHash(buildToolManifest(testConfig(PROD)))).toBe(ONCHAIN_HASH_818);
  });
});

describe('x402scan discovery', () => {
  it('openapi.json declares x-payment-info, 402, input and output schemas on paid operations', async () => {
    const call = await boot(PROD);
    const spec = (await call('GET', '/openapi.json')).body;
    expect(spec.openapi).toBeTruthy();
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.info['x-guidance']).toMatch(/x402/);
    for (const p of [TOOL_PATH, PREPARE_PATH]) {
      const op = spec.paths[p].post;
      expect(op['x-payment-info']).toEqual({ price: { mode: 'fixed', currency: 'USD', amount: '0.01' }, protocols: [{ x402: {} }] });
      expect(op.responses['402']).toBeDefined();
      expect(op.requestBody.content['application/json'].schema.properties).toBeDefined();
      expect(op.responses['200'].content['application/json'].schema.properties).toBeDefined();
    }
    expect(spec.paths[TOOL_PATH].post.requestBody.content['application/json'].schema).toEqual(TOOL_INPUTS);
  });

  it('openapi has no payment info when x402 is off', async () => {
    const call = await boot({});
    const spec = (await call('GET', '/openapi.json')).body;
    expect(spec.paths[TOOL_PATH].post['x-payment-info']).toBeUndefined();
    expect((await call('GET', '/.well-known/x402')).body.resources).toEqual([]);
  });

  it('/.well-known/x402 lists the paid resources', async () => {
    const call = await boot(PROD);
    const r = await call('GET', '/.well-known/x402');
    expect(r.body).toMatchObject({ version: 1, resources: [`${PROD_ORIGIN}${TOOL_PATH}`, `${PROD_ORIGIN}${PREPARE_PATH}`] });
  });

  it('prepare 402 carries a Bazaar input schema whose example is a valid request', async () => {
    const call = await boot(PROD);
    const r = await call('POST', PREPARE_PATH, {});
    expect(r.status).toBe(402);
    const bz = b64json(r.headers.get('payment-required')).extensions.bazaar;
    expect(PrepareRequestSchema.safeParse(bz.info.input.body).success).toBe(true);
    expect(bz.schema.properties.input.properties.body).toEqual(prepareInputs());
  });
});

describe('GET/HEAD probes answer 402 instantly', () => {
  it('GET and HEAD on paid routes: 402 + PAYMENT-REQUIRED with Bazaar, no upstream calls', async () => {
    const log: string[] = [];
    const call = await boot(PROD, [], log);
    for (const p of [TOOL_PATH, PREPARE_PATH, `${TOOL_PATH}?amount=abc`]) {
      const r = await call('GET', p);
      expect(r.status, p).toBe(402);
      expect(r.body.accepts[0].maxAmountRequired).toBe('10000');
      const v2 = b64json(r.headers.get('payment-required'));
      expect(v2.accepts[0].amount).toBe('10000');
      expect(v2.extensions.bazaar.info.input.body).toBeDefined();
      const h = await call('HEAD', p);
      expect(h.status).toBe(402);
      expect(h.headers.get('payment-required')).toBeTruthy();
      expect(h.raw.length).toBe(0);
    }
    expect(log).toEqual([]);
  });

  it('GET with a payment is refused (405) without verifying or charging', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    const r = await call('GET', TOOL_PATH, undefined, { 'payment-signature': Buffer.from(JSON.stringify(v2Payload('0x' + '44'.repeat(32)))).toString('base64') });
    expect(r.status).toBe(405);
    expect(st.calls).toHaveLength(0);
  });

  it('without x402 a GET is still 405', async () => {
    const call = await boot({});
    expect((await call('GET', TOOL_PATH)).status).toBe(405);
  });
});

describe('ERC-8004', () => {
  it('serves the registration file at both paths', async () => {
    const call = await boot(PROD);
    const a = await call('GET', '/.well-known/agent-registration.json');
    const b = await call('GET', '/agent-registration.json');
    expect(a.status).toBe(200);
    expect(a.raw.equals(b.raw)).toBe(true);
    expect(a.body.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    expect(a.body.name).toBe('BridgePilot');
    expect(a.body.image).toBe(`${PROD_ORIGIN}/static/icon.png`);
    const svc = Object.fromEntries(a.body.services.map((s: Body) => [s.name, s]));
    expect(svc.MCP).toEqual({ name: 'MCP', endpoint: `${PROD_ORIGIN}/mcp`, version: '2025-06-18' });
    expect(svc.web.endpoint).toBe(`${PROD_ORIGIN}/`);
    expect(svc.x402.endpoint).toBe(`${PROD_ORIGIN}${TOOL_PATH}`);
    expect(a.body.x402Support).toBe(true);
    expect(a.body.registrations).toEqual([]);
  });

  it('lists the agentId once ERC8004_AGENT_ID is set', async () => {
    const call = await boot({ ...PROD, ERC8004_AGENT_ID: '1234' });
    expect((await call('GET', '/.well-known/agent-registration.json')).body.registrations).toEqual([{ agentId: 1234, agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` }]);
  });

  it('/register-8004 shows the exact register(string) calldata under a hash-pinned CSP', async () => {
    const call = await boot(PROD);
    const r = await call('GET', '/register-8004');
    expect(r.status).toBe(200);
    const html = r.raw.toString('utf8');
    const uri = `${PROD_ORIGIN}/.well-known/agent-registration.json`;
    const data = encodeRegister(uri);
    expect(data.slice(0, 10)).toBe('0xf2c298be');
    expect(decodeFunctionData({ abi: [{ type: 'function', name: 'register', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [], stateMutability: 'nonpayable' }], data }).args).toEqual([uri]);
    expect(html).toContain(data);
    expect(html).toContain('0x2105');
    expect(html).toContain(IDENTITY_REGISTRY);
    expect(html).toContain(REZA);
    expect(html).not.toMatch(/__[A-Z_]+__/);
    expect(html).toContain('eip6963:requestProvider');
    expect(html).toContain('Open in MetaMask');
    // same CSP pattern as /register-onchain (wallet calls go through the injected provider)
    expect(r.headers.get('content-security-policy')).not.toContain('connect-src');
    expect(r.headers.get('content-security-policy')).toContain(SCRIPT_8004_CSP_HASH);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(`'sha256-${createHash('sha256').update(script).digest('base64')}'`).toBe(SCRIPT_8004_CSP_HASH);
  });

  it('calldata equals cast calldata', () => {
    const cast = [`${homedir()}/.foundry/bin/cast`, '/root/.foundry/bin/cast'].find((p) => existsSync(p));
    if (!cast) return;
    const uri = `${PROD_ORIGIN}/.well-known/agent-registration.json`;
    expect(encodeRegister(uri)).toBe(execFileSync(cast, ['calldata', 'register(string)', uri]).toString().trim());
  });
});

describe('MCP server', () => {
  const rpc = (call: Awaited<ReturnType<typeof boot>>, method: string, params?: unknown, id = 1) =>
    call('POST', '/mcp', { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

  it('initialize, notifications, ping, tools/list, unknown method, GET 405', async () => {
    const call = await boot(PROD);
    const init = await rpc(call, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.serverInfo.name).toBe('io.github.ert1981/bridgepilot');
    expect(init.body.result.capabilities.tools).toBeDefined();
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await rpc(call, 'ping')).body.result).toEqual({});
    const tools = (await rpc(call, 'tools/list')).body.result.tools;
    expect(tools.map((t: Body) => t.name)).toEqual(['quote_cross_chain_route']);
    expect(tools[0].inputSchema).toEqual(TOOL_INPUTS);
    expect(tools[0]._meta.x402.price_usdc).toBe('0.01');
    expect((await rpc(call, 'nope')).body.error.code).toBe(-32601);
    expect((await call('POST', '/mcp', '{bad')).body.error.code).toBe(-32700);
    expect((await call('GET', '/mcp')).status).toBe(405);
  });

  it('paid tool without payment returns the x402 PaymentRequired result (no upstream calls)', async () => {
    const log: string[] = [];
    const call = await boot(PROD, [], log);
    const res = (await rpc(call, 'tools/call', { name: 'quote_cross_chain_route', arguments: baseQuoteInput })).body.result;
    expect(res.isError).toBe(true);
    expect(res.structuredContent.x402Version).toBe(2);
    expect(res.structuredContent.resource.url).toBe('mcp://tool/quote_cross_chain_route');
    expect(res.structuredContent.accepts[0]).toMatchObject({ amount: '10000', payTo: REZA, network: 'eip155:8453' });
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    expect(log).toEqual([]);
  });

  it('paid tool with _meta x402/payment verifies, settles once and blocks replay (shared with REST)', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    const payment = v2Payload('0x' + '55'.repeat(32));
    const params = { name: 'quote_cross_chain_route', arguments: baseQuoteInput, _meta: { 'x402/payment': payment } };
    const res = (await rpc(call, 'tools/call', params)).body.result;
    expect(res.isError).toBe(false);
    expect(res.structuredContent.best_route).toBeDefined();
    expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xsettled' });
    expect(st.calls.map((c) => c.path)).toEqual(['/verify', '/settle']);
    const again = (await rpc(call, 'tools/call', params)).body.result;
    expect(again.isError).toBe(true);
    expect(again.structuredContent.error).toMatch(/already used/);
    const rest = await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') });
    expect(rest.status).toBe(402);
    expect(st.calls).toHaveLength(2);
  });

  it('invalid arguments are a tool error, not a charge', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    const res = (await rpc(call, 'tools/call', { name: 'quote_cross_chain_route', arguments: { amount: 'x' }, _meta: { 'x402/payment': v2Payload('0x' + '66'.repeat(32)) } })).body.result;
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatch(/validation/);
    expect(st.calls).toHaveLength(0);
  });

  it('MCP_BILLING=gateway (MCPize-hosted) does not charge a second time', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot({ ...SIM, MCP_BILLING: 'gateway' }, [facilitator(st)]);
    const res = (await rpc(call, 'tools/call', { name: 'quote_cross_chain_route', arguments: baseQuoteInput })).body.result;
    expect(res.isError).toBe(false);
    expect(st.calls).toHaveLength(0);
  });
});

describe('402index verification', () => {
  it('serves the public verification hash (env override allowed)', async () => {
    const call = await boot(PROD);
    const r = await call('GET', '/.well-known/402index-verify.txt');
    expect(r.status).toBe(200);
    expect(r.raw.toString()).toBe('fb50ebb494bba5bec615badf9a1e777137cebf3ab3c2b9f7ea38ea8150704815');
    const o = await boot({ ...PROD, INDEX402_VERIFY: 'abcdef0123456789' });
    expect((await o('GET', '/.well-known/402index-verify.txt')).raw.toString()).toBe('abcdef0123456789');
  });
});
