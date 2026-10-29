/**
 * Optional CDP Facilitator (agentic.market / CDP Bazaar indexing): used only when BOTH CDP_API_KEY_ID and
 * CDP_API_KEY_SECRET are set; otherwise PayAI exactly as before. Test keys are generated per run (none in the repo).
 */
import type { AddressInfo } from 'node:net';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../apps/api/server.js';
import { createServices } from '../src/services.js';
import { PAYAI_FACILITATOR_URL } from '../src/billing/x402.js';
import { CDP_FACILITATOR_URL, cdpAuthHeaders, cdpJwt, parseCdpSecret } from '../src/billing/cdp-auth.js';
import { BAZAAR_DESCRIPTION, bazaarExtension, TOOL_PATH } from '../apps/api/opensea-tool.js';
import { PREPARE_DESCRIPTION, PREPARE_PATH, prepareBazaarExtension } from '../apps/api/discovery.js';
import { baseQuoteInput, mockFetch, NOW, SENDER, staticPrices, testConfig, type Route } from './helpers.js';

type Body = Record<string, any>;
const REZA = '0x93714D5970f511Ac22f0E5635D3fBF538f717cd4';
const ORIGIN = 'https://bridgepilot.example.com';
const SIM = { PROVIDER_MODE: 'simulated', X402_MODE: 'facilitator', X402_PAY_TO: REZA, TOOL_CREATOR_ADDRESS: REZA, PUBLIC_BASE_URL: ORIGIN };

function ed25519Secret(): { secret: string; pub: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: Buffer.concat([seed, raw]).toString('base64'), pub: publicKey };
}
function ecSecret(): { secret: string; pub: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { secret: privateKey.export({ format: 'pem', type: 'sec1' }).toString(), pub: publicKey };
}
const KEY_ID = 'organizations/00000000-0000-0000-0000-000000000000/apiKeys/11111111-1111-1111-1111-111111111111';
const ED = ed25519Secret();
const CDP = { ...SIM, CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: ED.secret };

const decodeJwt = (t: string) => {
  const [h, c, s] = t.split('.');
  return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()), input: `${h}.${c}`, sig: Buffer.from(s!, 'base64url') };
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
    const text = await res.text();
    let json: Body | undefined;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json ?? ({} as Body), text, headers: res.headers };
  };
}
const b64json = (h: string | null) => JSON.parse(Buffer.from(h ?? '', 'base64').toString('utf8'));

/** Records every facilitator call (host, path, auth header, JSON body). */
const facilitator = (calls: Body[]): Route => (url, init) => {
  if (url.host !== 'api.cdp.coinbase.com' && url.host !== 'facilitator.payai.network') return undefined;
  const body = JSON.parse(String(init?.body ?? '{}'));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ host: url.host, path: url.pathname, authorization: headers.authorization, ...body });
  if (url.pathname.endsWith('/verify')) return { status: 200, body: { isValid: true, payer: SENDER } };
  if (url.pathname.endsWith('/settle')) return { status: 200, body: { success: true, transaction: '0xsettled', network: 'eip155:8453', payer: SENDER } };
  return undefined;
};
const auth = (nonce: string) => ({ from: SENDER, to: REZA, value: '10000', validAfter: '0', validBefore: String(Math.floor(NOW / 1000) + 600), nonce });
const v1 = (nonce: string) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xsig', authorization: auth(nonce) } })).toString('base64');
const v2 = (nonce: string, extra: Body = {}) => Buffer.from(JSON.stringify({
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: REZA, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
  payload: { signature: '0xsig', authorization: auth(nonce) },
  ...extra,
})).toString('base64');
const nonce = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(32);

describe('facilitator selection', () => {
  it('no CDP keys, or only one of them: PayAI, unchanged', () => {
    for (const env of [{}, { CDP_API_KEY_ID: KEY_ID }, { CDP_API_KEY_SECRET: ED.secret }, { CDP_API_KEY_ID: ' ', CDP_API_KEY_SECRET: ED.secret }] as Record<string, string>[]) {
      const cfg = testConfig({ X402_MODE: 'facilitator', X402_PAY_TO: REZA, ...env });
      expect(cfg.x402.facilitatorKind).toBe('payai');
      expect(cfg.x402.facilitatorUrl).toBe(PAYAI_FACILITATOR_URL);
      expect(cfg.x402.cdp).toBeUndefined();
    }
  });

  it('both CDP keys: CDP Facilitator URL (overrides X402_FACILITATOR_URL)', () => {
    const cfg = testConfig({ X402_MODE: 'facilitator', X402_PAY_TO: REZA, X402_FACILITATOR_URL: 'https://facilitator.payai.network', CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: ED.secret });
    expect(cfg.x402.facilitatorKind).toBe('cdp');
    expect(cfg.x402.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
    expect(new URL('settle', cfg.x402.facilitatorUrl).toString()).toBe('https://api.cdp.coinbase.com/platform/v2/x402/settle');
  });

  it('an unusable secret keeps PayAI and never echoes the secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = 'not-a-key-SECRETVALUE';
    const cfg = testConfig({ X402_MODE: 'facilitator', X402_PAY_TO: REZA, CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: bad });
    expect(cfg.x402.facilitatorKind).toBe('payai');
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
    expect(() => parseCdpSecret(bad)).toThrow(/^CDP_API_KEY_SECRET must be/);
    try { parseCdpSecret(bad); } catch (e) { expect(String(e)).not.toContain(bad); }
    warn.mockRestore();
  });
});

