# Backend Code Review — rplace

Date: 2026-04-17
Scope: backend only (worker.js, durable-objects/, lib/, wrangler.json, package.json)
Reviewer: code-reviewer

## Summary

Backend is small, readable, and the core data path (Hono → Redis BITFIELD → DO broadcast) works. Found **2 Critical**, **5 High**, **6 Medium**, **4 Low**, **3 Nit** issues. Biggest risks: rate-limit retryAfter unit drift, IP-hash collisions sharing rate buckets, missing hibernation API on the DO (cost + memory), and the unprotected GET /api/canvas (2.5MB) becoming an Upstash quota / egress black hole under load.

---

## Critical

### C1. `retryAfter` is in credits, not seconds — silently correct only when `CREDIT_REGEN_RATE == 1`
File: `src/lib/rate-limiter.js:25`
```lua
return {0, accrued, count - accrued}
```
Returned value is the **credit deficit**, but the API contract (worker.js:60, README L133) labels it `retryAfter` in seconds. Today `CREDIT_REGEN_RATE = 1` so deficit-credits ≈ seconds, masking the bug. Anyone tuning regen rate (e.g. `CREDIT_REGEN_RATE = 0.5` for slower regen, or `2` for faster) breaks the contract immediately. Client could happily retry too early and hammer the API.

Fix:
```lua
local deficit = count - accrued
local retryAfter = math.ceil(deficit / tonumber(ARGV[4]))
return {0, accrued, retryAfter}
```
Add a unit test that flips REGEN_RATE to 0.5 and asserts retryAfter doubles.

### C2. `ARGV[4]` (regen rate) is read but `math.floor(elapsed * regen)` truncates fractional regen — fractional rates are silently broken
File: `src/lib/rate-limiter.js:21`
```lua
local accrued = math.min(tonumber(ARGV[3]), credits + math.floor(elapsed * tonumber(ARGV[4])))
```
With `CREDIT_REGEN_RATE = 0.5`, `elapsed * 0.5` is fractional; `math.floor` discards everything < 2 sec elapsed → user never regens credits unless they wait whole multiples. Also: accrued is computed as float-then-floor, but credit values are stored as floats in Redis HASH (HSET stores strings) — string round-tripping a float vs integer causes drift over time.

Fix: explicitly require integer regen rates, OR multiply both sides up to milliseconds and floor at the end. Document constraint in `constants.js`.

---

## High

### H1. IP hash uses a 32-bit space with a weak Java-style hash → collisions at ~65k unique IPs share rate-limit buckets
File: `src/lib/get-user-id.js:11-16`
```js
let hash = 0;
for (let i = 0; i < ip.length; i++) {
  hash = ((hash << 5) - hash + ip.charCodeAt(i)) | 0;
}
return `anon:${(hash >>> 0).toString(36)}`;
```
- Birthday paradox: collisions become likely at ≈√(2^32) ≈ 65,536 unique IPs. For a viral r/place clone this is plausible in hours.
- Two colliding users **share** the same `credits:{userId}` HASH → one user's spend depletes the other's credits → griefing vector.
- The hash provides **zero privacy** (no salt, deterministic, function is in the public client repo). If the goal is privacy, use HMAC with a secret env var. If the goal is just opacity in logs, say so.

Fix: Use SHA-256 of IP + a server-side secret salt (`env.IDENTITY_SALT`), truncate to 16 hex chars (64 bits → collisions at ~4B). Use `crypto.subtle.digest('SHA-256', ...)`.

### H2. `getUserId` falls back to `'127.0.0.1'` in dev → all dev users share one credit bucket; in prod the fallback masks misconfiguration
File: `src/lib/get-user-id.js:9`
```js
const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
```
- In `wrangler dev` there is no `cf-connecting-ip` header → every request is `anon:<hash of 127.0.0.1>` → testing rate-limit with multiple browser sessions appears broken.
- In production, if a request somehow arrives without the header (e.g. internal Worker→Worker, or test traffic), the silent fallback hides the bug AND grants a fresh user the shared global bucket.

Fix: in dev, fall back to a per-session token (cookie or `request.headers.get('x-forwarded-for')` first hop). In prod, return 400 if header missing — that case should never legitimately happen.

Also: no IPv6 normalization. `2001:db8::1` and `2001:0db8:0000:0000:0000:0000:0000:0001` hash differently. Cloudflare normalizes, but test it.

