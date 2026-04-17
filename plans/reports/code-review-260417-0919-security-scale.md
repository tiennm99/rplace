# rplace — Adversarial Security & Scalability Review

**Date:** 2026-04-17
**Scope:** ~934 LOC. CF Worker + Hono + Upstash Redis + Svelte 5
**Reviewer angle:** abuse / cost amplification / scale limits

---

## Executive Summary

The project ships a small, clean codebase, but rate-limit identity is essentially trivial to bypass and there is **no edge cache** on the 2.5MB canvas endpoint. A single laptop can drain Upstash free tier in minutes. **Going public without fixes 1–3 below = guaranteed outage and/or unbounded cost.**

Critical: 2 · High: 5 · Medium: 7 · Low: 4

---

## CRITICAL

### C1 — Rate limiter trivially bypassed via IP-only identity (collision + spoofing)
**File:** `src/lib/get-user-id.js:7-17`, `src/worker.js:55-58`
**Vector:**
- Identity = 32-bit non-cryptographic hash of `cf-connecting-ip`. Hash space = `2^32`. Birthday collisions at ~65k unique IPs cause innocent users to share buckets. Targeted preimage trivial (4-byte hash, attacker can find IPs that collide with victim).
- IPv6: each user gets a /128, but ISPs hand out /48–/64 prefixes. Attacker on Hurricane Electric tunnel / cloud provider has billions of /128s = billions of free buckets → effectively unlimited pixel rate.
- IPv4 mobile NAT / corporate NAT: many real users share one IP → all share one 256-credit bucket. Already broken for legitimate users, before any attack.
- Tor / open proxies / residential proxy services (BrightData, etc.): attacker rotates IPs at $0.50/GB → 1k req/sec each at full credit refill.
- Cloudflare Workers themselves cost $0 outbound; an adversary can deploy a free worker that proxies through ~100 colos → 100 distinct `CF-Connecting-IP` values immediately.

**Impact:** Rate limit is theater. Attacker can repaint the entire 4M-pixel canvas in minutes. Free tier will burn before the canvas finishes redrawing once.

**Mitigation:**
- Aggregate IPv6 to /64 (or /48) before hashing.
- Drop the JS hash; use the raw IP (stored only in Redis with TTL — already private, never echoed back). The hash adds zero security and creates collisions.
- Layer a global rate limit (Cloudflare Rate Limiting Rules in front of Worker, free up to 10k req/10s).
- Optional: require a signed cookie / hCaptcha turnstile token to gate first placement; cookie identifies bucket instead of IP.

### C2 — `/api/canvas` is uncached → every request hits Upstash for 2.5MB
**File:** `src/worker.js:12-20`, `src/lib/canvas-storage.js:14-46`
**Vector:**
- `Cache-Control: public, max-age=1, s-maxage=1, stale-while-revalidate=5`. `s-maxage=1` means Cloudflare edge revalidates every 1 second, and **CF only caches `Cache-API`-stored or static asset responses by default for Workers fetch responses unless explicitly stored**. This dynamic Hono response is **not in CF cache** without `caches.default.put()`. Even if it were, every 1s window = full re-fetch.
- Each request triggers `redis.getrange("canvas", 0, 2_621_439)` over Upstash REST/HTTP. Upstash free tier: 10k commands/day, 256MB egress/day.
- 2.5MB × 100 requests = 250MB → **single user at F5 spam burns the entire daily egress in <30 seconds**.
- Worker CPU: parsing base64 of 2.5MB + `Uint8Array` loop bytewise = easily exceeds the 10ms free-tier CPU budget per request (50ms paid). `atob` of ~3.5MB base64 string is ~30–80ms cold. Will hit "exceeded CPU" 1015 errors under load.
- `data` from `getrange` is loaded as a JS string then iterated character-by-character — on a 2.6MB string this is ~10ms+ of pure JS even without atob.

