# Backend Code Re-Review — rplace

Date: 2026-04-17
Scope: backend re-review after 10 commits since prior review (`code-review-260417-0919-backend.md`)
Reviewer: code-reviewer
Commits reviewed (newest → oldest): `8e1f8c4 fcddb1f 33cfd3d b35769c e3eb34c e0cf802 eef6879 50f4365 c357a3f f97ca4d`

## Summary

Substantial progress: H3 (Hibernation API), the binary canvas read (b35769c), and the Redis key prefix (f97ca4d) are now implemented. **C1, C2, H1, H2, H4, H5, M1–M6 are all UNCHANGED** — the new commits focus on infra correctness (BITFIELD, base64, hibernation, observability) and the new client batch-drawing flow, but did not touch rate-limiter, get-user-id, or the canvas/place HTTP layer. Two **new Critical** issues introduced: (1) silent migration switch from `new_classes` → `new_sqlite_classes` on the same `v1` tag will brick re-deploys against an existing DO namespace; (2) `MAX_BATCH_SIZE` was raised 32 → 512 without a corresponding rate-limit ceiling check, so a single request can request 2× the credit cap and burn server work before the rate-limiter rejects it. One **new High**: `redisRaw` ignores the response body, so an Upstash 200-with-error payload silently passes for every BITFIELD write. Hibernation handler implementation is *almost* right but `webSocketClose` calling `ws.close()` is unnecessary and the `wasClean` parameter is ignored — minor.

---

## Prior Findings Status

| ID | Status | Evidence |
|----|--------|----------|
| C1 (`retryAfter` in credits not seconds) | **Unchanged** | `src/lib/rate-limiter.js:25` still `return {0, accrued, count - accrued}` |
| C2 (`math.floor(elapsed*regen)` truncates fractional) | **Unchanged** | `src/lib/rate-limiter.js:21` identical |
| H1 (32-bit IP hash collisions) | **Unchanged** | `src/lib/get-user-id.js:11-16` identical |
| H2 (silent `127.0.0.1` fallback) | **Unchanged** | `src/lib/get-user-id.js:9` identical |
| H3 (DO uses `accept()` not hibernation) | **Fixed (with minor nits)** | `src/durable-objects/canvas-room.js:31` `state.acceptWebSocket(server)`; broadcast iterates `state.getWebSockets()` (line 17). See N4–N5 below for residual nits |
| H4 (GET /api/canvas: no compression, `s-maxage=1`) | **Unchanged** | `src/worker.js:17` still `s-maxage=1`, no `Content-Encoding` set; per-request hits Upstash via `redisRawBinary` |
| H5 (broadcast awaited, 5xx swallowed) | **Unchanged** | `src/worker.js:74` still `await room.fetch(...)` inside `try/catch`; no `waitUntil`, no `r.ok` check |
| M1 (broadcast/persist divergence) | **Unchanged** | Same code path as H5 |
| M2 (no batch dedup) | **Unchanged** (server) — *fixed in client* | `src/worker.js:39-52` no dedup. Client `pixel-buffer.js:40-48` does dedup, but server cannot trust client |
| M3 (BITFIELD u5 overflow guard) | **Unchanged** | `src/lib/canvas-storage.js:42-51` no explicit `color < 32` guard inside `setPixels` |
| M4 (HSET float drift) | **Unchanged** | `src/lib/rate-limiter.js:28-29` identical |
| M5 (CORS / security headers) | **Unchanged** | No middleware in `src/worker.js` |
| M6 (no `app.onError`) | **Partially mitigated** | `src/worker.js:64-69` adds `try/catch` around `setPixels` returning a JSON envelope; still no global `app.onError`; `c.req.json()` failure handled (line 27); other route exceptions still default-handled |
| L1 (atob garbage-decode risk) | **Fixed by design** | `src/lib/canvas-storage.js:22` now decodes from a *known-base64* response (explicit `Upstash-Encoding: base64` header) — no ambiguity left |
| L2 (silent zero-fill on missing key) | **Unchanged** | `src/lib/canvas-storage.js:18-20` returns zeros, no warn |
| L3 (unbounded sessions Set) | **N/A — Set removed** | Hibernation API: no app-managed Set; CF runtime handles. Per-room hard cap not enforced (see new finding M11) |
| L4 (no body size cap) | **Unchanged** | `src/worker.js:26` `c.req.json()` reads unbounded body |
| N1 (per-request Redis client) | **Unchanged** | `src/lib/redis-client.js:8-13` identical |
| N2 (magic `'main'` room id) | **Unchanged** | `src/worker.js:72, 92` |
| N3 (`/broadcast` route in DO has no auth) | **Unchanged** | `src/durable-objects/canvas-room.js:14` |

