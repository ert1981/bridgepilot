import { createPrivateKey, randomInt, sign, type KeyObject } from 'node:crypto';

/**
 * CDP Facilitator auth (https://api.cdp.coinbase.com/platform/v2/x402), the same Bearer JWT the official
 * cdp-sdk builds (cdp/auth/utils/jwt.py, generate_jwt): header {alg, kid, typ, nonce}, claims
 * {sub, iss: "cdp", nbf, exp: nbf+120, uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]}.
 * Ed25519 secrets (base64, 64 bytes = seed + public key) sign with EdDSA, PEM EC secrets with ES256.
 * The key material is only held in memory and is never logged, returned or put into an error message.
 */
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/';
export const CDP_HOST = 'api.cdp.coinbase.com';
export const CDP_ROUTE = '/platform/v2/x402';
const X402_SOURCE_VERSION = '2.0.0';

export interface CdpCredentials { keyId: string; keySecret: string }

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Ed25519 PKCS#8 DER prefix for a raw 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function parseCdpSecret(secret: string): { key: KeyObject; alg: 'ES256' | 'EdDSA' } {
  const s = secret.includes('\\n') ? secret.replace(/\\n/g, '\n') : secret;
  if (s.includes('-----BEGIN')) {
    try {
      const key = createPrivateKey(s);
      if (key.asymmetricKeyType === 'ec') return { key, alg: 'ES256' };
    } catch {
      /* fall through to the generic error (never echo the key) */
    }
  } else {
    const raw = Buffer.from(s.trim(), 'base64');
    if (raw.length === 64) {
      return { key: createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' }), alg: 'EdDSA' };
    }
  }
  throw new Error('CDP_API_KEY_SECRET must be a PEM EC key or a base64 Ed25519 key');
}

const nonce = () => Array.from({ length: 16 }, () => String(randomInt(10))).join('');

export function cdpJwt(creds: CdpCredentials, method: 'GET' | 'POST', path: string, nowMs: number = Date.now()): string {
  const { key, alg } = parseCdpSecret(creds.keySecret);
  const now = Math.floor(nowMs / 1000);
  const header = { alg, kid: creds.keyId, typ: 'JWT', nonce: nonce() };
  const claims = { sub: creds.keyId, iss: 'cdp', nbf: now, exp: now + 120, uris: [`${method} ${CDP_HOST}${path}`] };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === 'EdDSA'
    ? sign(null, Buffer.from(input), key)
    : sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/** Headers for one CDP Facilitator call ('verify' | 'settle'), as cdp-sdk's create_cdp_auth_headers. */
export function cdpAuthHeaders(creds: CdpCredentials, op: 'verify' | 'settle', nowMs?: number): Record<string, string> {
  return {
    authorization: `Bearer ${cdpJwt(creds, 'POST', `${CDP_ROUTE}/${op}`, nowMs)}`,
    'correlation-context': `sdk_version=bridgepilot,sdk_language=typescript,source=x402,source_version=${X402_SOURCE_VERSION}`,
  };
}