### H3. Durable Object uses `server.accept()` (non-hibernation) → DO stays pinned in memory while ANY client connected; you pay duration charges 24/7 for an idle room
File: `src/durable-objects/canvas-room.js:33`
```js
server.accept();
this.sessions.add(server);
```
Per Cloudflare docs, `acceptWebSocket()` (hibernation API) lets the runtime evict the DO from memory between messages while keeping connections open. With `accept()`, the DO is pinned for the entire connection lifetime. For a broadcast-only room that receives messages O(once per pixel placement), this is wasted compute spend.

Fix: Use the [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/):
```js
constructor(state, env) {
  this.state = state;
  this.sessions = new Set(state.getWebSockets()); // restore on wake
}
async fetch(request) {
  // ...
  this.state.acceptWebSocket(server);
  this.sessions.add(server);
  // ...
}
async webSocketClose(ws) { this.sessions.delete(ws); }
async webSocketError(ws) { this.sessions.delete(ws); }
```
Also: client→server messages (currently none, but if added later) need `webSocketMessage` handler.

### H4. GET /api/canvas: no compression, no real CDN cache, calls Upstash on every request → free-tier Redis quota dies in seconds; egress costs balloon
File: `src/worker.js:12-20`
```js
'Cache-Control': 'public, max-age=1, s-maxage=1, stale-while-revalidate=5',
```
- 2.5 MB raw binary × 10K concurrent loads = 25 GB egress. No `Content-Encoding: gzip` (Worker doesn't compress octet-stream automatically).
- `s-maxage=1` means Cloudflare CDN caches for **1 second**. For a canvas that updates every few seconds this is reasonable, but every miss re-runs `redis.getrange(...)` → 1 Upstash command per load. Upstash free tier = 10K commands/day → 10K page loads kills the day.
- BITFIELD-encoded 5-bit data is not compressible by general-purpose gzip well, but you could (a) cache the response in a Worker KV or DO memory for 1-2 sec, (b) increase `s-maxage` to 5-10s and let WS deltas bring stale clients in sync, (c) serve the canvas from the DO directly (it already has all the writes) instead of re-reading Redis.

Fix priority:
1. Add `Content-Encoding: gzip` (compress on the Worker — gzip a 5-bit packed buffer still saves 30-40% because of zero regions).
2. Bump `s-maxage` to at least `5` (matches `stale-while-revalidate`).
3. Long-term: keep canvas in DO memory and serve from DO; Redis is the durable source-of-truth, DO is the hot read cache.

### H5. /api/place awaits the broadcast call → DO latency is on every write's critical path, AND failures are swallowed silently
File: `src/worker.js:67-76`
```js
try {
  const roomId = c.env.CANVAS_ROOM.idFromName('main');
  const room = c.env.CANVAS_ROOM.get(roomId);
  await room.fetch(new Request('http://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(pixels),
  }));
} catch (err) {
  console.error('Broadcast failed:', err);
}
```
- `await room.fetch(...)` blocks the response to the placing user. DO cold-start (~50-200ms) + network adds latency for the most cost-sensitive path.
- The `try/catch` only catches thrown errors. If the DO returns a 5xx, the response is logged as success and other clients silently miss the update.
- Comment claims "non-blocking" — code is blocking.

Fix:
```js
const broadcast = c.env.CANVAS_ROOM.get(c.env.CANVAS_ROOM.idFromName('main'))
  .fetch(new Request('http://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(pixels),
  }))
  .then(r => { if (!r.ok) console.error('Broadcast non-OK:', r.status); })
  .catch(err => console.error('Broadcast failed:', err));
c.executionCtx.waitUntil(broadcast);
```
This makes broadcast truly non-blocking and ensures Cloudflare keeps the request alive until it finishes.

---

## Medium

### M1. Pixels persisted to Redis but broadcast can fail → cross-client divergence
File: `src/worker.js:64-76`

`setPixels()` succeeds → broadcast fails (DO error, network) → other clients miss the pixel until they reload `/api/canvas`. README says "real-time updates" but there's no retry, no version vector, no out-of-order detection.

Mitigation: clients periodically re-fetch (not implemented), or add a sequence number to `/api/place` responses and let clients detect gaps from the WS stream.

For now, with H5 fixed (waitUntil + non-OK detection), at least the failure is logged. Document this as a known limitation.

### M2. No duplicate-pixel-in-batch detection → user can spam same coordinate 32× to defeat per-pixel write limits
File: `src/worker.js:39-52`

Validation loop checks bounds but doesn't dedupe. A batch of 32 writes to (0,0) with the same color is wasted work and still drains 32 credits. Worse: a batch with conflicting writes to the same pixel — last-write-wins inside BITFIELD chain — silently discards the others. User pays for all 32.

Fix: dedupe by `${x},${y}` key keeping last entry; OR reject batch if duplicates exist (clearer contract). Update README.

### M3. BITFIELD chain has no overflow handling — silently wraps modulo 32 if `color >= 32` slips through
File: `src/lib/canvas-storage.js:60-62`

Validation in worker.js:46 already enforces `color < MAX_COLORS`, so this is defense-in-depth. But: BITFIELD u5 SET with value > 31 wraps to value mod 32. If anyone bypasses worker validation (direct DO RPC in future, internal admin tools), corruption is silent.

Fix: add explicit guard in `setPixels`:
```js
if (color < 0 || color >= 32) throw new RangeError(`color out of range: ${color}`);
```

### M4. Lua script HSET stores `cr` as the result of `accrued - count` which can be a float string — drift over many requests
File: `src/lib/rate-limiter.js:28-29`

`accrued` comes from `math.min(MAX, credits + math.floor(elapsed*regen))`. Currently regen=1 (integer) and credits start integer, so accrued is integer. But subtraction of `tonumber(ARGV[1])` (also integer) keeps it integer. With non-integer regen (see C2), this becomes "1.0" or "0.99999..." string in Redis. tonumber re-parses but precision can drift over thousands of requests.

Fix: `math.floor(remaining)` before HSET, or always use integer math (multiply rate by 1000, divide later).

### M5. No CORS headers; no security headers (CSP, X-Frame-Options, X-Content-Type-Options)
Files: `src/worker.js` (all routes)

If you ever serve the API from a different domain than the frontend, CORS preflight will fail. If the frontend is embedded somewhere else, no clickjack protection. Octet-stream response without `X-Content-Type-Options: nosniff` lets some browsers MIME-sniff.

Fix: add a small middleware to set:
```js
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});
```
For CORS, only add when needed; default same-origin is safer.

### M6. Errors leak internal stack traces via Hono default error handler
Files: `src/worker.js` (no `app.onError` registered)

If `setPixels` throws (Upstash 5xx, network error), Hono returns the error message + stack to the client by default in development; in production it's a generic 500 but the inner `console.error` still logs internals. Better: explicit error envelope.

Fix:
```js
app.onError((err, c) => {
  console.error('Unhandled:', err);
  return c.json({ error: 'internal' }, 500);
});
```

---

## Low

### L1. `getFullCanvas`: `atob(data)` may succeed on non-base64 strings that happen to be valid base64 alphabet, returning garbage
File: `src/lib/canvas-storage.js:27-31`
```js
try { raw = atob(data); } catch { raw = data; }
```
A raw binary string accidentally consisting of base64 chars (a..z, A..Z, 0..9, +, /, =) will decode to wrong bytes silently. Better: detect Upstash's encoding mode explicitly. If you set `Upstash-Encoding: base64` header in client config, you know it's base64. Otherwise assume raw.

The current Upstash JS SDK abstracts this — verify which mode it uses for `getrange` (likely already base64 → the try/catch is paranoid but sometimes returns raw on first call). Either way, document the assumption.

### L2. `getFullCanvas` returns zero-filled buffer when key missing, no logging
File: `src/lib/canvas-storage.js:20-22`

Silent. If the canvas key is wiped (manual ops, Redis eviction), every client gets a blank canvas with no indication. Add `console.warn('Canvas key empty or missing')`.

### M3 already covers BITFIELD overflow.

### L3. Sessions Set in DO is unbounded — no max connections per room
File: `src/durable-objects/canvas-room.js:9`

A single DO has a soft limit of ~32k WebSocket connections per Cloudflare's limits, but nothing in this code prevents pathological client behavior (10k connections from one IP). Combined with non-hibernation (H3), this is a vector to keep the DO pinned with high memory.

Fix: add a max sessions cap (`if (this.sessions.size >= 5000) return new Response('busy', { status: 503 });`) and consider per-IP connection limits using rate-limiter.js.

### L4. JSON body size not capped on /api/place
File: `src/worker.js:23-29`

`c.req.json()` will happily parse a 100MB body before validation runs. With MAX_BATCH_SIZE=32, max legitimate body is ~1KB. Send a 100MB payload → Worker burns CPU parsing → 4xx.

Fix: check `c.req.header('content-length')` and reject > 4096 before parsing.

---

## Nit

### N1. `getRedis` creates a new client per request
File: `src/lib/redis-client.js:8-13`

Cheap (no connection pool — REST), but allocates an object every call. A module-scoped singleton keyed on env URL would save GC. Skip if measured cost is negligible.

### N2. Magic `'main'` room id — no constant
File: `src/worker.js:68, 88`

Two callsites with the literal `'main'`. If you ever support multiple rooms, this needs to be parameterized. Extract to `constants.js`.

### N3. `/broadcast` route in DO has no auth — any code that gets a DO stub can broadcast
File: `src/durable-objects/canvas-room.js:16`

DO stubs are scoped to your Worker, so this is theoretical. But if multiple Workers share the namespace, anyone can send arbitrary `pixels` payloads to clients. A shared secret in Worker→DO requests, or RPC over the new DO RPC API, would harden this.

---

## Looked at and OK

- **BITFIELD bit ordering / endianness**: Verified. Redis docs confirm "bit 0 is the most significant bit of the first byte" (big-endian). Decoder in `canvas-decoder.js:18` reads `(hi<<8 | lo) >> (11 - bitOffset) & 0x1f` which extracts bits in the correct order. Cross-checked at offsets 0, 1, 7 (byte boundary), and 8.
- **Last-pixel offset arithmetic**: Pixel 4194303 → bit 20971515 → byte 2621439 (within CANVAS_BYTES=2621440). All 5 bits live in byte 2621439; decoder reads byte 2621440 as `|| 0` which is harmless.
- **Worker Hono routing / method matching**: Routes are simple, no path traversal vectors, no query param handling.
- **WebSocketPair upgrade response shape**: Status 101 + `webSocket: client` is the documented Cloudflare pattern.
- **Set iteration with delete during forEach**: JS Set delete during for..of is safe — iterator advances correctly.
- **Pixel coordinate bounds checks**: x, y, color all validated for type, range, and integer-ness in worker.js:40-52.
- **Rate-limit Lua atomicity**: EVAL is atomic in Redis; HGETALL→math→HSET runs without interleaving.
- **Credit clamp at MAX_CREDITS**: Lua `math.min(MAX, credits + accrued)` correctly caps regen.
- **TTL on credits hash**: 86400s = 24h. Reasonable; long-idle users get fresh full credits.
- **wrangler.json migration**: v1 with new_classes is correct for first-time DO deploy.
- **Hono dependency version**: 4.7.6 is current.
- **Frontend optimistic update on place**: client decrements credits and renders before server ACK; server response corrects credit count. Acceptable UX pattern.

---

## Recommended fix priority order

1. **C1, C2** — fix retryAfter unit + fractional regen now. One commit.
2. **H4** — bump cache, add gzip, before any traffic spike kills your Upstash quota.
3. **H3** — switch to hibernation API (cost reduction, simple change).
4. **H5** — wrap broadcast in `waitUntil`, check response.ok.
5. **H1, H2** — replace IP hash with HMAC + env salt; fix dev fallback.
6. M1-M6, L1-L4, N1-N3 as time permits.

---

## Unresolved questions

1. Is the canvas ever expected to be cleared/reset? If so, who issues the operation (admin endpoint? cron?) and how is it broadcast?
2. What's the deployment plan — same Cloudflare zone for Worker + frontend (no CORS), or split? This determines whether M5 is needed.
3. Upstash plan: free tier (10K cmd/day) or paid? The cost analysis in H4 changes accordingly.
4. Multi-room future plans — N2 only matters if yes.
5. Is there any analytics / observability integration (logpush, Sentry)? Several findings suggest logging that has nowhere to go right now.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Reviewed 9 backend files. 2 Critical (rate-limit unit bug, fractional regen), 5 High (IP hash collisions, dev fallback, no DO hibernation, canvas endpoint cost, blocking broadcast), 6 Medium, 4 Low, 3 Nit. Core BITFIELD encoding/decoding is correct. Concerns: C1 and C2 ship a latent rate-limit bug that activates the moment anyone tunes regen rate; H4 is a real production-readiness blocker for any traffic above hobbyist scale.
**Concerns/Blockers:** None blocking review; recommend addressing C1/C2/H4 before any public launch.

---

Sources consulted:
- [Redis BITFIELD command](https://redis.io/docs/latest/commands/bitfield/) — bit ordering semantics
- [Upstash REST API](https://upstash.com/docs/redis/features/restapi) — base64 / binary response modes
- [Cloudflare Durable Objects: Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — hibernation vs accept
- [Build a WebSocket server with Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
