# rplace edge-case audit (post-DO-migration)

Static adversarial review. Scope: cooldown + chunk storage + WS hub + edge cache + image-importer DoS + SQLite limits.

Constants used (from `src/lib/constants.js`):
- `CANVAS_WIDTH = CANVAS_HEIGHT = 4096`, `TOTAL_PIXELS = 16_777_216`
- `MAX_COLORS = 256`, `MAX_BATCH_SIZE = 2048`, `REQUEST_COOLDOWN_SEC = 1`
- `CHUNK_BYTES = 65536`, `CHUNK_COUNT = 256`

---

## Punch list (severity-ordered)

### CRITICAL

#### C1. Cooldown consumed even on storage failure → user locked out 1s with no write
- **Scenario:** `tryAcquire` succeeds, then `writePixels` throws (SQLite I/O error, BLOB-too-large, OOM, transient).
- **Trigger:** any unhandled SQL error inside `writePixels` (e.g. row > BLOB cap, see L1).
- **Observable:** client gets `500 storage_failed`, but the cooldown row was already inserted/updated. User must wait 1s before retrying. UX is mildly annoying for humans, fatal for the long-running image-uploader: each failed batch costs both the batch *and* the cooldown slot.
- **Evidence:** `src/durable-objects/canvas-room.js:73` (`tryAcquire` first), `:79` (`writePixels` after) — no compensating "release" path on failure.
- **Severity:** Critical for image upload (silently halves throughput on transient errors); High otherwise.

#### C2. WS broadcast happens before any commit barrier → other clients see pixels server may roll back
- **Scenario:** `writePixels` does N synchronous `INSERT OR REPLACE` calls in a single JS turn. Without an explicit transaction wrapper, each `sql.exec(...)` is its own auto-commit. If chunk K succeeds and chunk K+1 fails (disk pressure, BLOB limit), the partial state is already persisted *and* the broadcast (line 85) has not yet run — but the user sees `500` and may resubmit.
- **Trigger:** any error path on the second (or later) chunk write inside `writePixels`.
- **Observable:** canvas left in half-written state; subsequent `GET /api/canvas` returns it; broadcast never fires so connected WS clients don't see it until they refetch (cache 10s).
- **Evidence:** `src/durable-objects/lib/chunk-storage.js:88-102` — loop has no `transactionSync` despite the comment at L86-87 claiming atomicity by virtue of "no `await`". *No `await` ≠ atomic*; auto-commit per statement still applies.
- **Severity:** Critical. Atomicity claim in the comment is misleading and false in the failure case.

#### C3. NAT / CGNAT collision = group-rate-limit by IP
- **Scenario:** `getUserId` hashes only `cf-connecting-ip`. Mobile carriers, university networks, corporate proxies, and CGNAT all share single egress IPs across thousands of users.
- **Trigger:** any deployment with shared-IP users.
- **Observable:** all users behind the same IP share *one* 1 Hz bucket. First placer "wins" each second; everyone else gets `429`. Effectively unusable on mobile during peak.
- **Evidence:** `src/lib/get-user-id.js:9-23`. No cookie/session/fingerprint augmentation; no per-room or per-IP-group differentiation.
- **Severity:** Critical for product usability (not a security flaw, but a denial-of-service against legitimate users).

---

### HIGH

#### H1. Image-importer DoS / griefing — no per-IP daily quota
- **Scenario:** Per-IP rate limit is 1 batch (= 2048 pixels) / sec ≈ 7.37 M pixels/hour. One IP can repaint 44% of the entire canvas every hour, indefinitely. The image-importer (`src/lib/image-uploader.js:60-122`) is built to do exactly this.
- **Trigger:** anyone running the importer or a custom script with a multi-megapixel image. Multiple users behind the same NAT amplify it (see C3 inverted: NAT *costs* legit users; from the operator side a single bad actor with multiple clients still funnels through the same bucket).
- **Observable:** entire canvas can be overwritten every ~2 hrs by a single attacker. No global cap, no per-day cap, no throttle on "draw image" sessions.
- **Evidence:** no daily/hourly cap anywhere in `src/durable-objects/lib/cooldown-store.js` or `canvas-room.js`. `MAX_BATCH_SIZE = 2048` (constants L12) makes throughput 2048× a naive 1 Hz limit.
- **Severity:** High. Obvious griefing primitive.