---

## New Critical

### NC1. `wrangler.json` migration changed `new_classes` → `new_sqlite_classes` on the SAME `v1` tag (commit c357a3f) — re-deploy against an existing DO namespace will fail or wipe state

File: `D:/tiennm99/rplace/wrangler.json:16-21`
```json
"migrations": [ { "tag": "v1", "new_sqlite_classes": ["CanvasRoom"] } ]
```
- Migration tags are immutable per environment. If `v1` was previously deployed with `new_classes` (which was the case in commit `fc49de1` — verified via `git show fc49de1:wrangler.json`), Cloudflare's deploy system will either (a) reject the re-applied `v1` tag with a different shape, or (b) on first publish under a new account succeed, but in any prod environment that already saw the old `v1`, the deploy will mis-identify the class storage mode.
- If the Worker has *never* been deployed yet, this is fine. If it was deployed once, the correct fix is to add a **`v2` migration** like `{ "tag": "v2", "delete_sqlite_classes": [], "new_sqlite_classes": ["CanvasRoom"] }` and coordinate state migration; usually you cannot convert non-SQLite → SQLite DOs in place.
- The `gitignore` of `.wrangler/` in the same commit suggests local state was wiped to make this work locally, masking the issue.

Action: confirm whether the DO has ever been deployed under a real Cloudflare account. If yes, do not push; consult Cloudflare DO migration docs. If no, change the tag to `v2` (or leave `v1` only if you are confident no deploy ever happened).

### NC2. `MAX_BATCH_SIZE` raised 32 → 512 (`constants.js:11`) but `MAX_CREDITS = 256` — server accepts 512-pixel POST then rejects via rate-limit, after fully validating + reading body

File: `D:/tiennm99/rplace/src/lib/constants.js:11-13`
```js
export const MAX_BATCH_SIZE = 512;
export const CREDIT_REGEN_RATE = 1;
export const MAX_CREDITS = 256;
```
Flow: `worker.js:35` accepts body up to 512 pixels → loop validates all 512 (lines 40-52) → `checkAndDeductCredits(env, userId, 512)` → Lua sees `count=512 > accrued≤256` → returns rate_limit. So **a legitimate user can never spend a 512-pixel batch in one shot**, but a malicious client can flood the server with 512-element JSON arrays that always fail validation/rate-limit. Server burns CPU on validation + a Redis EVAL roundtrip per request. Combined with L4 (no body cap), each rogue request can carry MBs of `{x,y,color}` objects.

Action options (pick one):
1. Cap `MAX_BATCH_SIZE = MAX_CREDITS` (i.e. 256) so the system contract is internally consistent.
2. Validate `pixels.length <= MAX_CREDITS` at the worker before the per-pixel loop and reject earlier with a clear `error: 'exceeds_max_credits'`.
3. Change credit math to allow oversized batches (probably wrong product-wise).

Add a `content-length` cap (L4) regardless.

---

## New High

### NH1. `redisRaw` returns `res.json()` (the whole envelope) — Upstash REST returns `{result, error}`; an `error` field is silently ignored, so a BITFIELD write can fail with HTTP 200 and the worker reports success

File: `D:/tiennm99/rplace/src/lib/redis-client.js:21-35`
```js
if (!res.ok) { ... throw ... }
return res.json();
```
- Upstash REST: a malformed command returns HTTP 200 with `{"error":"ERR ..."}`. The current code only throws on `!res.ok`. `setPixels` doesn't inspect the return value (`canvas-storage.js:50` is `await redisRaw(env, command)`), so a BITFIELD that fails server-side (bad offset syntax, eviction, OOM) returns 200, the worker logs no error, then **broadcasts pixels that were never persisted**. Clients see them flicker, then they vanish on reload.
- Inconsistent with `redisRawBinary` which destructures `result` from the body (line 56), but it also doesn't check `error`.

Fix:
```js
const body = await res.json();
if (body && Object.prototype.hasOwnProperty.call(body, 'error')) {
  throw new Error(`Redis error: ${body.error}`);
}
return body.result;
```
Apply to both `redisRaw` and `redisRawBinary`. Update `setPixels` if it ever needs the result.

