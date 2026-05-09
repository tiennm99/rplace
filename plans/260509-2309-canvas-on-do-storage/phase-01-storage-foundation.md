---
phase: 1
title: "Storage Foundation"
status: completed
priority: P2
effort: "3h"
dependencies: []
---

# Phase 1: Storage Foundation

## Overview

Add SQLite-backed storage modules consumable by the DO. Pure logic, no integration yet. Unit-testable in isolation.

## Requirements

**Functional:**
- Read/write canvas bytes via chunked BLOB rows.
- Read/write per-user cooldowns with lazy expiry GC.
- Lazy-initialize missing chunks (return zero-fill on read; INSERT on first write).

**Non-functional:**
- Pure functions / classes accepting `sql` interface — testable without a live DO.
- Write path: at most 1 transaction per `placePixels` call.
- O(touched_chunks) writes, not O(total_chunks).

## Architecture

Two new modules inside the DO directory:

- `src/durable-objects/lib/chunk-storage.js` — canvas chunk BLOB R/W, batch-aware
- `src/durable-objects/lib/cooldown-store.js` — user_id → expires_at SET-NX semantic

Constants stay in `src/lib/constants.js` but get new entries:

```js
export const CHUNK_BYTES   = 65536;                                       // 64 KB
export const CHUNK_COUNT   = Math.ceil(TOTAL_PIXELS / CHUNK_BYTES);       // 256
```

Schema (created in DO constructor via `sql.exec` if not exists):

```sql
CREATE TABLE IF NOT EXISTS canvas_chunks (
  chunk_id INTEGER PRIMARY KEY,
  bytes    BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id    TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at);
```

## Related Code Files

**Create:**
- `src/durable-objects/lib/chunk-storage.js`
- `src/durable-objects/lib/cooldown-store.js`
- `src/durable-objects/lib/schema.js` (CREATE TABLE statements, exported as a single `init(sql)` function)
- `test/unit/chunk-storage.test.js`
- `test/unit/cooldown-store.test.js`

**Modify:**
- `src/lib/constants.js` — add `CHUNK_BYTES`, `CHUNK_COUNT`

**Delete:** None this phase.

## Implementation Steps

1. Add `CHUNK_BYTES`, `CHUNK_COUNT` to `src/lib/constants.js`. Verify `CHUNK_COUNT = 256` for 4096×4096.
2. Write `schema.js` with idempotent `CREATE TABLE`/`CREATE INDEX` statements wrapped in single `init(sql)` export.
3. Write `chunk-storage.js`:
   - `readChunk(sql, chunkId) → Uint8Array(CHUNK_BYTES)` — zero-fill if missing.
   - `readAllChunks(sql) → Uint8Array(TOTAL_PIXELS)` — concatenated buffer.
   - `writePixels(sql, pixels)` — group by chunk_id, single transaction, UPDATE OR INSERT each touched chunk.
   - Helper: `pixelToChunk(x, y) → {chunkId, byteOffset}`.
4. Write `cooldown-store.js`:
   - `tryAcquire(sql, userId, ttlMs, now) → {allowed, retryAfter}` — INSERT OR FAIL pattern: if a non-expired row exists, return `{allowed:false}`; else upsert with `expires_at = now + ttlMs`.
   - `gc(sql, now)` — DELETE WHERE `expires_at < now`. Called opportunistically (e.g., 1% of acquires).
5. Write unit tests using `better-sqlite3` or equivalent in-memory SQLite (Vitest):
   - chunk-storage: write-then-read, partial-chunk write, batch across chunks, lazy zero-init.
   - cooldown-store: acquire success, acquire blocked, acquire after expiry, GC removes stale rows.
6. `npm test` — all green.

## Success Criteria

- [ ] `src/lib/constants.js` exports `CHUNK_BYTES`, `CHUNK_COUNT`
- [ ] `chunk-storage.js` and `cooldown-store.js` exist with documented exports
- [ ] Unit tests cover happy path + edge cases (lazy init, expiry, batch across chunks)
- [ ] `npm test` passes
- [ ] No imports from `@upstash/redis` in new modules

## Risk Assessment

| Risk | Mitigation |
|---|---|
| SQLite BLOB API differs in CF DO vs better-sqlite3 | Keep modules thin; integration test in Phase 2 confirms |
| Chunk boundaries off-by-one for non-power-of-2 sizes | `CHUNK_COUNT = ceil()` handles partial last chunk; test it |
| Cooldown table grows unbounded | Lazy GC + 1s TTL keeps rows ephemeral; index on expires_at keeps GC cheap |
