# Research Report: Can rplace Be Moved to Vercel?

**Date:** 2026-05-09 22:46 (Asia/Saigon)
**Scope:** Feasibility of migrating rplace (Cloudflare Workers + Durable Objects + Upstash) to Vercel.
**Verdict:** **Not a drop-in move. Requires architectural rewrite of the realtime layer.**

---

## Executive Summary

rplace **cannot be lifted-and-shifted** to Vercel. Two hard blockers:

1. **Cloudflare Durable Objects have no Vercel equivalent.** rplace uses a DO (`CanvasRoom`) as the single broadcast hub for all WebSocket clients — a stateful, globally-addressable actor. Vercel does not offer this primitive.
2. **Vercel Functions cannot host WebSocket servers.** Confirmed unchanged in 2026, even with Fluid Compute. Each invocation terminates after responding; no persistent process holds sockets open.

Everything else (Svelte SPA, Vite build, Upstash Redis storage, rate limiter) is portable. The realtime broadcast is the ~20% of the code that drives ~80% of the migration cost.

**Recommended path if migration is mandatory:** Vercel hosts the SPA + HTTP API; offload WS broadcast to a managed realtime provider (Ably / Pusher / Liveblocks / Partykit). Estimated effort: medium (1–3 days), plus a new monthly bill from the realtime provider.

**Recommendation:** Stay on Cloudflare unless there is a non-technical driver (org policy, billing consolidation). The current stack is a near-optimal fit for this workload; Vercel is a strict downgrade for realtime.

---

## Methodology

- Sources: 2 web searches (Vercel WS support 2026, Vercel DO equivalent 2026)
- Code inspected: `src/worker.js`, `src/durable-objects/canvas-room.js`, `src/lib/redis-client.js`, `src/lib/canvas-storage.js`, `src/lib/rate-limiter.js`, `wrangler.json`, `package.json`, `README.md`
- Date: 2026-05-09

---

## Cloudflare Coupling Inventory

| Component | File | Cloudflare Lock-in | Portable? |
|---|---|---|---|
| Worker entry (Hono) | `src/worker.js` | Uses `c.env`, `c.executionCtx.waitUntil` | Rewrite needed |
| Durable Object | `src/durable-objects/canvas-room.js` | `state.acceptWebSocket`, Hibernation API, `WebSocketPair`, `idFromName`/`get` | **No equivalent** |
| Redis client | `src/lib/redis-client.js` | `import { Redis } from '@upstash/redis/cloudflare'` | Trivial — swap to `@upstash/redis` |
| Canvas storage | `src/lib/canvas-storage.js` | Upstash REST only | Yes |
| Rate limiter | `src/lib/rate-limiter.js` | Upstash SET NX EX | Yes |
| Static assets | `wrangler.json` `assets.directory` | CF static binding | Yes (Vercel serves SPA natively) |
| WS upgrade route | `src/worker.js` `GET /api/ws` | Delegates to DO | **No equivalent** |
| `executionCtx.waitUntil` | `src/worker.js` | CF runtime | Vercel has `waitUntil` via `@vercel/functions` |

---

## Hard Blockers

### 1. Durable Objects (the showstopper)

`CanvasRoom` is the single broadcast room. All clients connect to the **same DO instance** (`idFromName('main')`) so a `POST /api/place` on any worker can reach every connected socket via one `room.fetch('/broadcast')` call. This is the entire architectural reason DOs exist.

**Vercel has no actor / single-threaded stateful primitive.** Confirmed 2026: "No equivalent exists on Vercel for Cloudflare Durable Objects." The official Vercel migration KB recommends external state (Redis) + third-party realtime services.

### 2. WebSocket Server Hosting

`webSocketMessage` / `webSocketClose` / `webSocketError` callbacks rely on Cloudflare's **Hibernation API**, which lets sockets survive worker eviction. Vercel Functions terminate per-request — they physically cannot keep a socket open across requests, even on Fluid Compute.

---

## Migration Options (if forced)

### Option A — Hybrid: Vercel + Managed Realtime (recommended if migrating)

```
Browser ──HTTP──▶ Vercel Function (Hono or Next API route)
                       │
                       ├─▶ Upstash Redis (canvas + cooldown) — unchanged
                       └─▶ Ably/Pusher/Liveblocks/Partykit ──▶ broadcast to clients
Browser ◀──WS────────── (managed provider connection, not Vercel)
```

- **Code changes:** Replace `broadcastPixels()` body with `await ably.channels.get('canvas').publish(...)`. Delete `canvas-room.js`. Replace WS client connection URL.
- **New cost:** ~$10–50/mo small tier (Ably/Pusher); Partykit free tier may suffice.
- **Effort:** ~1–3 days including testing.
- **Risk:** Two providers to monitor; broadcast no longer co-located with storage.

### Option B — Vercel + SSE (no managed provider)

Replace WebSocket with **Server-Sent Events** + Redis Pub/Sub. Each client opens a long-lived SSE response from a Vercel Function. The function `SUBSCRIBE`s to a Redis channel and streams pixel events.

