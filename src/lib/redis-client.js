import { Redis } from '@upstash/redis/cloudflare';

/**
 * Create an Upstash Redis client from CF Worker env bindings.
 * @param {object} env - Cloudflare Worker env (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)
 * @returns {Redis}
 */
export function getRedis(env) {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}

/**
 * Execute a raw Redis command via Upstash REST API.
 * Useful for commands where the SDK API is unreliable (e.g., BITFIELD).
 * @param {object} env
 * @param {string[]} command - Redis command as array, e.g. ['BITFIELD', 'key', 'SET', ...]
 * @returns {Promise<*>} the `result` field from the Upstash response
 */
export async function redisRaw(env, command) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis HTTP ${res.status}: ${text}`);
  }
  // Upstash returns 200 with {"error":"..."} for application errors.
  const body = await res.json();
  if (body && body.error) {
    throw new Error(`Redis error: ${body.error}`);
  }
  return body.result;
}

/**
 * Execute a Redis command via Upstash path-based REST API with base64 response.
 * Uses Upstash-Encoding: base64 for binary-safe response transport.
 * @param {object} env
 * @param {string[]} command - Redis command as array, e.g. ['GETRANGE', 'key', '0', '100']
 * @returns {Promise<string|null>} base64-encoded result string
 */
export async function redisRawBinary(env, command) {
  const path = command.map((arg) => encodeURIComponent(String(arg))).join('/');
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/${path}`, {
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Upstash-Encoding': 'base64',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  if (body && body.error) {
    throw new Error(`Redis error: ${body.error}`);
  }
  return body.result; // base64-encoded string
}