describe('CDP JWT (same shape as cdp-sdk generate_jwt)', () => {
  it('Ed25519 secret -> EdDSA, verifiable, correct claims and uri', () => {
    const t = cdpJwt({ keyId: KEY_ID, keySecret: ED.secret }, 'POST', '/platform/v2/x402/verify', NOW);
    const j = decodeJwt(t);
    expect(j.header).toMatchObject({ alg: 'EdDSA', kid: KEY_ID, typ: 'JWT' });
    expect(j.header.nonce).toMatch(/^[0-9]{16}$/);
    const now = Math.floor(NOW / 1000);
    expect(j.claims).toEqual({ sub: KEY_ID, iss: 'cdp', nbf: now, exp: now + 120, uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'] });
    expect(cryptoVerify(null, Buffer.from(j.input), ED.pub, j.sig)).toBe(true);
  });

  it('PEM EC secret (also with literal \\n) -> ES256, verifiable', () => {
    const ec = ecSecret();
    for (const secret of [ec.secret, ec.secret.replace(/\n/g, '\\n')]) {
      const j = decodeJwt(cdpJwt({ keyId: KEY_ID, keySecret: secret }, 'POST', '/platform/v2/x402/settle', NOW));
      expect(j.header.alg).toBe('ES256');
      expect(j.claims.uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/x402/settle']);
      expect(j.sig.length).toBe(64);
      expect(cryptoVerify('sha256', Buffer.from(j.input), { key: ec.pub, dsaEncoding: 'ieee-p1363' }, j.sig)).toBe(true);
    }
  });

  it('auth headers carry a Bearer JWT and correlation context, never the secret', () => {
    const h = cdpAuthHeaders({ keyId: KEY_ID, keySecret: ED.secret }, 'settle', NOW);
    expect(h.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(h['correlation-context']).toMatch(/source=x402/);
    expect(JSON.stringify(h)).not.toContain(ED.secret);
    expect(createPublicKey(parseCdpSecret(ED.secret).key).export({ format: 'der', type: 'spki' })).toEqual(ED.pub.export({ format: 'der', type: 'spki' }));
  });
});

describe('payments through the CDP Facilitator', () => {
  it('v2: authenticated verify + settle, payload carries resource and extensions.bazaar from the 402', async () => {
    const calls: Body[] = [];
    const call = await boot(CDP, [facilitator(calls)]);
    const challenge = b64json((await call('POST', TOOL_PATH, {})).headers.get('payment-required'));
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': v2(nonce(0x41)) });
    expect(r.status).toBe(200);
    expect(calls.map((c) => [c.host, c.path])).toEqual([
      ['api.cdp.coinbase.com', '/platform/v2/x402/verify'], ['api.cdp.coinbase.com', '/platform/v2/x402/settle'],
    ]);
    for (const c of calls) {
      const jwt = decodeJwt(String(c.authorization).replace(/^Bearer /, ''));
      expect(jwt.claims.uris).toEqual([`POST api.cdp.coinbase.com${c.path}`]);
      expect(cryptoVerify(null, Buffer.from(jwt.input), ED.pub, jwt.sig)).toBe(true);
      expect(c.x402Version).toBe(2);
      expect(c.paymentPayload.resource).toEqual(challenge.resource);
      expect(c.paymentPayload.extensions.bazaar).toEqual(challenge.extensions.bazaar);
      expect(c.paymentPayload.payload).toEqual({ signature: '0xsig', authorization: auth(nonce(0x41)) }); // signed part untouched
      expect(c.paymentRequirements).toEqual(challenge.accepts[0]);
    }
    expect(b64json(r.headers.get('payment-response'))).toMatchObject({ success: true, transaction: '0xsettled' });
  });

  it('v2 on /v1/routes/prepare forwards that route\'s resource and Bazaar metadata', async () => {
    const calls: Body[] = [];
    const call = await boot(CDP, [facilitator(calls)]);
    await call('POST', PREPARE_PATH, {}, { 'payment-signature': v2(nonce(0x42)) });
    expect(calls[0]!.paymentPayload.resource).toMatchObject({ url: `${ORIGIN}${PREPARE_PATH}`, description: PREPARE_DESCRIPTION });
    expect(calls[0]!.paymentPayload.extensions.bazaar).toEqual(prepareBazaarExtension().bazaar);
  });

  it('fields the client already sent are kept as sent', async () => {
    const calls: Body[] = [];
    const call = await boot(CDP, [facilitator(calls)]);
    const own = { url: `${ORIGIN}${TOOL_PATH}`, description: 'client copy', mimeType: 'application/json' };
    await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': v2(nonce(0x43), { resource: own, extensions: { other: { a: 1 } } }) });
    const p = calls.find((c) => c.path.endsWith('/settle'))!.paymentPayload;
    expect(p.resource).toEqual(own);
    expect(p.extensions.other).toEqual({ a: 1 });
    expect(p.extensions.bazaar).toEqual(bazaarExtension('0.01').bazaar);
  });

  it('v1 X-PAYMENT through CDP: authenticated, payload forwarded unchanged', async () => {
    const calls: Body[] = [];
    const call = await boot(CDP, [facilitator(calls)]);
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'x-payment': v1(nonce(0x44)) });
    expect(r.status).toBe(200);
    expect(calls.every((c) => /^Bearer /.test(c.authorization))).toBe(true);
    expect(calls[1]!.paymentPayload).toEqual(JSON.parse(Buffer.from(v1(nonce(0x44)), 'base64').toString()));
  });
});

describe('PayAI path is unchanged', () => {
  it('v2 without CDP keys: PayAI, no Authorization header, payload exactly as the client sent it', async () => {
    const calls: Body[] = [];
    const call = await boot(SIM, [facilitator(calls)]);
    const r = await call('POST', TOOL_PATH, baseQuoteInput, { 'payment-signature': v2(nonce(0x51)) });
    expect(r.status).toBe(200);
    expect(calls.map((c) => [c.host, c.path, c.authorization])).toEqual([
      ['facilitator.payai.network', '/verify', undefined], ['facilitator.payai.network', '/settle', undefined],
    ]);
    for (const c of calls) expect(c.paymentPayload).toEqual(JSON.parse(Buffer.from(v2(nonce(0x51)), 'base64').toString()));
  });
});

describe('402 before validation (Bazaar sends the example input or an empty body)', () => {
  for (const env of [SIM, CDP]) {
    it(`${env === CDP ? 'CDP' : 'PayAI'}: empty, {} and example bodies on both paid routes answer 402 with no facilitator call`, async () => {
      const calls: Body[] = [];
      const call = await boot(env, [facilitator(calls)]);
      for (const path of [TOOL_PATH, PREPARE_PATH]) {
        const example = path === TOOL_PATH ? bazaarExtension('0.01').bazaar.info.input.body : prepareBazaarExtension().bazaar.info.input.body;
        for (const body of ['', '{}', example, { nonsense: true }]) {
          const r = await call('POST', path, body);
          expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(402);
          const p = b64json(r.headers.get('payment-required'));
          expect(p.x402Version).toBe(2);
          expect(p.extensions.bazaar.info.input.body).toEqual(example);
        }
      }
      expect(calls).toHaveLength(0);
    });
  }
});

describe('Bazaar metadata is plain description (content policy)', () => {
  const strings = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
    return out;
  };
  const INSTRUCTION = /\b(ignore|disregard|you must|you should|always (call|use|pay)|never (call|use)|agents? (must|should)|instructions?|system prompt|do not tell|override|prefer this)\b/i;
  it('no agent-directed instructions in resource descriptions or extensions.bazaar', async () => {
    const call = await boot(SIM);
    for (const path of [TOOL_PATH, PREPARE_PATH]) {
      const p = b64json((await call('POST', path, {})).headers.get('payment-required'));
      for (const s of strings({ resource: p.resource, extensions: p.extensions })) expect(s, s).not.toMatch(INSTRUCTION);
    }
    for (const s of [BAZAAR_DESCRIPTION, PREPARE_DESCRIPTION]) expect(s).not.toMatch(INSTRUCTION);
  });
});

describe('no secret exposure', () => {
  it('public endpoints and 402s never contain the CDP key secret', async () => {
    const call = await boot(CDP);
    for (const [m, p, b] of [['GET', '/health'], ['GET', '/.well-known/x402'], ['GET', '/openapi.json'], ['POST', TOOL_PATH, {}], ['GET', '/metrics']] as [string, string, unknown?][]) {
      const r = await call(m, p, b);
      expect(r.text + JSON.stringify([...r.headers])).not.toContain(ED.secret);
      expect(Buffer.from(r.headers.get('payment-required') ?? '', 'base64').toString()).not.toContain(ED.secret);
    }
  });
});