**Impact:** First viral moment = $$$ overage and/or service outage. One user with curl loop = denial of service.

**Mitigation:**
- Use Cloudflare Cache API explicitly: `caches.default.match(req)` → on miss `fetch from Redis`, then `caches.default.put(req, response.clone())` with `max-age=2`. This caches at edge, so Upstash sees ≤1 req/sec/colo regardless of load.
- Better: snapshot canvas to R2 every N seconds (cron trigger), serve from R2 (free egress to CF). `/api/canvas` becomes a redirect or R2 binding fetch.
- Even better: store canvas IN the Durable Object (in-memory + persisted to DO storage), broadcast deltas, never round-trip to Upstash on read.
- Use `Uint8Array` from `Buffer.from(data, 'base64')` instead of charCodeAt loop.

---

## HIGH

### H1 — `/api/place` does **not** cache-bust `/api/canvas`
**File:** `src/worker.js:23-79`
After a write, the cached canvas (if any) becomes stale until `max-age` expires. New tabs will load a 1-second-stale canvas, see the WS pixel update, and apply it on top of stale state. With unset pixels (no read-modify-write), this is OK by accident — but as soon as you cache properly (C2), you must purge or version the canvas key.

**Mitigation:** Append `?v={epoch_seconds}` query in client; bump on WS reconnect. Or use `If-None-Match` ETag from a Redis-stored canvas-version counter.

### H2 — WebSocket connections are not rate-limited and use **standard** (non-hibernating) WS API
**File:** `src/durable-objects/canvas-room.js:30-44`
**Vector:**
- `server.accept()` uses the standard WebSocket API. Standard WS keeps the DO instance billable in active memory continuously. The hibernation API (`state.acceptWebSocket()`) lets the DO sleep between events.
- A single DO has soft cap ~32k WebSockets, hard memory cap 128MB. Each connection carries event-listener closures + JS state.
- All clients hit `idFromName('main')` → **single DO instance** for the whole world. No sharding, no cap, no auth. An attacker opens 50k WS connections from cloud → DO OOMs or hits CPU limit, **all real users disconnected**.
- No per-IP cap on WS. No origin check. CSWSH (Cross-Site WebSocket Hijacking) trivially possible — any malicious page can `new WebSocket("wss://your.app/api/ws")` and read pixel placements (though this stream is not sensitive, the DDoS vector remains).
- Broadcast uses `await room.fetch(...)` per `/api/place` → blocks request return on DO round-trip. Under load, /api/place latency = DO fan-out latency.

**Impact:** Single attacker disconnects everyone. Cost: standard WS instances stay billed 24/7 even when idle; hibernation reduces this 100x.

**Mitigation:**
- Switch to hibernation API: `this.state.acceptWebSocket(server)` + `webSocketMessage()` / `webSocketClose()` handlers on the class.
- Enforce per-IP WS connection cap (track in DO memory): reject if same IP has >5 connections.
- Validate `Origin` header on upgrade — reject non-allowlisted origins.
- Make broadcast fire-and-forget: `c.executionCtx.waitUntil(room.fetch(...))` instead of `await`. Don't block client response.
- Shard by region or hash if you ever go big (`idFromName(\`room:${region}\`)`).

### H3 — `setPixels` does N writes per batch via builder chain → not actually atomic per-batch
**File:** `src/lib/canvas-storage.js:54-64`
**Vector:**
- Comment claims "single atomic BITFIELD command" but Upstash REST `bitfield` builder pattern executes a **single Redis command** with N subcommands — that part *is* atomic. **Good.**
- However: `BITFIELD canvas SET u5 #X v ... SET u5 #Y v` is **one HTTP request to Upstash REST** carrying 32 subcommands. At 2 KB request body size, fine.
- BUT the request between `/api/place` and `/api/canvas` is **not** atomic: a client doing GET then POST sees racy state if pixels arrive between them. WS layer compensates if connected first. Initial-load race window is real but cosmetic.
- Real risk: **rate limiter Lua** runs in a *separate* Upstash REST call from the BITFIELD write. Sequence:
  1. POST handler validates pixels (CPU-bound)
  2. Lua `eval` (network trip 1)
  3. BITFIELD `exec` (network trip 2)
  4. DO `fetch` for broadcast (network trip 3)
