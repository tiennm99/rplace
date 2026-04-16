---
phase: 4
title: "Real-time Updates (SSE + Pub/Sub)"
status: pending
effort: 3h
priority: P1
blocked_by: [2]
---

# Phase 4 — Real-time Updates

## Context Links
- [MDN Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Upstash Redis Pub/Sub](https://docs.upstash.com/redis/howto/pubsub)

## Overview
Implement SSE endpoint that streams pixel updates to connected clients. When pixels are placed, the place route publishes deltas to Redis Pub/Sub. The SSE route subscribes and forwards to clients.

## Key Insights

- Vercel serverless functions have max execution time (10s free, 60s pro). SSE on Vercel works via **streaming responses** with Edge Runtime.
- Use **Edge Runtime** for SSE route — no cold start, streaming support
- Upstash Redis Pub/Sub works differently from traditional Redis: use `@upstash/redis` REST-based pub/sub or polling approach
- Alternative: Use Upstash's `@upstash/redis` with `subscribe` (if available) or implement polling-based SSE
- **Practical approach for Vercel**: SSE endpoint polls Redis for updates using a sorted set or list as message queue, rather than true Pub/Sub (which requires persistent connection)

## Data Flow

```
Pixel Placement:
  place/route.js → setPixels() → redis.publish("canvas:updates", JSON.stringify(batch))
                                  + redis.lpush("canvas:queue", JSON.stringify({ts, pixels}))

SSE Stream:
  stream/route.js (Edge Runtime):
    1. Client connects via EventSource
    2. Send initial heartbeat
    3. Poll loop: redis.lrange("canvas:queue", ...) for new updates since client's last seen ts
    4. Send each batch as SSE event
    5. Trim old entries periodically (LTRIM)

Alternative (simpler, recommended for MVP):
  stream/route.js:
    1. Client connects with ?since={timestamp}
    2. Server polls Redis list every 500ms
    3. Sends new batches as SSE data events
    4. Client reconnects on disconnect (EventSource auto-reconnects)
```

## Architecture

### Message Format (SSE event data)

```json
{
  "ts": 1713200000000,
  "pixels": [
    {"x": 100, "y": 200, "color": 5},
    {"x": 101, "y": 200, "color": 5}
  ]
}
```

### `src/lib/sse-broadcaster.js`

```js
// publishPixelUpdates(pixels) → void
//   - Add timestamped batch to Redis sorted set (score = timestamp)
//   - ZADD canvas:updates {score: Date.now(), member: JSON.stringify(batch)}
//   - ZREMRANGEBYSCORE to trim entries older than 60s (keep queue bounded)

// getUpdatesSince(since) → Array<batch>
//   - ZRANGEBYSCORE canvas:updates since +inf
//   - Parse and return batches
```

### `src/app/api/canvas/stream/route.js`

```js
// Edge Runtime for streaming
export const runtime = 'edge';

// GET handler:
//   1. Create ReadableStream
//   2. In stream: poll getUpdatesSince() every 500ms
//   3. Send SSE-formatted events for each batch
//   4. Send heartbeat comment every 15s to keep connection alive
//   5. Respect AbortSignal for cleanup
```

## Related Code Files

### Create
- `src/lib/sse-broadcaster.js`
- `src/app/api/canvas/stream/route.js`

### Modify
- `src/app/api/canvas/place/route.js` — add publishPixelUpdates() call after successful placement

## Implementation Steps

1. **Implement `sse-broadcaster.js`**
   - `publishPixelUpdates(pixels)`:
     - `redis.zadd('canvas:updates', { score: Date.now(), member: JSON.stringify({ ts: Date.now(), pixels }) })`
     - `redis.zremrangebyscore('canvas:updates', 0, Date.now() - 60000)` — trim old
   - `getUpdatesSince(since)`:
     - `redis.zrangebyscore('canvas:updates', since, '+inf')` 
     - Parse each member, return array

2. **Implement SSE stream route**
   - Use Edge Runtime (`export const runtime = 'edge'`)
   - Create `ReadableStream` with `start(controller)`:
     ```js
     const encoder = new TextEncoder();
     let lastSeen = parseInt(url.searchParams.get('since') || '0');
     const interval = setInterval(async () => {
       const updates = await getUpdatesSince(lastSeen + 1);
       for (const update of updates) {
         controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
         lastSeen = Math.max(lastSeen, update.ts);
       }
     }, 500);
     // heartbeat every 15s
     const heartbeat = setInterval(() => {
       controller.enqueue(encoder.encode(': heartbeat\n\n'));
     }, 15000);
     ```
   - Return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })`

3. **Integrate publishing into place route**
   - After `setPixels()` succeeds, call `publishPixelUpdates(pixels)`

4. **Handle edge cases**
   - AbortSignal / client disconnect → clear intervals
   - Empty poll → no-op (don't send empty events)
   - Reconnection: client sends `Last-Event-ID` or `?since=` param

## Todo List

- [ ] Create `sse-broadcaster.js` with ZADD/ZRANGEBYSCORE helpers
- [ ] Create SSE stream route with Edge Runtime
- [ ] Implement polling loop with heartbeat
- [ ] Integrate publishPixelUpdates into place route
- [ ] Handle client disconnect cleanup
- [ ] Test SSE stream with curl: `curl -N localhost:3000/api/canvas/stream`
- [ ] Test update delivery latency (<1s)

## Success Criteria
- SSE endpoint streams events to connected client
- Placing a pixel triggers SSE event within 1 second
- Heartbeat keeps connection alive
- Client reconnect resumes from last seen timestamp
- Old updates (>60s) cleaned up automatically

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vercel Edge Runtime limits SSE duration | High | High | Document limit; client auto-reconnects via EventSource; accept 30s reconnect cycle |
| Upstash REST latency for 500ms polling | Med | Med | Acceptable for MVP; upgrade to WebSocket/Ably if needed |
| Sorted set grows unbounded | Med | Med | ZREMRANGEBYSCORE trims old; add ZCARD check as safety |

## Failure Modes
1. **SSE connection drops** → EventSource auto-reconnects; `?since=` param ensures no missed updates
2. **Redis sorted set too large** → Trim runs on every publish; worst case: add ZCARD limit check
3. **High-frequency updates overwhelm client** → Batch multiple updates per SSE event; client-side throttle rendering
4. **Edge Runtime timeout** → Client reconnects; stateless polling means no server-side state lost

## Rollback
Remove stream route and sse-broadcaster.js. Remove publish call from place route. Frontend falls back to periodic full canvas refresh (degrade to polling).
