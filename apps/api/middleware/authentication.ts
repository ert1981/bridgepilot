import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { header } from '../http-utils.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

function matches(candidate: string, keys: string[]): boolean {
  const c = digest(candidate);
  let hit = false;
  for (const k of keys) if (timingSafeEqual(c, digest(k))) hit = true; // no early exit
  return hit;
}

export function extractKey(req: IncomingMessage): string | undefined {
  const x = header(req, 'x-api-key');
  if (x) return x.trim();
  const auth = header(req, 'authorization');
  const m = auth?.match(/^Bearer\s+(\S{8,256})$/i);
  return m?.[1];
}

export interface Identity {
  /** Stable, non-secret id used for rate limiting and record ownership. */
  id: string;
  apiKey: boolean;
  admin: boolean;
}

export function identify(req: IncomingMessage, apiKeys: string[], adminKeys: string[]): Identity {
  const key = extractKey(req);
  if (key && adminKeys.length && matches(key, adminKeys)) return { id: `key:${digest(key).toString('hex').slice(0, 16)}`, apiKey: true, admin: true };
  if (key && apiKeys.length && matches(key, apiKeys)) return { id: `key:${digest(key).toString('hex').slice(0, 16)}`, apiKey: true, admin: false };
  const ip = req.socket.remoteAddress ?? 'unknown';
  return { id: `ip:${ip}`, apiKey: false, admin: false };
}