- A client can fire 32 parallel `/api/place` requests with `count=1` each; each reads credits = 256, deducts 1, writes 255 — all atomic individually but 32 succeed where only 256 should ever exist. Wait — the Lua re-reads on each call so it's serialized through Redis single-thread. **Lua is atomic per script call**, so 32 parallel /place requests serialize and only the first 256 succeed total. **OK.**
- Real exposure: between Lua approving and BITFIELD writing, if BITFIELD fails the credit was already deducted — user loses credits with no pixel placed. No compensation logic.

**Impact:** Lost-credit grief on Upstash hiccup; potential reverse race where user sees credit deducted but pixel never appears.

**Mitigation:** Reverse the order — write pixels first, then deduct credits (refund pixel buffer if credits insufficient is harder). Or wrap both calls in pipeline + handle failure by refunding via second Lua call. At minimum, log the inconsistency and let WS reconcile.

### H4 — Body size is unbounded — DoS via giant JSON
**File:** `src/worker.js:23-37`
**Vector:** `await c.req.json()` parses the entire request body before checking `pixels.length > MAX_BATCH_SIZE`. Attacker sends 100MB JSON `{"pixels":[...10M items...]}`. Worker loads all of it into memory, then the length check fires after.
- CF Workers do enforce a 100MB request body cap on free tier, but a 100MB POST per request × 1k req/sec = 100GB ingress amplification.
- More subtle: `{ "pixels": [...32 items...], "garbage": "<10MB string>" }` — passes length check, wastes CPU on JSON parse.

**Impact:** CPU and memory amplification. Easy to push request over 50ms CPU limit and trip 1102 errors.

**Mitigation:** Check `content-length` header before reading body: reject if > 4 KB (max valid batch is ~2 KB). Use `c.req.raw.body` and abort if exceeds limit.

### H5 — No CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
**File:** `src/worker.js` (no header middleware), `src/index.html` (no meta CSP)
**Vector:**
- Page can be iframed by any origin → clickjacking. Attacker overlays UI tricks user into placing pixels they didn't mean to. Long-press touch = especially exploitable on mobile (transparent overlay over color picker → user "places" attacker's pixel pattern).
- No CSP → if any future feature ever renders user-supplied text, immediate XSS. Currently no UGC text, but pixel coordinates and color from network are not the only risk; a future feature drift will break this.
- API responses lack `X-Content-Type-Options: nosniff`. The 2.5MB binary canvas could be sniffed as HTML by old browsers if served from same origin.

**Mitigation:** Add Hono `secureHeaders()` middleware or set:
```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

---

## MEDIUM

### M1 — DO room state lost on eviction; no canvas sync on WS connect
**File:** `src/durable-objects/canvas-room.js`, `src/client/App.svelte:26-55`
- DO never persists `sessions`. On eviction (CF migrates DO between machines), in-flight broadcasts during migration window dropped. Acceptable but worth noting.
- Client `onclose` reconnects but **never refetches the canvas**. After WS gap (network blip, sleep, throttle), client's `imageData` is now stale; pixels placed during disconnect window are missed forever — until full page reload.

**Mitigation:** On WS `onopen` after a previous `onclose`, refetch `/api/canvas` and replace `imageData`. Or: server pushes a sequence number per pixel batch; client requests gap fill via REST.

### M2 — `applyUpdates` does not validate WS payload
**File:** `src/client/components/CanvasRenderer.svelte:82-87`
- WS payload `data.pixels` iterated and written directly to ImageData. No bounds check, no integer check. A malicious DO message (or Man-in-the-Middle on plain `ws://` if HTTPS-stripped) could write `x=1e9` → `offset` is huge → silent JS array OOB write that is no-op but wastes cycles. Or `x=1.5` → `(y * W + x) * 4` = fractional offset = writes to wrong pixel.
- Server controls the WS messages via `setPixels` which already validates. Defense-in-depth: validate at the boundary anyway.

