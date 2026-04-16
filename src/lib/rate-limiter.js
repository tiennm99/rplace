import redis from './redis-client.js';
import { MAX_CREDITS, CREDIT_REGEN_RATE } from './constants.js';

/**
 * Lua script for atomic check-and-deduct of stackable credits.
 * KEYS[1] = credits:{userId}
 * ARGV[1] = count (pixels to place)
 * ARGV[2] = now (unix seconds)
 * ARGV[3] = max credits
 * ARGV[4] = regen rate (credits per second)
 * Returns: [allowed (0/1), remaining, retryAfter]
 */
const CREDIT_SCRIPT = `
local data = redis.call('HGETALL', KEYS[1])
local lastUpdate = 0
local credits = tonumber(ARGV[3])

if #data > 0 then
  for i = 1, #data, 2 do
    if data[i] == 'lu' then lastUpdate = tonumber(data[i+1]) end
    if data[i] == 'cr' then credits = tonumber(data[i+1]) end
  end
end

local elapsed = tonumber(ARGV[2]) - lastUpdate
local accrued = math.min(tonumber(ARGV[3]), credits + math.floor(elapsed * tonumber(ARGV[4])))
local count = tonumber(ARGV[1])

if accrued < count then
  return {0, accrued, count - accrued}
end

local remaining = accrued - count
redis.call('HSET', KEYS[1], 'lu', ARGV[2], 'cr', remaining)
redis.call('EXPIRE', KEYS[1], 86400)
return {1, remaining, 0}
`;

/**
 * Check and deduct credits for a user's pixel placement.
 * @param {string} userId
 * @param {number} count - number of pixels to place
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfter: number}>}
 */
export async function checkAndDeductCredits(userId, count) {
  const now = Math.floor(Date.now() / 1000);
  const key = `credits:${userId}`;

  const result = await redis.eval(
    CREDIT_SCRIPT,
    [key],
    [count, now, MAX_CREDITS, CREDIT_REGEN_RATE],
  );

  return {
    allowed: result[0] === 1,
    remaining: result[1],
    retryAfter: result[2],
  };
}
