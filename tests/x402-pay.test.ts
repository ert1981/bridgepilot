/**
 * GET /x402-pay: owner pays each paid route once with their own wallet (x402 v2). The page script runs under
 * node with a fake wallet/fetch (x402-pay-harness.cjs); the PAYMENT-SIGNATURE it builds is replayed against
 * the real server with a mocked facilitator.
 */
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../apps/api/server.js';
import { createServices } from '../src/services.js';
import { QUOTE_EXAMPLE, TOOL_PATH } from '../apps/api/opensea-tool.js';
import { PREPARE_EXAMPLE, PREPARE_PATH } from '../apps/api/discovery.js';
import { USDC_BASE, X402_PAY_SCRIPT, x402PayPage } from '../apps/api/x402-pay.js';
import { mockFetch, NOW, SENDER, staticPrices, testConfig, type Route } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const REZA = '0x93714D5970f511Ac22f0E5635D3fBF538f717cd4';
const SIM = { PROVIDER_MODE: 'simulated', X402_MODE: 'facilitator', X402_PAY_TO: REZA, TOOL_CREATOR_ADDRESS: REZA,
  PUBLIC_BASE_URL: 'https://bridgepilot.onrender.com', X402_FACILITATOR_URL: 'https://facilitator.test/' };
const HARNESS = fileURLToPath(new URL('./x402-pay-harness.cjs', import.meta.url));
const servers: { close(): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

const facilitator = (st: { calls: Body[] }): Route => (url, init) => {
  if (url.host !== 'facilitator.test') return undefined;
  st.calls.push({ path: url.pathname, ...JSON.parse(String(init?.body ?? '{}')) });
  if (url.pathname === '/verify') return { status: 200, body: { isValid: true, payer: SENDER } };
  if (url.pathname === '/settle') return { status: 200, body: { success: true, transaction: '0xsettled', network: 'eip155:8453', payer: SENDER } };
  return undefined;
};

async function boot(routes: Route[] = [], now: () => number = () => NOW) {
  const svc = createServices(testConfig({ HOST: '127.0.0.1', ...SIM }), { fetch: mockFetch(routes), now, prices: staticPrices() });
  const { server } = await startServer(svc, 0, '127.0.0.1');
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: Body;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, body: json, headers: res.headers };
  };
}

const runPage = (input: Body): Body => JSON.parse(execFileSync('node', [HARNESS], { input: JSON.stringify({ clicks: [], ...input }), encoding: 'utf8' }));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const cfgOf = (html: string) => JSON.parse(html.split('<script type="application/json" id="cfg">')[1]!.split('</script>')[0]!);