**Mitigation:** Reuse the same validator from worker.js in client `applyUpdates`. Drop invalid pixels silently.

### M3 — Optimistic UI never rolls back on rejection
**File:** `src/client/components/CanvasRenderer.svelte:55-80`
- `placePixel` deducts credits + paints local pixel before fetch. On 429 rate-limited, client logs warning and **leaves the wrong-color pixel on screen** until WS broadcast or refresh. Worse: client has now decremented credits the server never deducted (server returned `remaining` but client only updates on `data.ok`). User sees impossibly low credit count.
- Comment says "WS will correct" — only true if the *real* color was placed by someone else; if no one paints over, ghost pixel persists locally forever.

**Mitigation:** On non-ok, restore credits (`onCreditsChange(credits + 1)`) and undo pixel by repainting from cached server state (need to keep "last server state per pixel" or just re-fetch).

### M4 — `console.error('Broadcast failed', err)` and other error paths leak nothing externally — but error responses leak Redis behavior
**File:** `src/worker.js:74-76`, `src/lib/canvas-storage.js`
- `console.error` is fine — CF logs only. Not an external leak.
- However: an Upstash REST 5xx (network blip) bubbles unhandled out of `getFullCanvas` → Hono returns 500 with whatever Hono's default body is. Could include `Error: fetch failed` stack in dev mode. Production CF strips stacks, so impact is mostly UX.
- `getrange` on missing key returns empty in code path: covered. But `redis.bitfield(...).exec()` failure throws → /api/place returns 500 with credits already deducted (see H3).

**Mitigation:** Wrap each Redis call in try/catch; return generic `{error: "upstream_unavailable"}` 503. Add `app.onError()` handler that always returns sanitized JSON.

### M5 — DO `/broadcast` endpoint accepts any inbound request that reaches it
**File:** `src/durable-objects/canvas-room.js:16-27`
- The DO is only addressable via DO bindings — cannot be hit from public internet directly. Risk is zero from outside.
- BUT: any worker bound to `CANVAS_ROOM` (including future workers in same account) can post arbitrary JSON pixels, which then get broadcast to all clients with `type: 'pixels'` shape unchecked.
- The DO does not validate the broadcast payload (`x`, `y`, `color` ranges). Trusts caller.

**Mitigation:** Validate pixel shape in `/broadcast` handler too. Defense-in-depth — the DO is the source of truth for what gets fan-out.

### M6 — Long-lived WebSocket DO holds entire `Set<WebSocket>` in memory
**File:** `src/durable-objects/canvas-room.js:9, 19-25`
- `for (const ws of this.sessions) { try { ws.send(message); } catch { this.sessions.delete(ws); } }` — modifying Set during iteration. JavaScript spec allows this (Set iterator handles deletes mid-iteration), but the `catch` triggers if `send` throws on a closed socket and the `close`/`error` listener may not have run yet. Resulting state OK, just inefficient.
- At 10k WS, broadcasting a 32-pixel update = 32 × 10k = 320k JSON serialization events? No — `JSON.stringify` once, then 10k `send` calls. Each `send` enqueues a frame; no backpressure. Slow client backs up the queue → DO memory grows.

**Mitigation:** Use hibernation API (H2) which the runtime handles efficiently. Drop slow clients (track outstanding bytes via some heuristic; not directly exposed).

