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
