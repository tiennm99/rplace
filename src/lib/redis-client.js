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
    throw new Error(`Redis command failed: ${res.status} ${text}`);
  }
  return res.json();
}