### NH2. `getFullCanvas` zero-pads when Upstash returns short data, masking partial reads / corruption

File: `D:/tiennm99/rplace/src/lib/canvas-storage.js:28-33`
```js
if (bytes.length < CANVAS_BYTES) {
  const padded = new Uint8Array(CANVAS_BYTES);
  padded.set(bytes);
  return padded;
}
```
- For a fresh canvas, GETRANGE on a non-existent key returns empty → handled at line 18 (zero-fill). Good.
- For a *truncated* response (Upstash request truncation, mid-deploy state, partial write), this silently zero-pads the tail → users see the canvas blank below some row → no log, no metric. Could mask a real corruption incident for hours.
- Redis GETRANGE on a 2.5MB key has no documented Upstash response size cap on REST, but a network-layer truncation IS possible.

Fix: log a warning when `bytes.length < CANVAS_BYTES` *and* the canvas key is known to exist (separate `EXISTS` check, or remember the key was non-empty). Or just `console.warn` with the byte counts and serve zero-padded — the warn alone makes future incidents debuggable.

### NH3. Per-request `fetch()` to Upstash on `GET /api/canvas` with `s-maxage=1` — same as prior H4, but now I can confirm the fetch is `redisRawBinary` issuing a path-style GET that's NOT cacheable by Cloudflare's reverse cache (auth header forces miss-on-vary)

File: `D:/tiennm99/rplace/src/lib/canvas-storage.js:14-16` + `src/lib/redis-client.js:44-58`
- The internal Upstash `fetch` carries an `Authorization: Bearer ...` header. Cloudflare's outbound cache will not store responses with `Authorization` unless `Cache-Control: public` is set on the upstream (Upstash does not). So every Worker invocation re-pays the Upstash request, even within the 1-second `s-maxage` window — the CDN cache only protects against re-invocations of the *Worker's own response* by re-using the worker's outgoing `Response`.
- This is the same H4 risk, restated with the new code path. Fix priority hasn't changed: gzip the response, raise `s-maxage`, or cache in DO memory.

### NH4. `webSocketClose` calls `ws.close(code, reason)` — for Hibernation, this is unnecessary and may emit a duplicate close frame; also `wasClean` param dropped silently

File: `D:/tiennm99/rplace/src/durable-objects/canvas-room.js:42-44`
```js
webSocketClose(ws, code, reason, wasClean) {
  ws.close(code, reason);
}
```
- Per CF docs: "Calling close() is safe but no longer required" with the auto-close compatibility (compat date `2026-04-07`). Project's `compatibility_date = "2025-04-01"` — **older than that** — so auto-close is OFF. Without auto-close, calling `ws.close()` here is the documented pattern, but calling it on **every** close (including `wasClean=true` client-initiated) is redundant: the client already sent the close frame. The runtime won't crash, but you're sending an extra close frame back that the disconnected peer ignores.
- More importantly: `wasClean` is dropped — if false (abnormal disconnect), there's no metric/log; this would have helped diagnose the hibernation bug that motivated `eef6879`.
- `webSocketError` similarly closes with code 1011 unconditionally (no log of what `error` was) — debugging future broadcast failures will be hard.

Fix: at minimum, log `code/reason/wasClean` and `error.message` (with rate-limiting if noisy); consider bumping `compatibility_date` to `>= 2026-04-07` and removing the `ws.close()` calls.

---

## New Medium

### M7. `getRedis()` is called inside `checkAndDeductCredits` but the SDK is unused for canvas writes — two clients, two error envelopes

Files: `src/lib/rate-limiter.js:42` (uses `@upstash/redis` SDK `eval()`), `src/lib/canvas-storage.js` (uses raw fetch).
- Rate-limit failure errors are SDK-shaped; canvas write errors are raw-fetch-shaped. Logging downstream has to handle both. Not urgent, but worth a note.

### M8. `redisRawBinary` URI-encodes args via `encodeURIComponent` but the BITFIELD/GETRANGE *path* mode does NOT support binary args anyway — fine for keys/numbers, undefined for arbitrary bytes

File: `src/lib/redis-client.js:44-58`
- Current usage is GETRANGE with key + integer offsets, all ASCII. Safe today.
- If anyone later calls `redisRawBinary(env, ['SET', key, binaryValue])`, `String(binaryValue)` will produce mojibake. Document or assert ASCII args only.

### M9. `pixel-buffer.js:44` uses `y*65536+x` as a Map key — fine for 2048×2048, but a hard-coded magic number with no constant link