- **Problem:** Vercel Function max duration is bounded (Fluid Compute extends but is not infinite). Long-lived SSE streams burn function-seconds — billing concern at scale.
- **Bidirectional?** SSE is server→client only. rplace currently broadcasts only, so this is fine.
- **Effort:** ~2–4 days (more plumbing than Option A).
- **Verdict:** Cheaper monthly bill, more code to own.

### Option C — Migrate to Cloudflare Pages instead

If the underlying motivation is "I want a Pages-like static + functions host," Cloudflare Pages with Functions + Durable Objects already does this and the code runs unchanged. Worth confirming the user's actual goal before assuming Vercel.

### Option D — Rejected: Vercel-only with no realtime

Not viable. Polling `GET /api/canvas` (16 MB payload) every few seconds destroys the UX and bandwidth budget. Don't.

---

## Cost / Effort Comparison

| Path | Effort | Monthly Cost Delta | Realtime Quality |
|---|---|---|---|
| Stay on Cloudflare | 0 | $0 | Excellent (current) |
| Vercel + Ably/Pusher | 1–3 days | +$10–50 | Excellent |
| Vercel + Partykit | 2–4 days | $0 (free tier) | Good (Partykit *is* DOs under the hood — ironic) |
| Vercel + SSE/Redis Pub/Sub | 2–4 days | Function-seconds at scale | Acceptable |
| Vercel polling-only | 0.5 day | Bandwidth $$$ | Unacceptable |

---

## Things That Just Work on Vercel

- Svelte 5 + Vite SPA build → Vercel serves `dist/` natively (no `vercel.json` needed for SPA).
- `@upstash/redis` (drop the `/cloudflare` subpath).
- HTTP API routes — Hono runs on Vercel Functions via `@hono/vercel`.
- `executionCtx.waitUntil` → use `import { waitUntil } from '@vercel/functions'`.
- IP-based `getUserId` — Vercel exposes client IP via `x-forwarded-for` / `x-real-ip`.

---

## Concrete Migration Steps (Option A, sketch)

1. `npm i @hono/vercel @vercel/functions ably` (or chosen provider).
2. Move `src/worker.js` → `api/[[...path]].js`, export via `@hono/vercel` adapter.
3. Replace `import { Redis } from '@upstash/redis/cloudflare'` → `'@upstash/redis'`.
4. Delete `src/durable-objects/`, `wrangler.json`, `migrations`.
5. Replace `broadcastPixels()` to publish on Ably channel `canvas`.
6. Update client `src/client/...` to subscribe via Ably SDK instead of `new WebSocket('/api/ws')`.
7. Add `vercel.json` only if SPA fallback routing needs tweaking.
8. Remove `wrangler` from devDeps; add `vercel` CLI for local preview.
9. Move `wrangler secret` env vars → Vercel project env (Upstash creds + Ably key).
10. Run integration tests; the existing testcontainers Redis tests stay valid.

---

## Recommendation

**Don't migrate** unless there is a business/ops reason. The current Cloudflare stack is the right tool — DOs solve exactly the problem (single-room WS broadcast with stateful coordination) that rplace has, in fewer moving parts than any Vercel-shaped alternative.

If migration is mandatory, **Option A (Vercel + Ably or Partykit)** is the lowest-risk path. Plan for ~3 days of work, a new vendor relationship, and minor monthly cost.

---

## Unresolved Questions

1. What is driving the migration request? (Cost? Org consolidation? Curiosity?) The right answer changes per motivation.
2. Is Cloudflare Pages (Functions + DOs, Pages-style DX) acceptable as a middle ground?
3. Acceptable monthly budget for a managed realtime provider vs. function-seconds for SSE?
4. Are there latency requirements that rule out non-edge providers?

---

## Sources

- [Vercel Functions WebSocket Support (KB)](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- [Migrate to Vercel from Cloudflare (Vercel KB)](https://vercel.com/kb/guide/migrate-to-vercel-from-cloudflare)
- [Does Vercel Support WebSockets with Fluid Compute? (Vercel Community, 2025–2026)](https://community.vercel.com/t/does-vercel-support-websockets-now-that-we-have-fluid-compute/27205)
- [WebSockets on Vercel: Why Serverless Functions Can't Host Them (Ably)](https://ably.com/topic/ai-stack/websockets-on-vercel-why-serverless-functions-cant-host-them)
- [How We Built WebSocket Servers for Vercel Functions (Rivet, 2025-10)](https://rivet.dev/blog/2025-10-20-how-we-built-websocket-servers-for-vercel-functions/)
- [Cloudflare Durable Objects Overview](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Durable Objects vs Liveblocks Broadcast 2026 (Ably)](https://ably.com/compare/cloudflare-durable-objects-vs-liveblocks-broadcast)
- [Cloudflare Workers vs Vercel 2026 (Morph)](https://www.morphllm.com/comparisons/cloudflare-workers-vs-vercel)