#### H2. `cf-connecting-ip` missing → entire dev/preview traffic shares "anon:dev" bucket
- **Scenario:** Wrangler local dev (`wrangler dev`), preview URLs, custom Workers-for-Platforms tunnels, or any non-CF-fronted invocation drops `cf-connecting-ip`.
- **Trigger:** local dev, preview URLs, tests using real DOs.
- **Observable:** all dev traffic shares one cooldown bucket. Manifests as random `429`s when more than one tab is open during dev. Easy to mistake for a real bug.
- **Evidence:** `src/lib/get-user-id.js:11-14`.
- **Severity:** High for DX; not a production bug per se but trips reviewers.

#### H3. WS hibernation: hub state across rehydrate is fine, but no catch-up message protocol
- **Scenario:** Server hibernates DO, drops in-RAM state. Client stays connected (CF keeps the socket). On the next placement, `state.getWebSockets()` returns the rehydrated sockets and broadcast resumes — this part is correct.
- **The bug:** during hibernation gap *or* during reconnect, missed pixels are recovered only by `canvasRenderer.refetchCanvas()` on `onopen` *if* `isReconnect` is true (`App.svelte:122-129`). On the very first connect after a fresh page load, `isReconnect = false` (`:106`), so the initial canvas fetch is the only source of truth. If the canvas fetch happened seconds ago (CDN cache, see H4) and pixels were placed in the gap *between* canvas fetch completion and WS open, those pixels are missed silently until the user causes a refetch or another pixel near them lands.
- **Trigger:** slow page load, two HTTP/1 connection limits, or just unlucky timing.
- **Observable:** persistent stale pixels shown to the user; only fixed by reload or by another nearby placement triggering a render diff.
- **Evidence:** `App.svelte:103-144` does NOT serialize "fetch canvas → open WS"; both happen as separate effects. No version/seq number on broadcast frames to detect gaps.
- **Severity:** High. Common race in r/place clones.

#### H4. Edge cache (`max-age=10, s-maxage=10, stale-while-revalidate=30`) on `/api/canvas` writes a 10-second blind spot
- **Scenario:** Pixel placed at t=0. CF edge has cached canvas from t=−9. New tab loads at t=+0.5: gets the t=−9 snapshot. WS opens at t=+0.6 — but the pixel was already broadcast at t=0, so the new tab will *never* see it via WS, and will see the stale value until either a) cache expiry triggers a refetch or b) the same coord is repainted.
- **Trigger:** any reload during heavy paint activity. Worse with `stale-while-revalidate=30`: total stale window can reach ~40s if the revalidate is delayed.
- **Observable:** users on different tabs/devices see different canvases for tens of seconds. Image uploader's `shouldSkip` predicate (uploader L21-25) reads from this stale view and may "skip" pixels that *aren't* actually the right color, leaving holes.
- **Evidence:** `src/durable-objects/canvas-room.js:38` — `Cache-Control: public, max-age=10, s-maxage=10, stale-while-revalidate=30`.
- **Severity:** High. Visibly degrades multi-client UX; corrupts the importer's resume logic.

#### H5. WS upgrade forwards full request, but DO routes by `url.pathname` after Worker rewrites URL → WS upgrade may miss client IP / origin checks
- **Scenario:** `app.get('/api/ws', ...)` calls `room(c.env).fetch('http://do/ws', c.req.raw)`. The DO's `fetch` switches on `url.pathname` only (canvas-room.js:25). The WS upgrade handler `#handleWsUpgrade()` does *no* origin check, no auth, no IP rate-limit.
- **Trigger:** any client opens a WS to `/api/ws`. `Origin` header is unverified.
- **Observable:** any third-party site can open and hold a WS to the canvas DO. Hibernation lets connections sit cheaply, but every pixel placement broadcasts to all of them, multiplying egress per active user. With N hostile clients, broadcast cost is O(N) per placement.
- **Evidence:** `src/worker.js:67-73`, `src/durable-objects/canvas-room.js:89-94`. No `Origin` allowlist, no max-clients.
- **Severity:** High. Cheap WS-amplification attack on the broadcast hub.

---

### MEDIUM

#### M1. `tryAcquire` `INSERT … VALUES` race — relies on PK conflict throwing, but cursor is not drained on success
- **Scenario:** The SUCCESS branch of the second insert (`cooldown-store.js:45-49`) does not call `.toArray()` on the cursor (compare to the UPDATE branch L34 which *does* drain). On CF DO SQL, statement effects are committed once the cursor is materialized. If the engine deferred the commit until cursor drain and a subsequent `Math.random()` GC sweep fires (L51) and a *second* `tryAcquire` runs concurrently (impossible in a single DO, but possible across DO replays / fast retry) … this is a code-smell, not provably wrong.
- **Trigger:** API-level retry at the millisecond boundary.
- **Observable:** None reproducible from static reading. Drain-symmetry is the safe default.
- **Evidence:** `src/durable-objects/lib/cooldown-store.js:34` (drain) vs `:45-49` (no drain).
- **Severity:** Medium. Flag for fix; low real-world impact since DOs are single-threaded per name.

