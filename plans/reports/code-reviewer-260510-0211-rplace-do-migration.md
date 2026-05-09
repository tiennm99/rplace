# Code Review — rplace DO migration (Phases 1–4)

**Date:** 2026-05-10
**Scope:** Last 4 commits (c3f7c02 → a977adc) — Upstash → DO SQLite migration + cleanup
**Reviewer:** code-reviewer

## Summary

Migration is functionally correct on the happy path. SQLite-backed canvas + cooldown design is sound and well-commented. Primary issues are (1) **stale documentation referencing deleted code** (real risk: misleads contributors / ops on rollback), (2) a **client-side race** where WebSocket pixel broadcasts received during the initial canvas fetch are silently dropped, (3) a **resize-grow correctness bug** in `writePixels` for canvases whose previous last-chunk was short, and (4) several **minor security / DOS gaps** at the edge.

LOC reviewed: ~700 (server) + ~1200 (client). Tests: 8 files, all green per commit notes (94/94).

---

## Critical

### C1. Stale documentation references deleted code paths
**Files:**
- `README.md:84-97` — describes `src/admin/migrate-from-upstash.js`, `src/lib/canvas-storage.js`, `src/lib/redis-client.js`, `src/lib/rate-limiter.js` as if they exist (all deleted in a977adc)
- `README.md:146-151` — documents `POST /admin/migrate-from-upstash` endpoint as "transitional" but the worker no longer mounts it (returns 404 in production per commit message)
- `docs/system-architecture.md:117-124` — same migration endpoint documented as live
- `docs/deployment-guide.md:34-65,107-111` — full "Optional One-Shot Migration from Upstash" section + troubleshooting entries reference the deleted endpoint and secrets
- `docs/code-standards.md:29-32` — "Functions receive env parameter for Cloudflare bindings (Redis credentials...)", "Use `@upstash/redis/cloudflare`", "Bitfield operations use builder pattern"

**Impact:** A dev reading these docs will try to call a 404 endpoint, set secrets that don't exist, or write code against `@upstash/redis` which is no longer in `package.json`. Ops doing rollback per `docs/deployment-guide.md` will be confused.

**Severity:** Critical (docs claim functionality that's been removed; this is exactly what a "migration cleanup" PR should not leave behind).

**Fix:** Strike the entire migration / Upstash sections. Replace `code-standards.md:27-32` with the DO-binding pattern actually in use. Verify `docs/references.md` Redis links remain only as historical references.

### C2. WebSocket updates dropped during initial canvas fetch
**File:** `src/client/components/CanvasRenderer.svelte:465-484`

The renderer pre-allocates a zero `committedColors` so WS messages arriving before `loadCanvas` resolves don't null-deref (line 16, comment at 14-16). But once the fetch completes, line 473 unconditionally **replaces** the array:

```js
committedColors = new Uint8Array(indices); // replace pre-allocated zero array
```

Any pixel writes that landed in the pre-allocated array between WS connect and fetch resolve are silently overwritten. Same hazard for `imageData` (line 475).

**Repro:** User A opens app. WS connects fast, fetch is slow (16 MB binary). User B places a pixel. User A's WS receives it → writes to `committedColors[idx]`. Fetch resolves → `committedColors = new Uint8Array(indices)` (which was sampled at server BEFORE B's pixel hit, since the GET hits a 10s edge cache). User B's pixel is invisible to A until the next WS update or refresh.

**Severity:** Critical — this is the exact data-loss scenario the architecture comment at `App.svelte:122-126` ("Refetch canvas after a reconnect") tries to prevent, but only triggers on `isReconnect`, not initial connect.

**Fix options:**
1. Buffer WS messages until fetch resolves, replay on completion.
2. After replacing `committedColors`, re-apply the pre-fetch WS edits (track them in a side map).
3. Open WS only after fetch completes (loses real-time updates during load — likely worst option).

### C3. `writePixels` silently drops writes on resize-grow path
**File:** `src/durable-objects/lib/chunk-storage.js:88-101`

When the canvas is grown (CANVAS_WIDTH or CANVAS_HEIGHT bumped), the old last-chunk row's BLOB is stored at the old `chunkSize(lastChunkId)` size, which is shorter than the new `CHUNK_BYTES`. The grow-path read returns that short blob; `new Uint8Array(buf)` (line 92) preserves the short length; `next[byteOffset] = color` (line 94) is a **no-op when byteOffset ≥ next.length** (typed-array OOB writes are silently dropped per spec). The short blob is then INSERT-OR-REPLACE'd unchanged.