describe('/x402-pay', () => {
  it('is served under a strict, hash-pinned CSP with both paid routes and the real Base USDC', async () => {
    const call = await boot();
    const r = await call('GET', '/x402-pay');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csp = r.headers.get('content-security-policy')!;
    const script = r.text.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)![1]!;
    expect(script).toBe(X402_PAY_SCRIPT);
    expect(csp).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    for (const part of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(part);
    expect(csp).not.toContain('unsafe-eval');
    const cfg = cfgOf(r.text);
    expect(cfg.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(cfg.payee).toBe(REZA);
    expect(cfg.routes.map((x: Body) => [x.path, x.example])).toEqual([[TOOL_PATH, QUOTE_EXAMPLE], [PREPARE_PATH, PREPARE_EXAMPLE]]);
    expect(r.text).toContain('real payment');
    expect(r.text).toContain('eip6963:requestProvider');
    expect(r.text).not.toMatch(/__[A-Z]+__/);
    expect(r.text).not.toMatch(/private.?key|mnemonic|seed/i);
  });

  it('config JSON cannot close its script tag', () => {
    const html = x402PayPage('S', REZA, [{ id: 'a', name: 'n', path: '/a', example: { x: '</script><b>' } }], 1n);
    const cfg = html.split('id="cfg">')[1]!.split('</script>')[0]!;
    expect(cfg).not.toContain('<');
    expect(JSON.parse(cfg).routes[0].example.x).toBe('</script><b>');
  });

  it('signs EIP-3009 for the exact 402 terms, and the PAYMENT-SIGNATURE it builds settles on the real server', async () => {
    const st = { calls: [] as Body[] };
    // real clock: the page signs validAfter/validBefore around the browser's current time
    const call = await boot([facilitator(st)], () => Date.now());
    const html = (await call('GET', '/x402-pay')).text;
    const challenges: Record<string, string> = {};
    for (const [p, e] of [[TOOL_PATH, QUOTE_EXAMPLE], [PREPARE_PATH, PREPARE_EXAMPLE]] as const) {
      const r = await call('POST', p, e);
      expect(r.status).toBe(402);
      challenges[p] = r.headers.get('payment-required')!;
    }
    const ch = unb64(challenges[TOOL_PATH]!);
    const a = ch.accepts[0];
    expect(a.asset).toBe(USDC_BASE);
    const out = runPage({ html, challenges, clicks: ['quote'], chainId: '0x1', receiptHeader: b64({ success: true, transaction: '0x' + 'ab'.repeat(32) }) });
    expect(out['price-quote']).toBe('<b>0.01 USDC</b>');
    expect(out['price-prepare']).toBe('<b>0.01 USDC</b>');
    expect(out.total).toBe('0.02 USDC');
    expect(out.wallet).toContain('wallet_switchEthereumChain');
    expect(out.confirms).toHaveLength(1);
    expect(out.confirms[0]).toContain('0.01 USDC');
    expect(out.signs).toHaveLength(1);
    const typed = JSON.parse(out.signs[0][1]);
    expect(typed.domain).toEqual({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: a.asset });
    expect(typed.message.to).toBe(REZA);
    expect(typed.message.value).toBe(a.amount);
    expect(Number(typed.message.validBefore) - Number(typed.message.validAfter)).toBe(600 + a.maxTimeoutSeconds);
    expect(out['res-quote']).toContain('basescan.org/tx/0x' + 'ab'.repeat(32));
    const sig = out.paid[0].signature;
    const sent = unb64(sig);
    expect(sent.x402Version).toBe(2);
    expect(sent.accepted).toEqual(a);
    expect(sent.resource).toEqual(ch.resource);
    expect(sent.extensions).toEqual(ch.extensions);
    const r = await call('POST', TOOL_PATH, QUOTE_EXAMPLE, { 'payment-signature': sig });
    expect([r.status, r.headers.get('payment-required') && unb64(r.headers.get('payment-required')!).error]).toEqual([200, null]);
    expect(st.calls.map((c) => c.path)).toEqual(['/verify', '/settle']);
    expect(unb64(r.headers.get('payment-response')!).transaction).toBe('0xsettled');
  });

  it('prepare uses the connected account and the quote paid earlier on the page', async () => {
    const call = await boot();
    const html = (await call('GET', '/x402-pay')).text;
    const challenges: Record<string, string> = {};
    for (const [p, e] of [[TOOL_PATH, QUOTE_EXAMPLE], [PREPARE_PATH, PREPARE_EXAMPLE]] as const) challenges[p] = (await call('POST', p, e)).headers.get('payment-required')!;
    const out = runPage({ html, challenges, clicks: ['quote', 'prepare'], paidBody: { best_route: { provider: 'lifi', expected_output: '99990000' } } });
    const paid = out.requests.filter((q: Body) => q.paid);
    expect(paid.map((q: Body) => q.path)).toEqual([TOOL_PATH, PREPARE_PATH]);
    expect(paid[1].body).toMatchObject({ sender: '0x00000000000000000000000000000000000000aa', recipient: '0x00000000000000000000000000000000000000aa', provider: 'lifi', accepted_output: '99990000' });
  });

  it.each([{ asset: '0x833589fCD6eDb6E08f4c7C32D2A403d29B4C55Bb' }, { payTo: '0x' + '77'.repeat(20) }, { network: 'eip155:84532' }, { amount: '5000001' }])(
    'refuses unexpected terms without asking to sign: %o', (over) => {
      const a = { scheme: 'exact', network: 'eip155:8453', asset: USDC_BASE, amount: '10000', payTo: REZA, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }, ...over };
      const html = x402PayPage('S', REZA, [{ id: 'a', name: 'A', path: '/a', example: {} }], 5_000_000n);
      const out = runPage({ html, challenges: { '/a': b64({ x402Version: 2, resource: { url: 'x' }, accepts: [a] }) }, clicks: ['a'] });
      expect(out.signs).toEqual([]);
      expect(out.paid).toEqual([]);
      expect(out.confirms).toEqual([]);
    });

  it('cancelled confirm signs nothing; a double click pays once', () => {
    const routes = [{ id: 'a', name: 'A', path: '/a', example: {} }, { id: 'b', name: 'B', path: '/b', example: {} }];
    const html = x402PayPage('S', REZA, routes, 5_000_000n);
    const c = (amount: string) => b64({ x402Version: 2, resource: { url: 'x' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC_BASE, amount, payTo: REZA, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }] });
    const challenges = { '/a': c('10000'), '/b': c('10000') };
    let out = runPage({ html, challenges, clicks: ['a'], confirm: false });
    expect(out.signs).toEqual([]);
    expect(out['res-a']).toContain('Cancelled');
    out = runPage({ html, challenges, clicks: ['a', 'b'], concurrent: true });
    expect(out.confirms).toHaveLength(1);
    expect(out.signs).toHaveLength(1);
    expect(out.paid).toHaveLength(1);
  });
});
