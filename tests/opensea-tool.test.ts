/**
 * OpenSea Tools (ERC-8257) listing: manifest, JCS hash, x402 v1 + v2 (PAYMENT-REQUIRED / Bazaar,
 * PAYMENT-SIGNATURE), PNG icon, /register-onchain signing page, config validation.
 */
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, toBytes } from 'viem';
import { startServer } from '../apps/api/server.js';
import { createServices } from '../src/services.js';
import { QuoteRequestSchema } from '../src/schemas/request.schema.js';
import { atomicToUsdc, PAYAI_FACILITATOR_URL } from '../src/billing/x402.js';
import { buildToolManifest, canonicalize, manifestHash, manifestStatus, MANIFEST_PATH, TOOL_INPUTS, TOOL_PATH, TOOL_SLUG } from '../apps/api/opensea-tool.js';
import { iconPng } from '../apps/api/icon.js';
import { REGISTRY, registerTx, SCRIPT_CSP_HASH, TOOL_REGISTERED_TOPIC } from '../apps/api/register-page.js';
import { baseQuoteInput, mockFetch, NOW, SENDER, staticPrices, testConfig, type Route } from './helpers.js';

type Body = Record<string, any>;
const REZA = '0x93714D5970f511Ac22f0E5635D3fBF538f717cd4';
const ORIGIN = 'https://bridgepilot.example.com';
const LISTED = {
  PROVIDER_MODE: 'live', X402_MODE: 'facilitator', X402_PAY_TO: REZA, TOOL_CREATOR_ADDRESS: REZA,
  PUBLIC_BASE_URL: ORIGIN, X402_FACILITATOR_URL: 'https://facilitator.test/',
};
const servers: { close(): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function boot(env: Record<string, string>, routes: Route[] = []) {
  const svc = createServices(testConfig({ HOST: '127.0.0.1', ...env }), { fetch: mockFetch(routes), now: () => NOW, prices: staticPrices() });
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

describe('ERC-8257 manifest', () => {
  it('is served at /.well-known/ai-tool/<slug>.json with the tool-sdk shape', async () => {
    const call = await boot(LISTED);
    const r = await call('GET', MANIFEST_PATH);
    expect(r.status).toBe(200);
    expect(MANIFEST_PATH).toBe(`/.well-known/ai-tool/${TOOL_SLUG}.json`);
    expect(TOOL_SLUG).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/); // tool-sdk verify slug pattern
    const m = r.body;
    expect(m.type).toBe('https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1');
    expect(m.endpoint).toBe(`${ORIGIN}${TOOL_PATH}`);
    expect(new URL(m.endpoint).origin).toBe(ORIGIN); // same origin as the manifest
    expect(m.creatorAddress).toBe(REZA.toLowerCase());
    expect(m.creatorAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(m.name.length).toBeLessThanOrEqual(128);
    expect(m.description.length).toBeLessThanOrEqual(500);
    expect(m.image).toBe(`${ORIGIN}/static/icon.png`);
    expect(m.pricing).toEqual([{
      amount: '10000',
      asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: `eip155:8453:${REZA.toLowerCase()}`,
      protocol: 'x402',
    }]);
    expect(m.verifiability).toMatchObject({ tier: 'self-attested', execution: 'server' });
    expect(m.verifiability.description.length).toBeLessThanOrEqual(500);
    // Only the routing API is listed; the testnet bridge protocol is not part of the tool.
    expect(JSON.stringify(m)).not.toMatch(/prepare|BridgeVault|attester|relayer/i);
  });

  it('declares the same input fields as the quote request validator', () => {
    const zodKeys = Object.keys(QuoteRequestSchema.shape).sort();
    expect(Object.keys(TOOL_INPUTS.properties).sort()).toEqual(zodKeys);
    for (const k of TOOL_INPUTS.required) expect(QuoteRequestSchema.shape[k as keyof typeof QuoteRequestSchema.shape].isOptional()).toBe(false);
  });

  it('answers 503 (never a wrong manifest) until fully configured', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ PUBLIC_BASE_URL: 'http://bridgepilot.example.com' }, /https/],
      [{ PUBLIC_BASE_URL: `${ORIGIN}/api` }, /bare https/],
      [{ TOOL_CREATOR_ADDRESS: '' }, /TOOL_CREATOR_ADDRESS/],
      [{ PROVIDER_MODE: 'simulated' }, /PROVIDER_MODE=live/],
      [{ X402_PAID_PATHS: '/v1/routes/prepare' }, /X402_PAID_PATHS/],
    ];
    for (const [over, reason] of cases) {
      const call = await boot({ ...LISTED, ...over });
      const r = await call('GET', MANIFEST_PATH);
      expect(r.status, JSON.stringify(over)).toBe(503);
      expect(r.body.error.code).toBe('TOOL_NOT_CONFIGURED');
      expect(r.body.error.message).toMatch(reason);
      expect((await call('GET', '/register-onchain')).status).toBe(503);
    }
    const off = await boot({ PROVIDER_MODE: 'live', TOOL_CREATOR_ADDRESS: REZA, PUBLIC_BASE_URL: ORIGIN });
    expect((await off('GET', MANIFEST_PATH)).status).toBe(503);
  });

  it('reflects a configured price (X402_PRICE_ATOMIC) in manifest and 402', async () => {
    const call = await boot({ ...LISTED, X402_PRICE_ATOMIC: '25000' });
    expect((await call('GET', MANIFEST_PATH)).body.pricing[0].amount).toBe('25000');
    const c = await call('POST', TOOL_PATH, {});
    expect(c.body.accepts[0].maxAmountRequired).toBe('25000');
    expect(b64json(c.headers.get('payment-required')).accepts[0].amount).toBe('25000');
  });

  it('hash is the JCS keccak256 that tool-sdk computes, stable and content-bound', () => {
    const cfg = testConfig(LISTED);
    const m = buildToolManifest(cfg);
    const h = manifestHash(m);
    expect(h).toBe(keccak256(toBytes(canonicalize(m))));
    expect(manifestHash(JSON.parse(JSON.stringify(m)))).toBe(h); // survives a JSON round-trip (what OpenSea fetches)
    // Pinned value, cross-checked with `npx @opensea/tool-sdk hash` (0.31.1) on this exact manifest.
    expect(h).toBe(PINNED_HASH);
    expect(manifestHash(buildToolManifest(testConfig({ ...LISTED, X402_PRICE_ATOMIC: '20000' })))).not.toBe(h);
    expect(manifestHash(buildToolManifest(testConfig({ ...LISTED, PUBLIC_BASE_URL: 'https://other.example.com' })))).not.toBe(h);
  });
});