**Effect:** New pixels written into the formerly-last chunk after a resize-grow disappear.

This isn't theoretical — `docs/canvas-resize-procedure.md` explicitly recommends growing the canvas as a config-only change. With a 4096×4096 canvas all chunks are full 64KB so the bug is dormant *today*. Bump width to 4097 and the bug activates immediately.

**Severity:** Critical (data loss after a documented operation).

**Fix:** In `writePixels`, allocate `next` to `chunkSize(chunkId)` and copy `buf` into it:
```js
const expected = chunkSize(chunkId); // current expected size for this chunk
const next = new Uint8Array(expected);
next.set(buf.subarray(0, Math.min(buf.length, expected)));
```
Or always allocate `CHUNK_BYTES` for non-last chunks and `chunkSize(lastId)` for the last; never trust the persisted blob's length.

---

## High

### H1. Cooldown is consumed even on storage failure
**File:** `src/durable-objects/canvas-room.js:73-86`

`tryAcquire` runs first (line 73). If `writePixels` then throws (lines 78-83), the user gets a 500 but their cooldown row is already updated. They're locked out for 1s without their pixel placement having succeeded.

**Severity:** High — bad UX on transient errors; effectively turns a storage flake into a 1s soft-DOS of the user.

**Fix:** Rollback the cooldown UPDATE in the catch:
```js
sql.exec('DELETE FROM cooldowns WHERE user_id = ?', userId);
```
Or run write first, then cooldown — but that opens a different race (concurrent placements within DO would all succeed before any cooldown row exists). Safer is the rollback.

### H2. Server response leaks raw error to client
**File:** `src/durable-objects/canvas-room.js:82`

```js
return Response.json({ error: 'storage_failed', message: String(err) }, { status: 500 });
```

`String(err)` may include SQLite error messages, paths, query fragments. Low risk because the DO's SQL is internal but it still violates the "don't leak internals" rule and sets a precedent.

**Severity:** High (security best-practice: never echo `err.toString()` over the wire from a 5xx).

**Fix:** Drop `message` from the response; keep only `error: 'storage_failed'`. Log the full error (already done at line 81).

### H3. Chunk-storage `readAllChunks` crashes on orphaned shrink rows
**File:** `src/durable-objects/lib/chunk-storage.js:46-56`

`SELECT chunk_id, bytes FROM canvas_chunks` returns ALL rows including any with `chunk_id ≥ CHUNK_COUNT` (orphans left after a resize-shrink — explicitly documented as possible in `docs/canvas-resize-procedure.md:32-37`). Then `out.set(view, chunkId * CHUNK_BYTES)` will throw RangeError if `chunkId * CHUNK_BYTES + view.length > out.length`. Since `out` is `TOTAL_PIXELS` long and an orphan has a higher chunk_id, this will throw.

**Severity:** High — `GET /api/canvas` would 500 forever after a shrink, until manual cleanup.

**Fix:** `WHERE chunk_id < ?` bound, or `if (chunkId >= CHUNK_COUNT) continue;` defensive skip. The resize doc's "to reclaim, run DELETE" advice should not be a precondition for the read path.

### H4. WebSocket connections are uncapped per-IP
**File:** `src/durable-objects/canvas-room.js:89-94`

`#handleWsUpgrade` accepts every incoming WS upgrade unconditionally. A single client can open thousands of WSs — CF DO has a soft tens-of-thousands limit per object, but no per-source cap. Each connected WS receives every broadcast (`#broadcastPixels` iterates `getWebSockets()`), so 10K connections × N pixels-per-broadcast = 10K × N message sends.

**Severity:** High at hobby scale (one bad actor can saturate CPU on the singleton DO).

**Fix:** Track WS-per-userId via `state.acceptWebSocket(server, [userId])` tags, and deny upgrade past N existing tagged sockets (`getWebSockets(userId)`). Even a 10-per-IP cap eliminates the trivial DOS.

### H5. `content-length` body cap is bypassable
**File:** `src/worker.js:24-27`

`parseInt(c.req.header('content-length') || '0', 10)` defaults to 0 when missing. A malicious client can send chunked-transfer-encoded body without `content-length` and bypass the 128KB pre-parse cap. The CF runtime caps overall request size to 100 MB; until then, the JSON parser allocates as it reads. Practical exposure is "force the worker to allocate up to 100 MB before failing the per-pixel `batch_too_large` check."

