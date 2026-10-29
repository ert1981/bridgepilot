import { describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/app.js';
import { createServices } from '../src/services.js';
import { AuditLog } from '../src/observability/audit-log.js';
import { baseQuoteInput, mockFetch, NOW, rng, staticPrices, TEST_SEED, testConfig } from './helpers.js';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Drive the request handler in-process (no sockets) for high-volume fuzzing. */
function inProcess(env: Record<string, string> = {}) {
  const svc = createServices(testConfig({ PROVIDER_MODE: 'simulated', RATE_LIMIT_CAPACITY: '100000', ...env }), { fetch: mockFetch([]), now: () => NOW, prices: staticPrices() });
  const handle = createApp(svc);
  return async (method: string, url: string, body?: string, headers: Record<string, string> = {}) => {
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '10.0.0.1' } });
    let status = 0;
    let out = '';
    const fake: { headersSent: boolean; writeHead(s: number): unknown; end(t?: string): void } = {
      headersSent: false,
      writeHead(s: number) { status = s; fake.headersSent = true; return fake; },
      end(t?: string) { out = t ?? ''; },
    };
    const res = fake as unknown as ServerResponse;
    const p = handle(req, res);
    (req as PassThrough).end(body ?? '');
    await p;
    return { status, body: out };
  };
}

const r = rng(TEST_SEED);
const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
const junk = () =>
  pick<unknown>([
    null, true, -1, 0, 1.5, 1e309, '', ' ', 'base', '8453', '0x', 'USDC', '../../etc/passwd', '<script>', '0x' + 'f'.repeat(40),
    '9'.repeat(100), '-100', '1e18', {}, [], { $gt: '' }, '\u0000', 'ü'.repeat(70), Number.MAX_SAFE_INTEGER + 2,
  ]);

describe('security fuzzing', () => {
  it(`never returns 5xx for random malformed quote requests (seed ${TEST_SEED})`, async () => {
    const call = inProcess();
    const keys = [...Object.keys(baseQuoteInput), 'constraints', 'sender', 'recipient', 'providers', 'selection_policy', '__proto__', 'constructor'];
    for (let i = 0; i < 400; i++) {
      const body: Record<string, unknown> = { ...baseQuoteInput };
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) body[pick(keys)] = junk();
      if (r() < 0.2) body.constraints = { max_slippage_bps: junk(), min_output: junk(), max_total_cost_usd: junk() };
      const res = await call('POST', '/v1/routes/quote', JSON.stringify(body));
      expect(res.status, res.body).toBeLessThan(500);
      expect(() => JSON.parse(res.body)).not.toThrow();
    }
  });

  it('never returns 5xx for random paths, methods and raw bodies', async () => {
    const call = inProcess();
    const paths = ['/', '/v1', '/v1/routes/status/prep_x', '/v1/routes/status/../../x', '/%zz', '/v1/routes/quote?x=1', '//health', '/.well-known/ai-tool.json/x'];
    for (let i = 0; i < 200; i++) {
      const raw = Buffer.from(Array.from({ length: Math.floor(r() * 64) }, () => Math.floor(r() * 256))).toString('latin1');
      const res = await call(pick(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']), pick(paths), raw);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('does not leak internal errors or stack traces', async () => {
    const call = inProcess();
    const res = await call('POST', '/v1/routes/quote', '{"amount": ');
    expect(res.body).not.toMatch(/at .*\.ts:\d+/);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_JSON');
  });

  it('redacts secrets in the audit log', () => {
    const log = new AuditLog();
    log.record('x', { headers: { 'x-payment': 'secret', authorization: 'Bearer abc' }, api_key: 'k', amount: 5n });
    const ev = log.recent[0]!;
    expect(JSON.stringify(ev)).not.toMatch(/secret|Bearer abc|"k"/);
    expect(ev.amount).toBe('5');
  });

  it('rejects config that would enable payments without a payee', () => {
    expect(() => testConfig({ X402_MODE: 'facilitator' })).toThrow(/X402_PAY_TO/);
    expect(() => testConfig({ X402_MODE: 'facilitator', X402_PAY_TO: '0xnope' })).toThrow();
    expect(() => testConfig({ PROVIDER_MODE: 'yolo' })).toThrow();
  });

  it('user constraints can only tighten server caps', async () => {
    const call = inProcess();
    const res = await call('POST', '/v1/routes/quote', JSON.stringify({ ...baseQuoteInput, constraints: { max_slippage_bps: 5000, max_value_loss_bps: 9000 } }));
    const b = JSON.parse(res.body);
    expect(b.effective_constraints.max_slippage_bps).toBe(300);
    expect(b.effective_constraints.max_value_loss_bps).toBe(500);
    expect(b.warnings.join(' ')).toMatch(/clamped/);
  });
});
