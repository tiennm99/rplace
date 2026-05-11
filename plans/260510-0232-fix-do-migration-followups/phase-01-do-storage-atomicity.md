---
phase: 1
title: "DO storage atomicity & correctness"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: DO Storage Atomicity & Correctness

## Overview
Fix the four correctness bugs in the Durable Object storage path: non-atomic multi-chunk writes, BLOB-grow data loss after canvas resize, cooldown burned on storage failure, and orphan-row crash on `/api/canvas`. Sanitize the 500 response body. Replace the bypassable `content-length` cap.

## Context Links
- Reports: `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md` (C3, H1, H2, H3, H5)
- Reports: `plans/reports/debugger-260510-0211-rplace-edge-cases.md` (C1, C2, M5)

## Key Insights
- "No `await` between statements" ≠ atomic. Each `sql.exec` auto-commits unless wrapped in `state.storage.transactionSync(...)`.
- `new Uint8Array(typedArray)` copies but preserves the source's length, so growing a short BLOB requires explicit re-allocation against `chunkSize(chunkId)`.
- Cooldown UPDATE must roll back if the subsequent write throws — otherwise transient storage flakes silently halve image-uploader throughput.

## Requirements

**Functional**
- Multi-chunk batch writes atomic: all chunks commit, or none do.
- After `CANVAS_WIDTH`/`CANVAS_HEIGHT` grow + redeploy, new pixels in the formerly-last chunk persist correctly.
- Cooldown row reverted when `writePixels` throws.
- `GET /api/canvas` returns 200 even with orphan `chunk_id ≥ CHUNK_COUNT` rows present (post-shrink).
- `POST /api/place` rejects requests with missing or zero `content-length` (or reads body with hard byte cap).
- 500 responses do not echo raw error message.

**Non-functional**
- No regression in happy-path latency (single-chunk batch).
- Static assertion `CHUNK_BYTES <= 2_000_000` near constants to prevent future BLOB-cell overflow.

## Architecture

```
worker.js (edge)
  ├─ guard: content-length present AND > 0 AND ≤ MAX_BODY_BYTES (else 413)
  └─ forwards to DO

CanvasRoom.placePixels  (canvas-room.js)
  ├─ tryAcquire(userId)  → reserves cooldown
  ├─ TRY:
  │    state.storage.transactionSync(() => writePixels(sql, edits))
  │    broadcast(edits)
  └─ CATCH:
       sql.exec('DELETE FROM cooldowns WHERE user_id = ?', userId)  // rollback
       return Response.json({ error: 'storage_failed' }, { status: 500 })
       // no message field; full err logged separately
```

`chunk-storage.writePixels` rewritten so `next` is sized to `chunkSize(chunkId)`, with `buf.subarray(0, min(buf.length, expected))` copied into it.

`chunk-storage.readAllChunks` filters `WHERE chunk_id < ?` bound to `CHUNK_COUNT`.

## Related Code Files

**Modify**
- `src/worker.js` — content-length validator (require > 0 OR switch to bounded `arrayBuffer`)
- `src/durable-objects/canvas-room.js` — wrap write in transactionSync, rollback cooldown on error, drop `message` from 500
- `src/durable-objects/lib/chunk-storage.js` — fix `writePixels` BLOB-grow, bound `readAllChunks`, replace `new Uint8Array(buf)` aliasing comment with `.slice()` or explicit allocation
- `src/lib/constants.js` — add static assertion for `CHUNK_BYTES`
- `src/durable-objects/canvas-room.js:119` — fix the inverted "pre-2026-04-07" comment (M2 in code-review)

**Create** — none

**Delete** — none

## Implementation Steps

1. **`chunk-storage.writePixels` BLOB-grow fix** (review C3)
   - In the per-chunk loop, compute `expected = chunkSize(chunkId)`.
   - `const next = new Uint8Array(expected); next.set(buf.subarray(0, Math.min(buf.length, expected)));`
   - Update inline comment: "size against chunkSize, never trust persisted blob length".

2. **`chunk-storage.writePixels` atomicity** (debugger C2)
   - Wrap the entire `for (const [chunkId, edits] of grouped)` block in `state.storage.transactionSync(() => { ... })`.
   - Verify `transactionSync` exists at compat date `2025-04-01`; if not, fall back to async `state.storage.transaction(async () => {...})` and propagate rejection.
   - Update the comment at L86-87 to describe the transactional invariant, not "no await".