#### M2. `writePixels` aliasing comment is misleading; `Uint8Array(buf)` does *not* always copy
- **Scenario:** `readChunk` returns either a fresh zero-fill (no row) or wraps the SQL-returned BLOB with `new Uint8Array(blob)` if it's not already a Uint8Array. If the BLOB *is* already Uint8Array, `readChunk` returns it directly (L37-39). Then `writePixels` does `const next = new Uint8Array(buf)`. Per spec, `new Uint8Array(typedArray)` *copies*, so this is fine — but the comment at L91 says "must not alias persisted state, so copy to be safe", suggesting uncertainty.
- **Trigger:** Future refactor that uses `new Uint8Array(arrayBuffer)` instead of `new Uint8Array(typedArray)` would silently introduce aliasing (the latter constructs a view, not a copy, when given an ArrayBuffer).
- **Observable:** would corrupt the SQLite-cached BLOB and produce inconsistent reads.
- **Evidence:** `chunk-storage.js:37-39` (return path), `:92` (consumer).
- **Severity:** Medium (latent footgun, not an active bug).

#### M3. Missing duplicate-coord dedup in batch → user can inflate batch size with redundant pixels
- **Scenario:** Client submits 2048 pixels all at `(0,0)` with random colors. Validation (`worker.js:43-52`) accepts. `writePixels` groups by chunk, so all 2048 hit chunk 0; then iterates `edits` writing 2048 times to `next[0]`. Result: only the last write survives (no functional bug), but you've burned the user's full batch quota on 1 effective pixel.
- **Trigger:** buggy client, or an attacker trying to hide intent in a noisy batch.
- **Observable:** user pays 1 sec cooldown for what looks like 2048 pixels but is 1.
- **Evidence:** `worker.js:36-52` (no Set dedup), `chunk-storage.js:72-80` (last-write-wins per byte).
- **Severity:** Medium UX nuance; the importer's `pixel-buffer.js:23-30` actually *does* dedup client-side, so well-behaved clients are unaffected.

#### M4. Image-importer "progressive skip" reads stale canvas state via `shouldSkip`
- **Scenario:** `shouldSkip` is fed by the client's local canvas view, which is updated from WS broadcasts and the initial fetch. Combined with H4 (10s edge cache), the importer can skip pixels that aren't truly placed yet, leaving holes in uploaded images.
- **Trigger:** Concurrent edits + cached canvas view.
- **Observable:** importer reports "Skipped N already-matching pixels" but the pixels weren't actually placed.
- **Evidence:** `image-uploader.js:64-76`. No server-authoritative readback.
- **Severity:** Medium. Self-inflicted, recoverable by re-running the importer.

#### M5. SQLite per-row BLOB size — DO SQLite cell size limit
- **Scenario:** CF DO SQLite has a per-cell limit (commonly 2 MB hard, often documented around ~2 MB). Each chunk is 64 KB — well under. ✅ Not a bug today. Becomes a problem if `CHUNK_BYTES` is bumped above the cell limit during a "resize redeploy".
- **Trigger:** Future redeploy with `CHUNK_BYTES > 2 MB`.
- **Observable:** writes throw at runtime; canvas frozen.
- **Evidence:** `constants.js:18` — no assertion that `CHUNK_BYTES` ≤ documented cell-size cap.
- **Severity:** Medium (latent; add a static assertion).

#### M6. Per-DO storage cap (CF DO SQLite ~10 GB / instance)
- **Scenario:** Cooldown table grows to ~`active-users` rows; canvas chunks at 256 × 64 KB = 16 MB. Plenty of headroom *unless* users explode (millions of unique IPs/day) and GC at 1% sample rate fails to keep up.
- **Math:** at 1% GC sample rate per `tryAcquire`, expected GC runs/sec = 0.01 × QPS. At low QPS (1-10), GC may run < once/min. Each row ~50-100 bytes; 10 GB cap = ~150 M rows. Not realistic on rPlace traffic, but on a viral spike, possible.
- **Evidence:** `cooldown-store.js:7` (`GC_SAMPLE_RATE = 0.01`), `:36-37, :50-51` (probabilistic).
- **Severity:** Medium (capacity, not correctness).

