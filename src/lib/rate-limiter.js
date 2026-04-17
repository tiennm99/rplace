import { getRedis } from './redis-client.js';
import { MAX_CREDITS, CREDIT_REGEN_RATE, REDIS_KEY_PREFIX } from './constants.js';

/**
 * Lua script for atomic check-and-deduct of stackable credits.
 * Stores lastUpdate as ms (avoids fractional credit loss across calls).
 * Returns: [allowed (0/1), remaining, retryAfterSeconds]
 */
const CREDIT_SCRIPT = `
local now = tonumber(ARGV[2])
local maxCredits = tonumber(ARGV[3])
local regen = tonumber(ARGV[4])
local count = tonumber(ARGV[1])

local lastUpdate = now
local credits = maxCredits

local data = redis.call('HGETALL', KEYS[1])
if #data > 0 then
  for i = 1, #data, 2 do
    if data[i] == 'lu' then lastUpdate = tonumber(data[i+1]) end
    if data[i] == 'cr' then credits = tonumber(data[i+1]) end
  end
end

local elapsedMs = now - lastUpdate
local msPerCredit = 1000 / regen
local accruedDelta = math.floor(elapsedMs / msPerCredit)
local accrued = math.min(maxCredits, credits + accruedDelta)

if accrued < count then
  local deficit = count - accrued
  local retryAfter = math.ceil(deficit * msPerCredit / 1000)
  return {0, accrued, retryAfter}
end

-- Advance lastUpdate by exact ms used to accrue credits (preserves fractional residue).
-- When capped at maxCredits, discard residue (else lu drifts arbitrarily far back).
local newLastUpdate
if credits + accruedDelta > maxCredits then
  newLastUpdate = now
else
  newLastUpdate = lastUpdate + math.floor(accruedDelta * msPerCredit)
end

local remaining = accrued - count
redis.call('HSET', KEYS[1], 'lu', newLastUpdate, 'cr', remaining)
redis.call('EXPIRE', KEYS[1], 86400)
return {1, remaining, 0}
`;

/**
 * Check and deduct credits for a user's pixel placement.
 * @param {object} env
 * @param {string} userId
 * @param {number} count
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfter: number}>}
 *   retryAfter is in seconds.
 */
export async function checkAndDeductCredits(env, userId, count) {
  const redis = getRedis(env);
  const nowMs = Date.now();
  const key = `${REDIS_KEY_PREFIX}credits:${userId}`;

  const result = await redis.eval(
    CREDIT_SCRIPT,
    [key],
    [count, nowMs, MAX_CREDITS, CREDIT_REGEN_RATE],
  );

  return {
    allowed: result[0] === 1,
    remaining: result[1],
    retryAfter: result[2],
  };
}
