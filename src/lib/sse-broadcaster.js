import redis from './redis-client.js';
import { REDIS_UPDATES_KEY } from './constants.js';

/**
 * Publish a batch of pixel updates to Redis for SSE consumers.
 * Uses a sorted set with timestamp scores for ordered retrieval.
 * @param {Array<{x: number, y: number, color: number}>} pixels
 */
export async function publishPixelUpdates(pixels) {
  const now = Date.now();
  const entry = JSON.stringify({ pixels, ts: now });
  // Store with timestamp score, auto-expire old entries
  await redis.zadd(REDIS_UPDATES_KEY, { score: now, member: entry });
  // Trim entries older than 60 seconds
  await redis.zremrangebyscore(REDIS_UPDATES_KEY, 0, now - 60000);
}

/**
 * Get all pixel updates since a given timestamp.
 * @param {number} since - timestamp in ms
 * @returns {Promise<Array<{pixels: Array, ts: number}>>}
 */
export async function getUpdatesSince(since) {
  const entries = await redis.zrangebyscore(
    REDIS_UPDATES_KEY,
    since,
    '+inf',
  );
  return entries.map((e) => (typeof e === 'string' ? JSON.parse(e) : e));
}
