import { parseCookie } from './cookie.js';

/**
 * Cookie-first / IP-fallback identity for rate-limit bucketing. Cookie unblocks
 * NAT/CGNAT users who'd otherwise share a single IP bucket; IP is the legacy
 * fallback when the browser doesn't yet have a cookie.
 *
 * Returns `{ id, mintCookieValue? }`. When `mintCookieValue` is set, the
 * caller (worker) should attach a Set-Cookie header so subsequent requests
 * use cookie identity instead of falling through to IP.
 *
 * In production (env.ENVIRONMENT === 'production') a request with neither
 * cookie nor cf-connecting-ip throws NoIdentityError — the caller maps to
 * 500 no_identity. In dev the same case falls back to a shared bucket so
 * `wrangler dev` still works.
 *
 * @param {Request} request
 * @param {{ ENVIRONMENT?: string }} [env]
 * @returns {Promise<{ id: string, mintCookieValue?: string }>}
 */
export async function resolveIdentity(request, env) {
  const cookies = parseCookie(request.headers.get('cookie'));
  const existing = cookies.get('rplace_id');
  if (existing && isValidCookieValue(existing)) {
    return { id: `cookie:${existing}` };
  }

  const ip = request.headers.get('cf-connecting-ip');
  if (ip) {
    const hash = await hashIp(ip);
    return { id: `ip:${hash}`, mintCookieValue: crypto.randomUUID() };
  }

  if (env?.ENVIRONMENT === 'production') {
    throw new NoIdentityError();
  }

  console.warn('cf-connecting-ip missing — falling back to shared dev bucket');
  return { id: 'dev:shared', mintCookieValue: crypto.randomUUID() };
}

export class NoIdentityError extends Error {
  constructor() {
    super('no_identity');
    this.name = 'NoIdentityError';
  }
}

/** Accept only opaque UUID-shaped values; reject anything that smells injected. */
function isValidCookieValue(v) {
  return typeof v === 'string' && /^[0-9a-fA-F-]{32,40}$/.test(v);
}

async function hashIp(ip) {
  const data = new TextEncoder().encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