### M7 — `EXPIRE 86400` on credits hash means inactive users keep MAX_CREDITS for 24h
**File:** `src/lib/rate-limiter.js:30`
- Inactive user comes back after 25h → key gone → `credits = MAX_CREDITS` (initialized from ARGV[3]). Good.
- Same user coming back at 23h59m → still has whatever credits (probably full from regen). Also good.
- BUT key resets on every successful place, so "active spammer" key never expires; bot can hold key alive forever for free in Redis.

**Mitigation:** Negligible at user scale. If Redis storage matters, drop EXPIRE down to 1h since regen recovers full credits in 256s anyway.

---

## LOW

### L1 — `Math.floor(Date.now() / 1000)` precision: drift in credit accrual
- 1-second precision on rate limiter means if user posts at t=1.99s and again at t=2.01s, lastUpdate goes 1→2 but elapsed=1s gives 1 credit. Effectively floor() rounding cuts up to 1 credit per place call. Cosmetically fine.

### L2 — Color picker / UserInfo z-index conflicts at small viewports
- All overlays z-index 10, color-picker bottom-center, user-info top-left. Touch users on small phones may have controls overlap canvas tap zones near edges.

### L3 — `parseInt(hex.slice(1), 16)` in `constants.js` runs on module init both client and worker
- Trivial cost (32 colors × 4 ops). Mentioning only because the import surface could be split: client doesn't need worker-only constants and vice versa.

### L4 — `redis-client.js` constructs new Redis object per request
- `new Redis({...})` each call is cheap (no connection pool — REST is stateless HTTP). Fine. Worth noting in case it's mistakenly converted to TCP client later.

---

## Scalability — concrete numbers

### Per-action cost
| Action | Upstash commands | Worker CPU | Egress |
|---|---|---|---|
| `GET /api/canvas` (uncached) | 1 (GETRANGE 2.6MB) | ~50ms (atob+loop) | 2.6MB |
| `GET /api/canvas` (cached, ideal) | ~0 (every 2s/colo) | ~5ms | 2.6MB from edge |
| `POST /api/place` (32 pixels) | 2 (EVAL + BITFIELD-32-subcmds) | ~10ms | <1KB |
| WS broadcast (per place) | 0 | ~5ms × N clients | 1KB × N clients |

### 1k concurrent users, 1 pixel/sec each
- /place: 1000 req/s × 2 Upstash cmd = **2000 cmd/s** → 172M cmd/day.
  - Upstash free tier: 10k cmd/day. **Burns in 5 seconds.**
  - Pay-as-you-go: $0.20/100k cmd → **$345/day**.
- WS: 1000 connections in single DO. Soft cap fine, but no hibernation = always-on DO memory ~50MB (~50KB/conn).
- Broadcast fan-out: 1000 messages/sec to DO, each broadcast to 1000 sockets = **1M sends/sec**. DO CPU **maxed**. Real cap: a single non-hibernating DO can sustain ~10k–30k sends/sec sustained.
- Worker invocations: 1000/s × 86400 = 86M/day. Free tier = 100k/day. **Burns in 100 sec.**

### 10k WS connections
- Single DO `idFromName('main')` = single instance. CF DO doc: ~32k WS soft cap, 128MB memory.
- 10k × ~50KB JS state = 500MB → **OOM**. Hibernation API drops to ~1KB/socket idle = 10MB. **Must use hibernation.**

### Cold-start /api/canvas
- Cold worker init: ~10–30ms.
- Upstash REST call from CF colo to closest Upstash region: typically 30–80ms RTT.
- 2.5MB body transfer: ~50ms over 1Gbps from Upstash to CF.
- atob(3.5MB base64 string) in V8: 30–80ms.
- charCodeAt loop on 2.6MB string: 10–30ms.
- **Total cold p99: ~200–300ms; CPU time: 60–100ms** → exceeds free tier 10ms CPU per request. Will trip "exceeded CPU limit" errors immediately on free tier.

