import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../../src/utils/errors.js';

export const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'",
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, e: ApiError, requestId: string, headers: Record<string, string> = {}): void {
  send(res, e.httpStatus, { status: 'error', request_id: requestId, error: { code: e.code, message: e.message, details: e.details ?? null } }, headers);
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ct)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${maxBytes} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${maxBytes} bytes.`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Body must be a JSON object.');
  }
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
