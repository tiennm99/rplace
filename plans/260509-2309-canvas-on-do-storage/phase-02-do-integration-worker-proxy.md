---
phase: 2
title: "DO Integration & Worker Proxy"
status: completed
priority: P2
effort: "4h"
dependencies: [1]
---

# Phase 2: DO Integration & Worker Proxy

## Overview

Wire Phase 1 storage modules into `CanvasRoom` DO. Add DO-side methods (`getFullCanvas`, `placePixels`, accept WS) using SQLite. Refactor `worker.js` to a thin validation/routing proxy. End state: app works against DO storage, Upstash still present but unused except for migration in Phase 3.

## Requirements

**Functional:**
- DO exposes 3 internal HTTP endpoints (called by worker via `room.fetch`):
  - `GET /canvas` — returns 16 MB binary
  - `POST /place` — body `{userId, pixels}`, does cooldown check + write + broadcast atomically
  - `GET /ws` — WebSocket upgrade (existing behavior)
- Worker validates request shape and forwards to DO. Worker no longer touches storage.
- Broadcast still happens after successful write.

**Non-functional:**
- Single round-trip Worker → DO per `/api/place` (no extra trips for cooldown).
- DO write + broadcast same transaction-equivalent: cooldown check, pixel write, then broadcast — if write fails, no broadcast.

## Architecture

### DO method shape

```js
// canvas-room.js (refactored)
import { init as initSchema } from './lib/schema.js';
import { readAllChunks, writePixels } from './lib/chunk-storage.js';
import { tryAcquire, gc } from './lib/cooldown-store.js';
import { REQUEST_COOLDOWN_SEC } from '../lib/constants.js';

export class CanvasRoom {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    initSchema(this.sql);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/canvas') return this.#handleGetCanvas();
    if (url.pathname === '/place')  return this.#handlePlace(request);
    if (url.pathname === '/ws')     return this.#handleWsUpgrade();
    return new Response('not found', { status: 404 });
  }

  // ... existing webSocketMessage/Close/Error handlers unchanged
}
```

### Worker shape

```js
// worker.js (refactored)
app.get('/api/canvas', (c) => forwardToRoom(c, 'GET', '/canvas'));
app.post('/api/place', async (c) => {
  // validate body shape, batch size, pixel ranges (existing logic)
  const userId = await getUserId(c.req.raw);
  return forwardToRoom(c, 'POST', '/place', { userId, pixels: body.pixels });
});
app.get('/api/ws', (c) => forwardToRoom(c, 'GET', '/ws', null, c.req.raw));
```

### Broadcast after write

Inside DO `#handlePlace`:
1. `tryAcquire(sql, userId, 1000, Date.now())`. If blocked → return 429 with retryAfter.
2. `writePixels(sql, pixels)`.
3. Iterate `state.getWebSockets()` and `ws.send(JSON.stringify({type:'pixels', pixels}))`.
4. Return 200 OK.

Broadcast is now in-DO, not via separate `room.fetch('/broadcast')`. Eliminates the internal `broadcastPixels` round-trip from Phase 0 design.

## Related Code Files

**Modify:**
- `src/durable-objects/canvas-room.js` — add `#handleGetCanvas`, `#handlePlace`, refactor `#handleWsUpgrade`. Schema init in constructor.
- `src/worker.js` — strip storage logic, add `forwardToRoom` helper, keep validation.

**Create:**
- `test/integration/do-canvas-room.test.js` — Wrangler `unstable_dev` or Vitest CF pool harness, exercising place/get/ws end-to-end.

**Delete:** None this phase (Upstash code stays for Phase 3 migration).

## Implementation Steps

1. Refactor `canvas-room.js`:
   - Constructor calls `initSchema(state.storage.sql)`.
   - Replace single `fetch()` body with method dispatch on `url.pathname`.
   - Implement `#handleGetCanvas`: `readAllChunks(sql)` → return `application/octet-stream` with `Cache-Control: public, max-age=10, s-maxage=10, stale-while-revalidate=30`.
   - Implement `#handlePlace`: parse body, cooldown check, write pixels, broadcast, return JSON.
   - Move WS upgrade from worker into `#handleWsUpgrade`.
2. Refactor `worker.js`:
   - Add `forwardToRoom(c, method, path, jsonBody?, rawReq?)` helper.
   - Keep input validation (body size, pixel ranges, batch cap) in worker — defense in depth.
   - Replace direct Upstash calls with `forwardToRoom`.
   - `getUserId` stays in worker (uses request headers).
3. Add `c.executionCtx.waitUntil(...)` for opportunistic `gc()` calls (or move GC inside DO with low probability).
4. Write integration tests:
   - Boot Wrangler `unstable_dev` against this code.
   - Test: GET /api/canvas returns 16 MB, POST /api/place updates pixel, GET /api/canvas reflects update, second place from same user within 1s returns 429.
   - Test: WS connects, receives broadcast after another client's place.
5. Run `npm run test:all`. Existing Upstash-dependent tests will fail; mark them xfail or skip in this phase (will be deleted in Phase 4).
6. Run `npm run dev` (wrangler dev) and smoke-test in browser.

## Success Criteria

- [ ] `canvas-room.js` uses SQLite for canvas + cooldown
- [ ] `worker.js` has zero `redis*` or `Upstash` references
- [ ] Integration test: place pixel → read canvas → byte at expected offset is correct color
- [ ] Integration test: rate-limit returns 429 with `retryAfter`
- [ ] Browser smoke test: place pixels, see broadcast in second tab
- [ ] No regression in WS hibernation behavior

## Risk Assessment

| Risk | Mitigation |
|---|---|
| `room.fetch` overhead per request | Single round-trip per /api/place; same as today's setup |
| WS upgrade routing — worker → DO via fetch | Existing pattern works; passes `c.req.raw` through |
| 16 MB GET response in single DO call may hit limits | DO subrequest size cap is 32 MB; canvas is 16 MB → fits |
| Body size mismatch worker validation vs DO | Validate at both layers; DO trusts but verifies |
| Existing tests break | Expected — will be replaced in Phase 4 |