**Severity:** High (DOS amplification, easy to fix).

**Fix:** Read raw body via `c.req.arrayBuffer()` with a hard byte cap, then `JSON.parse(decoder.decode(buf))`. Or stream-validate while reading. Or short-circuit if `content-length === 0` (no header → reject).

---

## Medium

### M1. `retryAfter` is always 1s, never the actual remaining window
**File:** `src/durable-objects/lib/cooldown-store.js:55`

On rate-limit denial, the function returns `retryAfter: REQUEST_COOLDOWN_SEC` (always 1s), but the user may have, e.g., 200ms left. Client (`App.svelte:220-222` and `image-uploader.js:104`) waits a full second when ~200ms would suffice.

**Severity:** Medium (UX, not correctness).

**Fix:** When the INSERT throws, run `SELECT expires_at FROM cooldowns WHERE user_id = ?` and return `Math.ceil((expires - now)/1000)`. Optional micro-opt: structure as `INSERT … ON CONFLICT … RETURNING` to avoid the round-trip.

### M2. Comment about WebSocket compat date is misleading / inverted
**File:** `src/durable-objects/canvas-room.js:119`

```js
// Required pre-2026-04-07 compat date; harmless after.
ws.close(code, reason);
```

The wrangler `compatibility_date` is `2025-04-01` (almost a year before the comment's "pre-2026-04-07" cutoff), so the explicit close IS needed. The comment reads as "you can delete this any day now" but actually says the opposite. Worth fixing before someone deletes the line.

**Severity:** Medium (foot-gun for future maintenance).

**Fix:** "Required because compatibility_date (2025-04-01) is before the 2026-04-07 default-close cutoff. Remove if/when wrangler.json bumps past that date."

### M3. WebSocket protocol is broadcast-only but doesn't ping/keepalive
**File:** `src/durable-objects/canvas-room.js:110-113`

`webSocketMessage` immediately closes any inbound message. That means clients can't ping the server to detect zombies. Browser will only know the connection is dead when the OS / proxy times it out (could be minutes). On the wire there's no heartbeat — `App.svelte:131-135` reconnects on `onclose`, but that won't fire if the network silently drops.

**Severity:** Medium (real-time UX during flaky networks).

**Fix:** Either accept `'ping'`/`'pong'` text messages (add small whitelist), or rely on Hibernation API auto-ping (verify CF behavior; docs are sparse). Lowest-cost option: client sends `WebSocket` protocol-level pings via a heartbeat timer; server must permit them.

### M4. Dev-bucket userId = `anon:dev` collapses all dev traffic into one rate-limit bucket
**File:** `src/lib/get-user-id.js:10-14`

In dev (no `cf-connecting-ip`), every request is bucketed as `anon:dev`. If this fallback ever triggers in prod (proxy misconfig, custom domain misrouted), all users share a single 1 req/s budget — soft-DOS for everyone.

**Severity:** Medium (production blast radius is total but trigger is unlikely).

**Fix:** In production (e.g., `env.ENVIRONMENT === 'production'`), throw or 500 instead of falling back. Or use `request.cf?.colo` as a salt, or fall back to `x-real-ip` / `x-forwarded-for`. Document the assumption clearly.

### M5. `Math.random()`-based GC sample assumes per-call randomness in CF Workers
**File:** `src/durable-objects/lib/cooldown-store.js:36,50`

`Math.random()` in CF Workers historically had unusual semantics around isolate reuse. If it returns the same value across all `tryAcquire` calls in an isolate, GC either fires every time or never. Modern CF runtime is supposed to handle this, but worth verifying with a quick log.

**Severity:** Medium (correctness depends on platform behavior, not visible from the code).

**Fix:** If unsure, swap to `crypto.getRandomValues(new Uint8Array(1))[0] < 256 * GC_SAMPLE_RATE` for guaranteed entropy. Or trigger GC every Nth call via a counter on the DO instance.

---

## Low

### L1. `new Uint8Array(buf)` copy in `writePixels` is slower than `.slice()`
**File:** `src/durable-objects/lib/chunk-storage.js:92`

The iterable-constructor copy walks element-by-element. `buf.slice()` uses memcpy. For 64KB and 1 req/sec, irrelevant — but the comment at 90-91 implies a copy is required for safety, and `.slice()` reads cleaner.

**Severity:** Low.

### L2. Cooldown `retryAfter` not surfaced in seconds with sub-second precision
**File:** `src/durable-objects/lib/cooldown-store.js:55`

If we ever want sub-second cooldowns, the `retryAfter` integer second contract caps us. Worth typing `retryAfterMs` for forward compat.

### L3. `writePixels` per-pixel branch could be vectorized for big batches
**File:** `src/durable-objects/lib/chunk-storage.js:88-101`

For a 2048-pixel batch all in one chunk, the inner write loop runs in JS one byte at a time. CF DO SQLite charges per-row, so cost is dominated by the BLOB write — but if batches grow (e.g., admin imports), the pure-JS loop becomes the bottleneck. Not relevant today.

### L4. `setOverlay`'s Texture.from is called twice on race
**File:** `src/client/components/CanvasRenderer.svelte:233-240,521-528`

If `setOverlay` is called before `initPixi` finishes, `overlayState` holds the data. After init, lines 521-528 materialize the sprite. But if a second `setOverlay` arrives mid-init, the first `overlayState` is overwritten silently (no second materialize-from-overlayState pass), so only the latest survives — actually correct behavior, just non-obvious. Worth a one-line comment.

### L5. Server-side `MAX_BATCH_SIZE` import in `canvas-room.js` is redundant
**File:** `src/durable-objects/canvas-room.js:58-60`

The DO re-validates bounds even though the worker did. Defense-in-depth is the stated rationale, fine. But the worker validates `pixels.length > MAX_BATCH_SIZE` *and* the DO does. If they ever diverge (different `MAX_BATCH_SIZE`), edge would reject what DO accepts. Single source of truth via shared constant — already true here; just a note.

### L6. WebSocket message JSON is rebuilt per broadcast; payload not reused
**File:** `src/durable-objects/canvas-room.js:97`

`JSON.stringify` once per broadcast (line 97) — already correct. Disregard. (Including this as a non-finding to confirm I checked.)

---

## Nit

### N1. `idx_cooldowns_expires` only used by the GC sweep
**File:** `src/durable-objects/lib/schema.js:30-32`

The index is consulted by `gc()` only — `tryAcquire` queries by primary key. Comment at 22-23 says "the index keeps the GC sweep cheap" — accurate but redundant given the index name. Fine as-is.

### N2. Worker comment about MAX_BODY_BYTES math
**File:** `src/worker.js:9-10`

`MAX_BATCH_SIZE * 64` overestimates by ~10× (real `{"x":2047,"y":2047,"color":31}` is 27 bytes plus 2 for `,` and brackets ≈ 30B). The 64B headroom is fine but noting that the actual cap on parsed JSON could be tighter if it ever matters.

### N3. `loadCanvas` overwrites `loadError` to null on retry — but doesn't clear the `loading` text in the error state
**File:** `src/client/components/CanvasRenderer.svelte:466-467,573-577`

When the user clicks Retry, both `loading` and the error banner are visible until the fetch completes. Visual nit.

### N4. `handleWsUpgrade` doesn't validate auth or origin
**File:** `src/durable-objects/canvas-room.js:89-94`

For a public collaborative canvas, no auth is needed. But the DO accepts upgrades from any origin. CF's WAF would handle malicious traffic before it gets here. Fine for the scope; document if any future feature gates per-user state.

---

## Edge Cases Found by Scout

| Path | Edge case | Found in |
|---|---|---|
| Initial render | WS message arrives between fetch start and replace | C2 |
| Resize-grow | Last chunk shorter than CHUNK_BYTES, new write past short length silently dropped | C3 |
| Resize-shrink | Orphan rows past CHUNK_COUNT crash readAllChunks with RangeError | H3 |
| Storage flake | Cooldown consumed but write failed → user soft-DOS'd 1s | H1 |
| 500 error path | Raw error string echoed to client | H2 |
| WebSocket flood | No per-IP / per-userId cap on concurrent sockets | H4 |
| Chunked POST | content-length = 0 bypasses pre-parse cap | H5 |
| Dev-misroute to prod | All anon:dev share 1/s globally | M4 |
| Network silent-drop | No client/server WS heartbeat | M3 |
| Math.random in workers | GC may fire every call or never depending on runtime | M5 |
| 429 retryAfter | Always 1s, never sub-second remaining | M1 |

---

## Positive Observations

- Atomic-by-virtue-of-DO model is the right call for a hobby-scale rplace clone. The "no await between cooldown + write + broadcast" comment at `chunk-storage.js:85-87` is excellent — exactly the kind of invariant that breaks when someone drops in `await` later.
- `tryAcquire`'s UPDATE-then-INSERT race-safe rate-limit is genuinely clever and well-explained at lines 14-19 of `cooldown-store.js`.
- Lazy chunk allocation (zero-fill on read) makes resize-grow trivially correct **on the read side**. Only the write side has the bug (C3).
- Schema is `IF NOT EXISTS`, idempotent — survives DO eviction cleanly.
- Edge validation at the worker is thorough and re-validated at the DO; a `Number.isInteger` check correctly rejects strings (test `worker-validation.test.js:115-119`).
- The WebSocket hibernation pattern is correct (`state.acceptWebSocket`, `webSocketMessage/Close/Error` handlers all present).
- `package-lock.json` cleanly removed 184 packages with the Upstash / testcontainers cleanup — no orphan deps observed in `package.json`.

---

## Recommended Actions

1. **Critical (must fix before next deploy):**
   - C1 — purge migration / Redis references from README, system-architecture, deployment-guide, code-standards.
   - C2 — buffer WS pixel messages until initial canvas fetch resolves; merge instead of replace.
   - C3 — `writePixels` must size `next` against `chunkSize(chunkId)`, not against the persisted blob's length.

2. **High (should fix this week):**
   - H1 — rollback cooldown row on `writePixels` failure.
   - H2 — strip raw error from 500 response.
   - H3 — bound `readAllChunks` by `chunk_id < CHUNK_COUNT` (or skip orphans).
   - H4 — per-userId WS connection cap.
   - H5 — replace content-length cap with bounded body read.

3. **Medium (next-sprint backlog):**
   - M1 — return precise `retryAfterMs` from cooldown denial.
   - M2 — fix the misleading WS-close comment.
   - M3 — add WS heartbeat (server permits ping or auto-pings).
   - M4 — production fail-closed when `cf-connecting-ip` missing.
   - M5 — verify `Math.random()` semantics in CF Workers; switch to `crypto` if unclear.

4. **Low / Nit:** L1–L6, N1–N4 at code-review-cycle pace, no urgency.

---

## Metrics

- Files reviewed: 12 server + 4 client (skim) + 4 docs
- LOC reviewed: ~1900
- Issues found: 3 Critical, 5 High, 5 Medium, 6 Low, 4 Nit (total 23)
- Type coverage: N/A (JS, JSDoc-typed)
- Test coverage: 94/94 unit tests pass per commit message; not independently re-run
- Linting issues: not run (no lint script in package.json)

---

## Unresolved Questions

1. **Math.random() in CF Workers** — does it return per-call entropy or per-isolate-fixed values? (Affects M5 GC behavior.) Worth a one-line `wrangler tail` log to confirm.
2. **Hibernation API auto-ping** — does `state.acceptWebSocket` arrange a TCP-level keepalive, or do clients need to explicitly heartbeat? CF docs are unclear; would unblock M3.
3. **Production smoke-test for resize-grow** — is there an environment where we can verify C3 with a non-aligned `CANVAS_WIDTH` (e.g., 4097)? Otherwise the fix is correct-by-construction but unproven.
4. **CF `cf-cache-status: HIT` ratio in production** — README and deployment-guide claim 10s edge-cache will absorb most `/api/canvas` traffic, but no telemetry is wired up. Worth a single-line log + dashboard panel before traffic ramps.
5. **Single-DO singleton failure mode** — when `idFromName('main')` colocates a single DO, what is the user-visible behavior during CF colo failover? (Probably brief 5xx then recover.) Worth documenting in `docs/system-architecture.md`'s "Operational Notes" section.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Migration is structurally sound; 3 Critical and 5 High issues identified, primarily around stale docs (C1), client-side WS race (C2), resize-grow data-loss bug (C3), error-path hygiene (H1/H2/H3), and edge DOS surface (H4/H5). All have clear, scoped fixes.
**Concerns/Blockers:** C1 (stale docs) is the most embarrassing — fix before any new contributor onboards. C2 and C3 are real correctness bugs that the existing test suite will not catch.