#### M7. `webSocketClose` re-closes already-closed socket
- **Scenario:** Hibernation API delivers `close` events for *all* terminations including ones the server initiated. The handler at `canvas-room.js:115-121` calls `ws.close(code, reason)` again, on a socket that's already closed.
- **Trigger:** any close event on hibernation-mode WS.
- **Observable:** likely silent (ws.close on closed = no-op or throws caught upstream). Comment says "Required pre-2026-04-07 compat" which today's compat date is `2025-04-01` — so this code path *is* exercised. Confirmed no try/catch around it.
- **Evidence:** `canvas-room.js:120` and `wrangler.json:4` (`compatibility_date: "2025-04-01"`).
- **Severity:** Medium. Add try/catch defensively.

---

### LOW

#### L1. Chunk-boundary math is correct for current dims, but no off-by-one guard if `TOTAL_PIXELS % CHUNK_BYTES != 0`
- **Math:** `4096 × 4096 = 16_777_216`; `16_777_216 / 65536 = 256` exactly. So `chunkSize(255) = min(65536, 16_777_216 - 255*65536) = 65536`. ✅ Today.
- **Risk:** if dims become non-multiples (e.g. `CANVAS_WIDTH = 4097`), `TOTAL_PIXELS = 16_785_409`, `CHUNK_COUNT = ceil(16_785_409 / 65536) = 257`. `chunkSize(256) = 16_785_409 - 256*65536 = 8193`. `readChunk` returns a `Uint8Array(8193)` for the missing row, but `readAllChunks` does `out.set(view, chunkId * CHUNK_BYTES)` where `out` is sized `TOTAL_PIXELS` — write at offset `256*65536 = 16_777_216` of length `8193` ends at `16_785_409` ✅.
- **Where it breaks:** `pixelToChunk` returns `byteOffset = offset % CHUNK_BYTES` — for the last chunk this is fine because writes are bounded by valid (x,y). But if a stored row's BLOB is larger than `chunkSize(chunkId)` (e.g. legacy rows after a *shrink*), `out.set` would overrun. No length-check on the read path.
- **Evidence:** `chunk-storage.js:46-56` — no `subarray(0, chunkSize(chunkId))` clamp.
- **Severity:** Low (current dims safe; flag if shrinking).

#### L2. Validator double-work: edge validates, then DO re-validates
- Edge in `worker.js:36-52`, DO in `canvas-room.js:51-70`. Defensive, not a bug, but increases JSON parse cost twice for every batch.
- **Severity:** Low (perf; acceptable defense-in-depth).

#### L3. `Number.isInteger(p?.x)` accepts `-0` and the same coord as `0`
- Per ES spec `Number.isInteger(-0) === true`, and `-0 < 0 === false`, so `-0` passes through. Harmless (writes byte 0 of chunk 0), but worth noting if anyone ever uses x as a JSON Map key.
- **Severity:** Low.

#### L4. `MAX_BODY_BYTES = MAX_BATCH_SIZE * 64` is a heuristic; large palette indices aren't longer
- 64 bytes/pixel is generous (`{"x":4095,"y":4095,"color":255}` is ~32 chars). Comment says "~64 bytes is generous" — fine. But malicious whitespace-padded JSON (`"  x  ":  0`) can blow past this *length* before parsing. `c.req.header('content-length')` is client-supplied and may lie.
- **Trigger:** crafted body with bogus `Content-Length`. Hono / `c.req.json()` will read the actual body; if it's larger than declared, behavior depends on the Hono runtime (usually reads what's there). Not a memory exhaustion attack on Workers (req body capped at 100 MB), but it bypasses the early reject.
- **Severity:** Low.

#### L5. WS broadcast: `JSON.stringify` once, send to all — but no backpressure detection
- `canvas-room.js:97-105`: `ws.send(message)` in a loop. No queue length check. If a client is slow / hibernated incorrectly / on flaky cell, sends pile up. CF docs suggest checking `getReadyState` or buffered amount; here we just rely on the catch.
- **Severity:** Low (CF runtime likely drops or queues internally).

#### L6. No cap on number of WebSocket clients per DO
- Combined with H5 (no Origin check), a malicious party can open 10K hibernation sockets cheaply. Each pixel broadcast iterates all of them via `getWebSockets()` — O(N) per place.
- **Severity:** Low standalone, High when combined with H5.

#### L7. Test coverage gaps
- No tests for the DO itself (storage, cooldown, broadcast, hibernation).
- No tests for `chunk-storage.writePixels` (atomicity, multi-chunk batches, boundaries).
- No tests for `cooldown-store.tryAcquire` (race, GC, expiry).
- No tests for `getUserId` (header presence/absence, hashing).
- No integration / WS reconnect tests.
- The single test file (`worker-validation.test.js`) only exercises edge JSON validation — exactly what TypeScript types would catch.
- **Severity:** Low (process), High in aggregate (quality risk).

---

