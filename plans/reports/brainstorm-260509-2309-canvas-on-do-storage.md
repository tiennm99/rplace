# Brainstorm Report: Canvas Storage on Cloudflare DO (Free-Tier, Scalable)

**Date:** 2026-05-09 23:09 (Asia/Saigon)
**Status:** Approved by user. Proceeding to `/ck:plan`.

---

## Problem Statement

Current rplace stack uses Upstash Redis for canvas (BITFIELD) + cooldown (SET NX EX). Goal: eliminate Upstash, move all state into the existing `CanvasRoom` Durable Object, while:

1. Staying inside Cloudflare Free Tier forever ($0/month).
2. Making future canvas size expansion a config change + redeploy (no migration code).
3. Migrating existing Upstash canvas data one-shot.

---

## Constraints (user-confirmed)

| Constraint | Value |
|---|---|
| Canvas target (1–2 yr) | 4096×4096 (no expansion planned) |
| Peak traffic | Hobby: 1–50 concurrent, <1 placement/sec |
| Resize behavior | Config change + redeploy; no live migration |
| Budget | $0 forever — hard constraint |
| Migration of existing data | One-shot import from Upstash → DO |

---

## Approaches Considered

### A. Single DO, all-in (chosen)
- DO owns canvas (chunked SQLite BLOB) + cooldown + WS broadcast
- Worker = thin validation/proxy
- ✅ Simplest, $0, no external deps
- ⚠️ Single-DO bottleneck — irrelevant at 50 users

### B. DO for WS only + Cloudflare KV for canvas
- KV stores 16 MB canvas (under 25 MB cap)
- ❌ Read-modify-write races, eventual consistency, KV write quotas
- Rejected: more complex than A, no benefit at this scale

### C. Worker + R2 + DO (hybrid)
- R2 for snapshots, DO for deltas
- ❌ Massive over-engineering for hobby canvas
- Rejected: YAGNI

**Decision: Approach A.**

---

## Final Design

### Architecture

```
Browser ──HTTP/WS──▶ Worker (Hono, thin proxy)
                          │
                          └─▶ CanvasRoom DO (idFromName('main'))
                                ├── canvas_chunks (SQLite BLOB rows)
                                ├── cooldowns      (SQLite TTL rows, lazy GC)
                                └── WebSocket hibernation hub
```

### SQLite Schema (inside DO)

```sql
CREATE TABLE canvas_chunks (
  chunk_id INTEGER PRIMARY KEY,
  bytes BLOB NOT NULL              -- exactly CHUNK_BYTES bytes
);

CREATE TABLE cooldowns (
  user_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL      -- ms epoch
);
CREATE INDEX idx_cooldowns_expires ON cooldowns(expires_at);
```

### Constants (drives "resize = redeploy")

```js
export const CANVAS_WIDTH  = 4096;
export const CANVAS_HEIGHT = 4096;
export const CHUNK_BYTES   = 65536;                                       // 64 KB
export const TOTAL_PIXELS  = CANVAS_WIDTH * CANVAS_HEIGHT;
export const CHUNK_COUNT   = Math.ceil(TOTAL_PIXELS / CHUNK_BYTES);       // 256
```

Resize: bump width/height → redeploy → DO lazy-inits missing chunks (zero-fill on first read).

### Worker → DO Routing

| Path | Worker action | DO method |
|---|---|---|
| `GET /api/canvas` | Forward to DO | `getFullCanvas()` returns concat of all chunks |
| `POST /api/place` | Validate body (size, pixel ranges, batch cap) → forward to DO with `userId` | `placePixels(userId, pixels)` does cooldown check + writes + broadcast in one transaction |
| `GET /api/ws` | Upgrade → forward to DO | `accept(ws)` |

### Why Chunked BLOB (not single 16 MB row)

- Batch of 2048 pixels touches typically 1–2 chunks → small UPDATE round-trips.
- Disjoint chunk reads are concurrent.
- Future spatial sharding (per-region DO) is a routing change, not a storage rewrite.

### Free Tier Math (peak hobby)

| Resource | Peak/day | Free quota | Headroom |
|---|---|---|---|
| Workers requests | ~87K (86K places + 500 fetch+ws) | 100K | 13% — tight |
| DO storage | ~16 MB | 1 GB | 60× |
| DO subrequests | ~86K | uncapped on free | ✓ |
| WS connections | ~50 | 32K/DO | ✓ |
| Bandwidth | trivial | unlimited | ✓ |

**Mitigation for tight Workers quota:**
- Edge cache on `/api/canvas` (`s-maxage=10`) absorbs repeat fetches.
- Pixel placements already batched up to 2048/request.
- WS messages don't count as Workers requests.

### One-Shot Migration (Upstash → DO)

Admin-only endpoint `POST /admin/import-canvas` (token-gated):
1. Worker: read full canvas from Upstash (existing `getFullCanvas` from old `canvas-storage.js`).
2. Forward bytes to DO via `room.fetch('/import', {body: bytes})`.
3. DO: split into N chunks, INSERT OR REPLACE all rows in one transaction.
4. Run once. Delete endpoint after migration completes.

---

## Scalability Levers (deferred, not built now)

1. **Bigger canvas** → bump constants. Up to ~32K×32K (1 GB DO cap).
2. **More writes/sec** → spatial sharding: one DO per region, worker routes by `chunk_id`. Chunk-ID abstraction already in storage layer makes this surgical.

YAGNI today; baked-in tomorrow.

---

## Risks

- **Workers req/day at 87% of cap on peak day.** Real but mitigated by edge cache.
- **Single DO = single region.** Same as today's Upstash setup; no regression.
- **Test suite rewrite.** testcontainers Redis tests → DO test helpers (Wrangler `unstable_dev` or Vitest CF pool). ~half day.
- **DO storage billing live since Jan 7, 2026.** Free tier still 1 GB/DO; monitoring needed if canvas grows beyond.

---

## Migration Plan (handed off to /ck:plan)

Phases will be derived by the planner. Rough breakdown for sizing:

1. Add DO storage layer (`canvas-storage` + `cooldown` modules inside DO)
2. Add DO methods (`getFullCanvas`, `placePixels`, `accept`)
3. Refactor Worker to thin proxy
4. One-shot import endpoint + run
5. Delete Upstash code paths + dependency
6. Rewrite tests for DO storage
7. Deploy + smoke test

---

## Success Criteria

- [ ] Zero Upstash references in `src/`
- [ ] `package.json` no `@upstash/redis`
- [ ] All existing tests pass against DO storage
- [ ] Canvas reads/writes verified in production
- [ ] WS broadcast still functional
- [ ] Resize procedure documented (bump constants → redeploy → verify)
- [ ] $0 monthly bill confirmed

---

## Unresolved Questions

None — all clarified during brainstorm.
