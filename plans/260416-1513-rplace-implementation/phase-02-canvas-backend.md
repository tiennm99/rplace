---
phase: 2
title: "Canvas Backend"
status: pending
effort: 3h
priority: P1
blocked_by: [1]
---

# Phase 2 — Canvas Backend

## Context Links
- [Redis BITFIELD command](https://redis.io/docs/latest/commands/bitfield/)
- [Upstash Redis REST API](https://docs.upstash.com/redis/features/restapi)

## Overview
Implement Redis BITFIELD-based canvas storage and two API routes: GET full canvas (binary), POST batch pixel placement.

## Key Insights

- 5 bits per pixel → offset = `(y * CANVAS_WIDTH + x) * 5` for bit-level, or use `u5 #(y * CANVAS_WIDTH + x)` for field-level indexing
- Upstash `@upstash/redis` supports BITFIELD via `redis.bitfield(key, ...commands)`
- Single BITFIELD command can batch multiple SET subcommands → one round-trip for 256 pixels
- Full canvas = `2048 * 2048 * 5 / 8 = 2,621,440 bytes` (~2.5MB raw, ~1.5MB gzip)

## Data Flow

```
GET /api/canvas:
  Client → API Route → redis.get("canvas") as Buffer → gzip → Response (binary)

POST /api/canvas/place:
  Client → API Route
    → Validate batch (coords, color indices, size ≤ 256)
    → Check rate limit credits
    → redis.bitfield("canvas", ...SET commands)
    → Publish update to Pub/Sub
    → Return {ok: true, remaining_credits}
```

## Architecture

### `src/lib/canvas-storage.js`

```js
// getFullCanvas() → Buffer (raw BITFIELD bytes)
// setPixels(pixels: [{x, y, color}]) → void (batch BITFIELD SET)
// getPixel(x, y) → colorIndex (single BITFIELD GET)
```

### `src/app/api/canvas/route.js`

```js
// GET handler:
//   1. Call getFullCanvas()
//   2. Gzip compress
//   3. Return with Content-Type: application/octet-stream
//      + Content-Encoding: gzip
//      + Cache-Control: public, max-age=1, stale-while-revalidate=5
```

### `src/app/api/canvas/place/route.js`

```js
// POST handler:
//   1. Parse body: { pixels: [{x, y, color}] }
//   2. Validate: all coords in range, color 0-31, batch ≤ 256
//   3. Identify user (IP or auth session)
//   4. Check/deduct rate limit credits
//   5. Call setPixels(pixels)
//   6. Publish batch to Redis Pub/Sub
//   7. Return { ok: true, credits: remaining }
```

## Related Code Files

### Create
- `src/lib/canvas-storage.js`
- `src/app/api/canvas/route.js`
- `src/app/api/canvas/place/route.js`

### Modify
- `src/lib/redis-client.js` (if stub needs fleshing out)

## Implementation Steps

1. **Implement `canvas-storage.js`**
   - `getFullCanvas()`: Use `redis.get(REDIS_CANVAS_KEY)` — Upstash returns base64, decode to Buffer
   - `setPixels(pixels)`: Build BITFIELD command array: for each pixel, push `['SET', 'u5', `#${y * W + x}`, color]`, execute as single `redis.bitfield()`
   - `getPixel(x, y)`: `redis.bitfield(key, ['GET', 'u5', `#${y * W + x}`])`
   - Handle empty canvas (key doesn't exist) → return zeroed buffer

2. **Implement GET `/api/canvas`**
   - Import `getFullCanvas`
   - Compress with `zlib.gzipSync()`
   - Return `new Response(gzipped, { headers })` with proper content headers
   - Add `Cache-Control: public, max-age=1, s-maxage=1, stale-while-revalidate=5`

3. **Implement POST `/api/canvas/place`**
   - Parse JSON body
   - Validate input schema:
     - `pixels` is array, length 1-256
     - Each pixel: `x` int 0-2047, `y` int 0-2047, `color` int 0-31
   - Extract user identity (IP from `request.headers.get('x-forwarded-for')` or fallback)
   - Rate limiting call (stub for now, Phase 3)
   - Call `setPixels(validatedPixels)`
   - Publish to Pub/Sub (stub for now, Phase 4)
   - Return JSON response

4. **Initialize canvas** — add a utility or on-demand initialization: if canvas key missing, SET empty buffer of correct size

## Todo List

- [ ] Implement `canvas-storage.js` with getFullCanvas, setPixels, getPixel
- [ ] Handle empty/missing canvas key initialization
- [ ] Implement GET `/api/canvas` with gzip compression
- [ ] Implement POST `/api/canvas/place` with validation
- [ ] Add input validation helpers
- [ ] Test with curl / httpie against local dev
- [ ] Verify BITFIELD offset calculation is correct

## Success Criteria
- GET `/api/canvas` returns gzipped binary of correct size (2.5MB uncompressed)
- POST `/api/canvas/place` with valid payload writes pixels and returns success
- POST with invalid coords/colors returns 400
- POST with >256 pixels returns 400
- Empty canvas initializes correctly on first read

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Upstash BITFIELD API differences from raw Redis | Med | High | Test early; check Upstash docs for BITFIELD support |
| Buffer encoding issues (base64 vs binary) | Med | Med | Log and compare byte lengths; add unit tests |
| BITFIELD command size limit per request | Low | Med | Upstash allows large commands; if limited, chunk into batches of 50 |

## Failure Modes
1. **Redis unavailable** → API returns 503, client retries with backoff
2. **Corrupt canvas data** → Validate BITFIELD size on read; re-init if wrong size
3. **Race condition on concurrent writes** → BITFIELD is atomic per command; batch SET is atomic → safe

## Rollback
Remove API route files and canvas-storage.js. No persistent side effects beyond Redis data (flush key).