File: `src/lib/pixel-buffer.js:44, 64, 74`
- Three callsites all do `y*65536+x`. Should be a single helper or use `${x},${y}` string. Magic 65536 will silently collide if `CANVAS_WIDTH` ever exceeds 65535 (won't soon, but the constant is in `constants.js` and ought to be referenced).

### M10. `pixel-buffer.js` `pixelCount` getter rebuilds a `Set` on every read — O(strokes × pixels-per-stroke) per access

File: `src/lib/pixel-buffer.js:71-77`
- Likely called from a Svelte reactive expression on every render (toolbar `pixelCount` display). For a user with 10 strokes × 50 pixels each, every keystroke / interaction iterates 500 entries to compute one number. Cache it (`addStroke/undo/redo/clear` mutate, recompute lazily).

### M11. No per-room or per-IP WebSocket connection cap

File: `src/durable-objects/canvas-room.js`
- Hibernation removed the explicit `Set`, but Cloudflare's per-DO 32k WS limit is still the only ceiling. One client can open hundreds of WS connections (cheap on the client) → 100% of room broadcast bandwidth goes to one peer.
- Combine with H1 (IP hash collisions) and abuse becomes hard to identify per-IP.
- Fix: cap connections in `fetch` upgrade path, e.g. `if (state.getWebSockets().length >= 5000) return new Response('busy', { status: 503 })`.

### M12. Broadcast loop swallows `ws.send` errors then forces close — but `getWebSockets()` includes hibernated sockets, and closing one is an active-write that may wake the entire DO

File: `src/durable-objects/canvas-room.js:17-23`
- For 5000 hibernated sockets, sending in a tight `for` loop wakes the DO, allocates 5000 messages, and any failed send forces a `ws.close()` which itself triggers `webSocketClose` → recursive accounting. Mostly fine, but at scale you want either (a) `await Promise.allSettled(...)` to parallelize and not block on one slow socket, or (b) detect mass-failure and back off.

---

## New Low

### L5. `canvas-room.js` constructor signature dropped `env` parameter

File: `src/durable-objects/canvas-room.js:6`
```js
constructor(state) {
```
- Cloudflare DO constructor is `constructor(state, env)`. Dropping `env` means future code that needs env (e.g. for logging, secrets, BROADCAST_AUTH) has to refactor. Costless to keep `constructor(state, env) { this.state = state; this.env = env; }`.

### L6. `pixel-buffer.js` getters duplicate logic between `getAllPixels` and `getAffectedKeys`

File: `src/lib/pixel-buffer.js:40-67`
- Same nested loop, only the value differs. Extract a private `forEachPixel(cb)` helper.

### L7. Tests directory now exists (`test/**`) but no CI configuration was inspected — verify GitHub Actions / pre-push runs them

Out-of-scope file: not in commit list, but worth a check.

---

## New Nit

### N4. Hibernation API reference: `compatibility_date` is `2025-04-01` — predates `2026-04-07` auto-close compat flag; consider bumping
File: `wrangler.json:4`. Once you bump, the `ws.close()` calls in NH4 become outright redundant.

### N5. `webSocketError` log loses `error` content; `webSocketMessage` no-op should at least drop the connection (defensive)
File: `src/durable-objects/canvas-room.js:37-49`. Clients aren't supposed to send messages — if one does (misbehaving client / abuse), silently ignoring it is acceptable, but a `ws.close(1003, 'unexpected message')` would be safer (1003 = "received data of a type that cannot be accepted").

### N6. `console.error` everywhere, no structured logging
With `observability.logs.invocation_logs = true` enabled (commit `50f4365`), structured `console.log({event:'...', ...})` would be queryable in CF Logpush — currently logs are free-form strings.

---

## Looked at and OK (new code)

- **`pixel-buffer.js`** — pure client-side abstraction, *not imported by worker or DO*; `Grep` confirms only `src/client/components/CanvasRenderer.svelte` consumes it. No conflict with `canvas-storage.js`. Undo/redo logic is correct (push to `undone` on `undo`, clear `undone` on new `addStroke`). Stroke-level granularity is reasonable for a paint-mode UX.
- **`canvas-room.js` Hibernation switch (eef6879)** — `state.acceptWebSocket(server)` is called correctly; `state.getWebSockets()` is queried inside `/broadcast` (not stale at wake-up); `webSocketMessage`/`webSocketClose`/`webSocketError` all defined (required by hibernation runtime). Sessions Set removed, no stale state. Broadcast still works after hibernate-and-wake because `getWebSockets()` returns connections persisted by the runtime.
- **`canvas-storage.js` base64 decode (b35769c)** — explicit `Upstash-Encoding: base64` header guarantees the response IS base64; `atob` is now safe (was previously paranoid). The `Uint8Array(raw.length)` + per-char `charCodeAt` is the standard binary-string-to-bytes pattern, correct for octets 0–255.
- **`redis-client.js` raw command shape** — `POST` to base URL with a JSON-array body is the documented Upstash REST raw-command shape (verified via Upstash docs). `Bearer` auth header correct.
- **`redisRawBinary` path encoding** — `encodeURIComponent` per arg + `/` join + base64-encoding header is documented Upstash pattern for binary-safe responses.
- **Redis key prefix (f97ca4d)** — `REDIS_KEY_PREFIX = 'rplace:'` applied at both call sites: `REDIS_CANVAS_KEY` (`constants.js:17`) and `${REDIS_KEY_PREFIX}credits:${userId}` (`rate-limiter.js:44`). Consistent. Lua script in rate-limiter uses `KEYS[1]` so prefix is in the key passed in — clean.
- **`wrangler.json` observability** — `invocation_logs:true` + `traces.enabled:true` is the documented shape for the new observability config (no schema concerns).
- **Tests added (`test/**`)** — coverage for `canvas-storage`, `pixel-buffer`, `get-user-id`, `redis-client`, integration roundtrip, DO. Good signal even if not reviewed in detail this pass.

---

## Recommended fix priority order

1. **NC1** — investigate whether the `v1` migration was ever deployed; if yes, add `v2` before next deploy. (May be a deploy-blocker.)
2. **NH1** — check `error` field in `redisRaw` / `redisRawBinary`. Silent BITFIELD failure is the worst kind of bug.
3. **C1, C2** — still latent rate-limit bugs from prior review, must fix before any tuning of regen rate.
4. **NC2** — reconcile `MAX_BATCH_SIZE` vs `MAX_CREDITS`; add early reject + content-length cap.
5. **H4 (= NH3)** — canvas read cost; bump `s-maxage`, gzip, or move to DO-cached.
6. **H5** — `waitUntil` + `r.ok` check on broadcast.
7. **H1, H2** — IP hash + dev fallback.
8. **NH2** — log truncation case in `getFullCanvas`.
9. **NH4 / N4 / N5** — hibernation polish: bump compat date, log close codes, defensive close on unexpected client message.
10. **M7–M12, L5–L7, N6** as time permits.

---

## Unresolved questions

1. **NC1 critical:** has this Worker (with `CanvasRoom` DO) ever been deployed to a real Cloudflare account, or is `wrangler dev` the only user so far? Determines whether the `v1`→`new_sqlite_classes` switch is a brick-on-deploy or a no-op.
2. The constants change `MAX_BATCH_SIZE = 512` (commit `e0cf802`, batch drawing feature) — was the rate-limit ceiling intentionally left at 256 for cost control, or is `MAX_CREDITS` supposed to be raised to match? Product decision needed.
3. Is the canvas ever expected to be cleared/reset? Still unanswered from prior review.
4. Are tests run in CI? `test/` directory exists; haven't verified GH Actions config.
5. Is there a planned bump of `compatibility_date` (currently `2025-04-01`) to enable WS auto-close (≥ `2026-04-07`)? Affects NH4 cleanup.
6. Long-term: any plan to move canvas reads from Upstash to DO memory (NH3 mitigation, also unlocks per-DO multi-room sharding)?

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Re-reviewed 6 files (2 new, 4 modified) + verified 21 prior findings. **3 prior items fixed (H3, L1, L3), 14 unchanged, 1 partial (M6).** **2 new Critical (NC1 wrangler migration, NC2 batch/credit mismatch), 4 new High (NH1 silent Redis errors, NH2 silent canvas truncation, NH3 = restated H4, NH4 hibernation polish), 6 new Medium, 3 new Low, 3 new Nit.**
**Concerns/Blockers:** NC1 may block next production deploy. NH1 (silent BITFIELD failures) is the highest-impact production bug — failed writes are reported as success, broadcast pixels that don't exist on reload. C1/C2/H4/H5 from prior review remain. Strongly recommend a follow-up commit addressing NC1, NH1, plus C1+C2 before any traffic.
