import { getRedis } from './redis-client.js';
import { REQUEST_COOLDOWN_SEC, REDIS_KEY_PREFIX } from './constants.js';

/**
 * One request per user per REQUEST_COOLDOWN_SEC.
 * Batch size is independent of the cooldown — the caller validates it separately.
 *
 * Uses SET NX EX atomically: the first request in a window wins, subsequent
 * requests return null until the key expires.
 *
 * @param {object} env
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, retryAfter: number}>}
 */
export async function checkRateLimit(env, userId) {
  const redis = getRedis(env);
  const key = `${REDIS_KEY_PREFIX}cooldown:${userId}`;
  const result = await redis.set(key, '1', { nx: true, ex: REQUEST_COOLDOWN_SEC });
  if (result === 'OK') {
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: false, retryAfter: REQUEST_COOLDOWN_SEC };
}