describe('JCS canonicalization (RFC 8785)', () => {
  it('sorts keys recursively, keeps array order, drops undefined, escapes like JSON', () => {
    expect(canonicalize({ b: 1, a: [3, { d: true, c: null }], e: undefined })).toBe('{"a":[3,{"c":null,"d":true}],"b":1}');
    expect(canonicalize({ '\u00e9': 'é', a: 'x"y\n' })).toBe('{"a":"x\\"y\\n","é":"é"}');
    expect(canonicalize([1.5, 1e21, -0])).toBe('[1.5,1e+21,0]');
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });
});

describe('x402 for OpenSea review and agentic.market', () => {
  const facilitator = (st: { calls: Body[] }, verify: Body = { isValid: true, payer: SENDER }, status = 200): Route => (url, init) => {
    if (url.host !== 'facilitator.test') return undefined;
    const body = JSON.parse(String(init?.body ?? '{}'));
    st.calls.push({ path: url.pathname, ...body });
    if (url.pathname === '/verify') return { status, body: verify };
    if (url.pathname === '/settle') return { status: 200, body: { success: true, transaction: '0xsettled', network: body.x402Version === 2 ? 'eip155:8453' : 'base', payer: SENDER } };
    return undefined;
  };
  const auth = (nonce: string) => ({ from: SENDER, to: REZA, value: '10000', validAfter: '0', validBefore: String(Math.floor(NOW / 1000) + 600), nonce });
  const v1 = (nonce: string) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xsig', authorization: auth(nonce) } })).toString('base64');
  const v2 = (nonce: string, accepted: Body = {}) => Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: REZA, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...accepted },
    payload: { signature: '0xsig', authorization: auth(nonce) },
  })).toString('base64');
  const SIM = { ...LISTED, PROVIDER_MODE: 'simulated' };

  it('an empty probe (tool-sdk verify POSTs "{}") gets 402 with v1 body + v2 PAYMENT-REQUIRED header', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(LISTED, [facilitator(st)]);
    for (const body of [{}, baseQuoteInput]) {
      const r = await call('POST', TOOL_PATH, body);
      expect(r.status).toBe(402);
      expect(r.headers.get('x-accept-payment')).toBe('x402');
      expect(r.body).toMatchObject({ x402Version: 1, error: 'X-PAYMENT header is required' });
      expect(r.body.accepts[0]).toEqual({
        scheme: 'exact', network: 'base', maxAmountRequired: '10000', resource: `${ORIGIN}${TOOL_PATH}`,
        description: 'BridgePilot cross-chain route quote (0.01 USDC)', mimeType: 'application/json', payTo: REZA,
        maxTimeoutSeconds: 60, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' },
      });
      const p = b64json(r.headers.get('payment-required'));
      expect(p.x402Version).toBe(2);
      expect(p.accepts).toEqual([{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: REZA, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }]);
      expect(p.resource).toMatchObject({ url: `${ORIGIN}${TOOL_PATH}`, mimeType: 'application/json', serviceName: 'BridgePilot', iconUrl: `${ORIGIN}/static/icon.png` });
      const bz = p.extensions.bazaar;
      expect(bz.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' });
      expect(QuoteRequestSchema.safeParse(bz.info.input.body).success).toBe(true); // the example is a valid request
      expect(bz.schema.properties.input.properties.body).toEqual(TOOL_INPUTS);
      expect(r.headers.get('access-control-expose-headers')).toMatch(/PAYMENT-REQUIRED/);
    }
    expect(st.calls).toHaveLength(0);
  });

  it('defaults to the PayAI facilitator and 0.01 USDC', () => {
    const cfg = testConfig({ X402_MODE: 'facilitator', X402_PAY_TO: REZA });
    expect(cfg.x402.facilitatorUrl).toBe(PAYAI_FACILITATOR_URL);
    expect(new URL('verify', cfg.x402.facilitatorUrl).toString()).toBe('https://facilitator.payai.network/verify');
    expect(cfg.x402.priceAtomic).toBe('10000');
    expect(atomicToUsdc('10000')).toBe('0.01');
    expect(atomicToUsdc('2990000')).toBe('2.99');
    expect(atomicToUsdc('1000000')).toBe('1');
    expect(testConfig({ X402_FACILITATOR_URL: 'https://facilitator.payai.network' }).x402.facilitatorUrl).toBe('https://facilitator.payai.network/');
  });

  it('v1 X-PAYMENT: verify + settle with v1 requirements', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'x-payment': v1('0x' + '11'.repeat(32)) });
    expect(r.status).toBe(200);
    expect(st.calls.map((c) => [c.path, c.x402Version, c.paymentRequirements.network])).toEqual([['/verify', 1, 'base'], ['/settle', 1, 'base']]);
    expect(b64json(r.headers.get('x-payment-response'))).toMatchObject({ success: true, transaction: '0xsettled', network: 'base' });
    expect(r.headers.get('payment-response')).toBeNull();
  });

  it('v2 PAYMENT-SIGNATURE: verify + settle with v2 requirements, PAYMENT-RESPONSE header, replay blocked across versions', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    const nonce = '0x' + '22'.repeat(32);
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': v2(nonce) });
    expect(r.status).toBe(200);
    expect(r.body.best_route).toBeDefined();
    expect(st.calls.map((c) => [c.path, c.x402Version, c.paymentRequirements.network, c.paymentRequirements.amount])).toEqual([
      ['/verify', 2, 'eip155:8453', '10000'], ['/settle', 2, 'eip155:8453', '10000'],
    ]);
    expect(b64json(r.headers.get('payment-response'))).toMatchObject({ success: true, transaction: '0xsettled', network: 'eip155:8453' });
    // Same authorization again (v2 or v1 framing) is refused locally.
    for (const hdr of [{ 'payment-signature': v2(nonce) }, { 'x-payment': v1(nonce) }] as Record<string, string>[]) {
      const again = await call('POST', TOOL_PATH, baseQuoteInput, hdr);
      expect(again.status).toBe(402);
      expect(again.body.error).toMatch(/already used/);
    }
    expect(st.calls).toHaveLength(2);
  });

  it('v2 payment whose accepted terms differ (payee, amount, network) is refused before the facilitator', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st)]);
    for (const acc of [{ payTo: SENDER }, { amount: '1' }, { network: 'eip155:84532' }, { asset: '0x0000000000000000000000000000000000000001' }]) {
      const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': v2('0x' + '33'.repeat(32), acc) });
      expect(r.status, JSON.stringify(acc)).toBe(402);
      expect(r.body.error).toMatch(/mismatch/);
      expect(r.headers.get('payment-required')).toBeTruthy();
    }
    expect(st.calls).toHaveLength(0);
  });

  it('a facilitator 4xx {isValid:false} surfaces its reason and frees the nonce', async () => {
    const st = { calls: [] as Body[] };
    const call = await boot(SIM, [facilitator(st, { isValid: false, invalidReason: 'insufficient_funds' }, 400)]);
    const hdr = v1('0x' + '44'.repeat(32));
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'x-payment': hdr });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('insufficient_funds');
    expect((await call('POST', TOOL_PATH, baseQuoteInput, { 'x-payment': hdr })).body.error).toBe('insufficient_funds'); // not "already used"
    expect(st.calls.filter((c) => c.path === '/settle')).toHaveLength(0);
  });
});

