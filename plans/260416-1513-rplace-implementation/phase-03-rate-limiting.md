---
phase: 3
title: "Rate Limiting"
status: pending
effort: 2h
priority: P1
blocked_by: [2]
---

# Phase 3 — Rate Limiting (Stackable Credits)

## Context Links
- [Token bucket algorithm](https://en.wikipedia.org/wiki/Token_bucket)

## Overview
Implement stackable credit system: users accumulate 1 credit/second (max 256). Each pixel placement costs 1 credit. Batch placement deducts batch size from credits. All state stored in Redis Hash per user.

## Key Insights
- This is a **token bucket** pattern stored in Redis
- No background process needed — calculate credits on-demand from elapsed time
- Atomic check-and-deduct prevents race conditions via Redis scripting or MULTI/EXEC
- User key: `credits:{userId}` where userId = IP hash (anonymous) or user ID (authenticated)

## Data Flow

```
POST /api/canvas/place:
  1. Identify user → userId
  2. HGETALL credits:{userId} → {lastUpdate, credits}
  3. elapsed = now - lastUpdate
  4. newCredits = min(MAX_CREDITS, storedCredits + floor(elapsed))
  5. if newCredits < batchSize → reject 429
  6. remaining = newCredits - batchSize
  7. HSET credits:{userId} lastUpdate=now credits=remaining
  8. Proceed with pixel placement
```

## Architecture

### `src/lib/rate-limiter.js`

```js
// checkAndDeductCredits(userId, count) → { allowed: bool, remaining: int, retryAfter?: int }
//
// Algorithm:
//   1. Get stored state from Redis Hash
//   2. Calculate accrued credits from elapsed time
//   3. If sufficient: deduct and update; return allowed=true
//   4. If insufficient: return allowed=false with retryAfter seconds
//
// Edge cases:
//   - First-time user (no hash exists) → initialize with MAX_CREDITS
//   - Clock skew → use Redis server time (TIME command) if needed
```

### User Identity Extraction

```js
// src/lib/get-user-id.js
// getUserId(request) → string
//   1. Check NextAuth session → user.id
//   2. Fallback: hash of x-forwarded-for or request IP
//   3. Prefix: "auth:" or "anon:" to avoid collision
```

## Related Code Files

### Create
- `src/lib/rate-limiter.js`
- `src/lib/get-user-id.js`

### Modify
- `src/app/api/canvas/place/route.js` — integrate rate limiter

## Implementation Steps

1. **Create `get-user-id.js`**
   - Extract IP from `x-forwarded-for` header (first IP if multiple)
   - Hash IP with simple hash (e.g., substring of SHA-256) for privacy
   - If NextAuth session exists, use `session.user.id` with `auth:` prefix
   - Anonymous users get `anon:` prefix

2. **Create `rate-limiter.js`**
   - `checkAndDeductCredits(userId, count)`:
     - `redis.hgetall(`credits:${userId}`)` → parse lastUpdate, credits
     - If null (new user): set credits = MAX_CREDITS, lastUpdate = now
     - Calculate: `accrued = min(MAX_CREDITS, stored + floor((now - lastUpdate) / 1000))`
     - If `accrued < count`: return `{ allowed: false, remaining: accrued, retryAfter: count - accrued }`
     - Else: `redis.hset(key, { lastUpdate: now, credits: accrued - count })`, return `{ allowed: true, remaining: accrued - count }`
   - Use seconds (Unix timestamp) for lastUpdate
   - **Race condition mitigation**: Use Redis Lua script or pipeline with WATCH for atomicity. Upstash supports `redis.eval()` for Lua scripts.

3. **Integrate into place route**
   - Import `getUserId`, `checkAndDeductCredits`
   - Before pixel write: check credits
   - On rejection: return 429 with `{ error: 'rate_limited', retryAfter, remaining }`
   - On success: include `remaining` credits in response

4. **Add credits info endpoint** (optional, could be part of place response)
   - GET `/api/credits` → returns current credit count for user (calculated, not stored)

## Lua Script for Atomicity

```lua
-- KEYS[1] = credits:{userId}
-- ARGV[1] = count (pixels to place)
-- ARGV[2] = now (unix seconds)
-- ARGV[3] = max credits
-- ARGV[4] = regen rate (credits per second)

local data = redis.call('HGETALL', KEYS[1])
local lastUpdate = 0
local credits = tonumber(ARGV[3]) -- default max for new users

if #data > 0 then
  for i = 1, #data, 2 do
    if data[i] == 'lastUpdate' then lastUpdate = tonumber(data[i+1]) end
    if data[i] == 'credits' then credits = tonumber(data[i+1]) end
  end
end

local elapsed = tonumber(ARGV[2]) - lastUpdate
local accrued = math.min(tonumber(ARGV[3]), credits + math.floor(elapsed * tonumber(ARGV[4])))
local count = tonumber(ARGV[1])

if accrued < count then
  return {0, accrued, count - accrued} -- denied, remaining, retryAfter
end

local remaining = accrued - count
redis.call('HSET', KEYS[1], 'lastUpdate', ARGV[2], 'credits', remaining)
return {1, remaining, 0} -- allowed, remaining, 0
```

## Todo List

- [ ] Create `get-user-id.js` with IP extraction + hashing
- [ ] Create `rate-limiter.js` with credit calculation logic
- [ ] Implement Lua script for atomic check-and-deduct
- [ ] Integrate into POST `/api/canvas/place`
- [ ] Return 429 with retryAfter on rate limit
- [ ] Test: new user gets full credits
- [ ] Test: credits deplete and regenerate correctly
- [ ] Test: batch larger than available credits rejected

## Success Criteria
- New user can place 256 pixels immediately
- After depleting credits, requests return 429 with correct retryAfter
- Credits regenerate at 1/sec (verified by waiting and retrying)
- Concurrent requests don't grant double credits (Lua script atomicity)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Upstash Lua script limitations | Med | High | Test EVAL support early; fallback to non-atomic HGETALL+HSET |
| IP spoofing for unlimited credits | Med | Low | Vercel provides real IP; rate limit is soft defense anyway |
| Clock drift between app and Redis | Low | Low | Use Redis TIME or consistent Date.now() |

## Failure Modes
1. **Redis EVAL not supported** → Fallback to HGETALL + HSET (small race window acceptable for MVP)
2. **IP header missing** → Use fallback `127.0.0.1` hash (all anonymous users share limit — degrade gracefully)
3. **Hash key explosion** (many unique IPs) → Set TTL on credit hashes (e.g., 24h expiry via EXPIRE)

## Rollback
Remove rate-limiter.js, get-user-id.js. Remove rate limit check from place route (it was a stub before). Place route works without rate limiting.