## Test file gaps (worker-validation.test.js)

- Mocks the DO as an empty class; never tests forwarding behavior under failure (DO 5xx, network error from the DO stub).
- No assertion that `getUserId` is called and forwarded in the body.
- No test for `MAX_BODY_BYTES` early reject (`content-length > MAX_BODY_BYTES`).
- No test that the DO response is passed through verbatim — currently only the body is checked, not headers, not status text.
- No test that `pixels` non-object element (e.g. `[null, 1, "x"]`) is rejected with `invalid_pixel`. (Code uses `p?.x` so null/non-object yields `undefined`, fails `Number.isInteger`, returns 400. Good — but untested.)
- No `/api/canvas` test at all.
- Boundary test (L137) only tests upper bound, not `(0, 0, 0)`.

---

## Cross-cutting observations

1. **Cooldown identity is the weakest link.** IP-based hashing collides under NAT (C3) and is shared in dev (H2). Combined with H1 (no daily cap), one IP can either lock out a building or repaint the whole canvas — both bad outcomes from the same input.
2. **The atomicity story is broken.** `writePixels` comment claims atomicity from "no `await`" (chunk-storage.js:86-87) but each `sql.exec` is auto-commit. Wrap the loop in `state.storage.transactionSync(() => { ... })` to actually deliver on the comment. C1+C2 both go away.
3. **Edge cache and WS race (H3+H4) is the canonical r/place clone bug.** Mitigation: serve canvas via the WS first message (snapshot frame) instead of via cached HTTP, *or* attach a `version` (monotonic counter) to broadcast frames and let the client refetch when it detects a gap.
4. **Hibernation API is used correctly.** `acceptWebSocket` (canvas-room.js:92) and `getWebSockets` (`:98`) are right. The `webSocketClose` re-close (M7) is the only smell; everything else aligns with CF docs.
5. **SQLite usage is conservative.** 64 KB BLOBs, single-PK rows, sparse rows. No schema landmines today. Future-proofing: assert `CHUNK_BYTES <= 2*1024*1024` in init.

---

## Suggested priority fixes (not implementing — read-only audit)

1. Wrap `writePixels` in `state.storage.transactionSync` (fixes C2, partially C1).
2. Move `tryAcquire` *after* `writePixels` succeeds, OR add a "release" path on storage failure (fixes C1).
3. Add `Origin` allowlist + max-clients cap on `#handleWsUpgrade` (fixes H5/L6).
4. Drop `s-maxage` to 1-2s (or remove edge cache and serve from DO live), and emit a sequence number on every broadcast frame to detect gaps (fixes H4 and partially H3).
5. Add per-IP daily quota in addition to 1Hz cooldown (fixes H1).
6. Augment `getUserId` with a stable client-side cookie (signed) to break NAT collisions (fixes C3).
7. Add static assertion `CHUNK_BYTES <= 2_000_000` (M5).
8. Add try/catch around `webSocketClose`'s re-close (M7).
9. Drain INSERT cursor symmetrically in `tryAcquire` (M1).
10. Add DO unit tests covering the gaps in L7.

---

## Status: DONE_WITH_CONCERNS

**Summary:** 3 critical, 5 high, 7 medium, 7 low findings across cooldown identity (IP/NAT), atomicity claims that don't match implementation, WS+cache race window, and image-importer DoS surface. Test coverage is limited to edge-validation; DO logic is untested.

**Concerns:**
- The "no await = atomic" comment in `chunk-storage.js:86-87` is wrong; needs `transactionSync` for true atomicity.
- IP-only identity is both a usability bug (NAT) and an abuse vector (no daily cap). These are the same fix from different angles.
- WS broadcast lacks an Origin gate — any site can hold sockets to the canvas DO.

**Unresolved questions:**
1. What is the documented per-cell BLOB limit on CF DO SQLite as of compat date 2025-04-01? (Affects M5 severity if user later resizes chunks.)
2. Is `state.storage.transactionSync` available on the Workers runtime version pinned by `compatibility_date: 2025-04-01`? If not, the atomicity fix needs `transaction(async () => {...})` instead.
3. Is there a planned per-room model (so `idFromName('main')` becomes one of many)? Per-room would naturally lift IP collision pain *if* combined with an account/cookie identity. Without that, sharding doesn't help.
4. Is there a CDN-layer mitigation for H4 (e.g. Cache API key on a freshness query string set by the DO)? The current `Cache-Control` headers will be honored by CF colos; product needs to decide live-fresh vs. cheap.
5. What's the operational policy on importer abuse? A 7M pixel/hr/IP cap is the canvas-rewrite budget; this is a product decision, not just engineering.