3. **`chunk-storage.readAllChunks` orphan guard** (review H3)
   - Change SQL to `SELECT chunk_id, bytes FROM canvas_chunks WHERE chunk_id < ?` bound to `CHUNK_COUNT`.
   - Optional secondary defense: skip rows where `chunkId * CHUNK_BYTES + view.length > out.length`.

4. **`canvas-room.placePixels` cooldown rollback** (review H1, debugger C1)
   - Add try/catch around the `writePixels` call.
   - In catch: `sql.exec('DELETE FROM cooldowns WHERE user_id = ?', userId)`. Rethrow or return 500.
   - Add a one-line comment: `// refund cooldown so transient storage errors don't soft-DOS user`.

5. **500 response sanitization** (review H2)
   - Drop `message: String(err)` from the response JSON.
   - Keep the `console.error` call so debugging info stays in logs.

6. **`worker.js` content-length guard** (review H5)
   - Require `content-length` header present AND > 0 AND ≤ `MAX_BODY_BYTES`. Reject with 411 (length required) or 413 (too large).
   - Alternative: read raw body via `c.req.arrayBuffer()`, check `byteLength`, then `JSON.parse(decoder.decode(buf))`.

7. **Static `CHUNK_BYTES` cap assertion** (debugger M5)
   - At top of `constants.js` (or in a small init): `if (CHUNK_BYTES > 2_000_000) throw new Error('CHUNK_BYTES exceeds DO SQLite cell limit');`
   - Document compat-date-versioned cell limit in the comment.

8. **WS-close comment correction** (review M2)
   - `canvas-room.js:119` — replace misleading comment with: `// Required because compatibility_date 2025-04-01 predates the 2026-04-07 default-close cutoff. Remove if/when wrangler.json bumps past that date.`
   - Add try/catch around the `ws.close(...)` call to handle already-closed sockets (debugger M7).

9. **Compile + smoke**
   - `npm run build` — must pass.
   - Local `wrangler dev`, hit `POST /api/place` with a 2-pixel batch spanning 2 chunks; verify success.
   - Force a write error (e.g. temporarily throw inside `writePixels`); verify cooldown row deleted, 500 returned without raw message.
   - Hit `GET /api/canvas` after manually inserting an orphan row; verify 200.

## Todo List

- [ ] Implement BLOB-grow fix in `chunk-storage.writePixels`
- [ ] Wrap multi-chunk write in `transactionSync` (or async fallback)
- [ ] Bound `readAllChunks` query by `chunk_id < CHUNK_COUNT`
- [ ] Add cooldown rollback in `canvas-room.placePixels` catch path
- [ ] Drop `message` from 500 response
- [ ] Replace `content-length` guard with present+nonzero check or bounded body read
- [ ] Add `CHUNK_BYTES <= 2_000_000` static assertion
- [ ] Fix inverted WS-close comment + add try/catch
- [ ] `npm run build` passes
- [ ] Manual smoke: 2-chunk batch success
- [ ] Manual smoke: forced write error → cooldown refunded, no message leak
- [ ] Manual smoke: orphan row → `/api/canvas` 200

## Success Criteria

- [ ] No regressions in existing 94-test suite
- [ ] `transactionSync` (or async transaction) confirmed available at compat date 2025-04-01
- [ ] All bullets in Todo List checked
- [ ] PR includes file:line evidence linking each change to the originating finding

## Risk Assessment

- **Risk:** `transactionSync` not available at our compat date → fix back-compat.
  **Mitigation:** Verify via `wrangler` runtime docs first; fall back to `state.storage.transaction(async () => {...})` and ensure `placePixels` is awaited end-to-end.
- **Risk:** Cooldown rollback DELETE race against concurrent insert from same user.
  **Mitigation:** Single-DO is single-threaded per request; rollback runs synchronously before response. No lock needed.
- **Risk:** Bounded body read changes Hono request-handling shape; could break the existing tests.
  **Mitigation:** Keep `c.req.json()` if guard is sufficient; only refactor to `arrayBuffer()` if guard alone leaves a gap.

## Security Considerations

- 500 sanitization closes a low-severity info-leak.
- content-length guard removes a DOS-amplification vector against the JSON parser.
- Atomicity fix prevents broadcast/persistence divergence that could be probed for state inference.