describe('icon', () => {
  it('is a valid 512x512 RGB PNG served as image/png', async () => {
    const png = iconPng();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString()).toBe('IDAT');
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe(512 * (512 * 3 + 1));
    const call = await boot(LISTED);
    const r = await call('GET', '/static/icon.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.raw.equals(png)).toBe(true);
  });
});

describe('/register-onchain', () => {
  it('builds registerTool(metadataURI, manifestHash, 0x0) for the creator, served with a strict CSP', async () => {
    const cfg = testConfig(LISTED);
    const tx = registerTx(cfg);
    expect(tx.to).toBe(REGISTRY);
    expect(tx.to).toBe('0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1');
    expect(tx.data.slice(0, 10)).toBe('0xfe1d0b16');
    expect(tx.creator).toBe(REZA.toLowerCase());
    const dec = decodeFunctionData({
      abi: [{ type: 'function', name: 'registerTool', stateMutability: 'nonpayable', inputs: [{ name: 'u', type: 'string' }, { name: 'h', type: 'bytes32' }, { name: 'p', type: 'address' }], outputs: [] }],
      data: tx.data,
    });
    expect(dec.args).toEqual([`${ORIGIN}${MANIFEST_PATH}`, manifestHash(buildToolManifest(cfg)), '0x0000000000000000000000000000000000000000']);
    expect(TOOL_REGISTERED_TOPIC).toBe(keccak256(toBytes('ToolRegistered(uint256,address,address,string,bytes32)')));

    const call = await boot(LISTED);
    const r = await call('GET', '/register-onchain');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    const html = r.raw.toString('utf8');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain(`script-src ${SCRIPT_CSP_HASH}`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(`'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`).toBe(SCRIPT_CSP_HASH);
    expect(() => new Function(scripts[0]!)).not.toThrow(); // syntactically valid JS
    const embedded = JSON.parse(html.match(/<script type="application\/json" id="tx">([\s\S]*?)<\/script>/)![1]!);
    expect(embedded).toMatchObject({ to: REGISTRY, data: tx.data, metadataURI: tx.metadataURI, manifestHash: tx.manifestHash, creator: tx.creator });
    // The page only sends eth_sendTransaction through the user's own wallet; nothing is signed server-side.
    expect(scripts[0]).toContain('eth_sendTransaction');
    expect(scripts[0]).not.toMatch(/privateKey|mnemonic|eth_sign"|personal_sign/);
  });
});

describe('config validation', () => {
  it('rejects bad price, creator and non-https facilitator', () => {
    for (const p of ['0', '-1', '1.5', 'abc', '010']) expect(() => testConfig({ X402_PRICE_ATOMIC: p }), p).toThrow(/X402_PRICE_ATOMIC/);
    expect(() => testConfig({ TOOL_CREATOR_ADDRESS: '0x123' })).toThrow(/TOOL_CREATOR_ADDRESS/);
    expect(() => testConfig({ X402_FACILITATOR_URL: 'http://facilitator.example.com/' })).toThrow(/https/);
    expect(manifestStatus(testConfig(LISTED)).ok).toBe(true);
  });
});

describe('deployment files', () => {
  it('Dockerfile runs Node 22, honours PORT, and never bakes secrets into the image', () => {
    const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(df).toMatch(/^FROM node:22/m);
    expect(df).toMatch(/npm ci/);
    expect(df).not.toMatch(/ENV\s+(X402_PAY_TO|API_KEYS|ADMIN_KEYS|LIFI_API_KEY|ACROSS_API_KEY)/);
    const di = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
    for (const p of ['.env', 'node_modules', 'contracts', 'data']) expect(di).toContain(p);
  });
});

const PINNED_HASH = '0xa51f2c62f715796f7e0a9a9d2987f8224db3a6332b6b55371120bd0bed084082';