### Bottleneck order before things break
1. **Worker free-tier CPU limit (10ms)** — broken by /api/canvas on first request.
2. **Upstash free-tier daily commands (10k/day)** — broken by ~100 page loads or ~5k pixel placements.
3. **Worker free-tier daily requests (100k)** — broken by ~10 active users.
4. **DO memory (128MB)** — broken at ~2.5k concurrent WS without hibernation.
5. **Single DO CPU** — broken at ~10k pixels/sec broadcast rate.
6. Upstash bandwidth — broken at ~100 canvas fetches.

### Cost to run at "1k DAU, 100 pixels/user/day"
- Place: 100k × 2 = 200k Upstash cmd/day → $0.40/day Upstash pay-as-you-go.
- Canvas reads (1k users × ~5 loads/day uncached): 5k × 2.6MB = 13GB egress. Upstash bandwidth $0.03/GB → $0.39/day. **Cached: <$0.01/day.**
- Workers: 100k place + 5k canvas = 105k requests = free tier breakeven. Paid: $0.30/M = $0.03/day.
- DOs: 1 instance × 24h with WS = $0.15/GB-hour memory + $0.20/M requests. Hibernating: ~$0.50/day. Standard: ~$5/day.
- **Realistic minimum monthly cost at 1k DAU done right: $30–60/mo. Done wrong (uncached canvas, no hibernation): $500+/mo.**

---

## Top 3 things to fix BEFORE going public

1. **Cache `/api/canvas` at the edge** (C2). Use CF Cache API explicitly. Without this, *one user* can take you down. **Single most important fix.**
2. **Switch DO to WebSocket Hibernation API + cap connections per IP + validate Origin** (H2). Otherwise one botnet shuts down realtime for everyone.
3. **Add CF Rate Limiting Rules in front of the Worker, plus IPv6 /64 aggregation in `getUserId`** (C1). Identity-layer rate limit alone is insufficient; need a network-layer floor that isn't easy to spoof. Add `secureHeaders()` middleware (H5) in the same change.

Bonus near-mandatory: bound request body size (H4), make broadcast non-blocking via `waitUntil` (H2), and refetch canvas on WS reconnect (M1).

---

## Positive Observations

- BITFIELD with 5-bit packing is the right primitive — atomic per call, dense on disk.
- Lua script for credit deduction is genuinely atomic (Redis single-threaded eval).
- Pixel input validation in `/api/place` covers integer, range, NaN, type — quite thorough.
- Stackable credits with regen is the right UX model (matches Reddit r/place).
- Codebase is small and readable; good module separation (constants, redis-client, rate-limiter, canvas-storage are correctly factored).
- WS reconnect with exponential backoff in client is well-implemented (App.svelte:42-46).
- No use of `eval` / `Function`, no obvious prototype-pollution sinks. Body parsed via Hono safely.

---

## Unresolved Questions

1. Is the project intended for production (real users) or demo? Several mitigations (hCaptcha, CF Rate Limiting Rules) add friction; only worth it if real adversaries expected.
2. What's the expected concurrent user ceiling? 100? 10k? Decides whether single-DO-room is sufficient or sharding is needed.
3. Is account on Cloudflare paid plan or free tier? Free tier 10ms CPU is hard cap that breaks /api/canvas immediately.
4. Is canvas reset (full wipe) ever needed? No `DEL canvas` admin endpoint exists. Adversarial fill = irreversible.
5. Should pixel placement carry attribution (who placed which pixel)? No audit log currently — abuse takedown impossible.
6. Mobile NAT collision: acceptable for users to share buckets, or need cookie-based bucketing?

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Codebase is clean and small; security is largely fine for a demo, but the IP-only rate limit and uncached 2.5MB canvas endpoint will break under public load — going live without C1, C2, H2 fixed will result in immediate cost overrun and/or outage.
**Concerns:** (a) project may already be intended public — fixes 1–3 are blocking; (b) free-tier limits will trip on first viral burst regardless of attacker presence.
