---
phase: 3
title: "One-Shot Upstash Migration"
status: completed
priority: P2
effort: "2h"
dependencies: [2]
---

# Phase 3: One-Shot Upstash Migration

## Overview

Copy production canvas bytes from Upstash Redis into the DO's SQLite chunks. Run once, verify, schedule removal. The migration endpoint is token-gated and short-lived — it exists for one execution, then deleted in Phase 4.

## Requirements

**Functional:**
- Admin endpoint `POST /admin/migrate-from-upstash` reads full canvas from Upstash via existing `getFullCanvas` (kept in `lib/legacy-upstash-storage.js` for this phase) and forwards bytes to DO `/import`.
- DO `POST /import` accepts a 16 MB body, splits into 256 chunks, INSERT OR REPLACE all rows in single transaction.
- Endpoint is gated by a `MIGRATION_TOKEN` env var; reject if missing/wrong.
- Idempotent: running twice yields the same final state.

**Non-functional:**
- Migration completes in <30s (well under DO timeout).
- Pre-flight checks: refuse to run if `canvas_chunks` already non-empty (unless `?force=1`).
- Verification step: known coordinate roundtrip post-migration.

## Architecture

### Endpoint flow

```
curl -X POST $WORKER_URL/admin/migrate-from-upstash \
     -H "Authorization: Bearer $MIGRATION_TOKEN"
```

Worker:
1. Verify `Authorization` header matches `c.env.MIGRATION_TOKEN`.
2. Read full canvas from Upstash via legacy module (existing 4-chunk GETRANGE).
3. POST raw bytes to DO `/import`.
4. Verify by reading back a known coordinate from DO and comparing.
5. Return JSON `{imported_bytes, sample_check_passed}`.

DO `/import`:
1. Read body as `Uint8Array` (length must equal `TOTAL_PIXELS`).
2. Pre-flight: if any rows exist and no `?force=1`, return 409.
3. Open transaction; for each chunk index 0..CHUNK_COUNT-1, slice the buffer, `INSERT OR REPLACE INTO canvas_chunks`.
4. Commit. Return 200.

### Files

```
src/lib/legacy-upstash-storage.js   ← copy of old canvas-storage.js, used only by migration
src/admin/migrate.js                 ← admin route handler
src/worker.js                        ← mount admin route under /admin/*
```

## Related Code Files

**Create:**
- `src/lib/legacy-upstash-storage.js` (renamed from old `lib/canvas-storage.js` — keep Upstash dependency until Phase 4)
- `src/admin/migrate.js`
- `src/durable-objects/lib/migration-import.js` (DO-side `/import` handler logic)

**Modify:**
- `src/worker.js` — mount `/admin/*` route, add MIGRATION_TOKEN check
- `src/durable-objects/canvas-room.js` — handle `/import` path
- `wrangler.json` — add `MIGRATION_TOKEN` to `vars` placeholder (real value via secret)

**Delete:** None this phase.

## Implementation Steps

1. Copy current `src/lib/canvas-storage.js` (Upstash version) → `src/lib/legacy-upstash-storage.js`. Rename exports if needed to avoid clash.
2. Add `wrangler secret put MIGRATION_TOKEN` (random 32 bytes hex).
3. Implement `src/admin/migrate.js`:
   - Auth check.
   - Read all bytes via `legacy-upstash-storage.getFullCanvas(env)`.
   - POST to `room.fetch('http://internal/import', {method:'POST', body: bytes})`.
   - Sample check: pick a coordinate that's likely set (e.g., `(0,0)`, `(2000,2000)`), read post-migration DO canvas, compare.
   - Return JSON with stats.
4. Implement DO `/import` path in `canvas-room.js` using `migration-import.js`:
   - Validate body length.
   - Pre-flight check (refuse if non-empty unless force).
   - Transactional bulk insert.
5. Local test: seed local Upstash with known pattern (test pixel at known coords), run migration against local wrangler dev, verify pixel readable from new DO.
6. Production run:
   - Deploy current branch to staging or use `wrangler dev --remote`.
   - `curl -X POST -H "Authorization: Bearer $TOKEN" $URL/admin/migrate-from-upstash`.
   - Verify `sample_check_passed: true`.
   - Browser smoke test: visible canvas matches pre-migration.
7. **Do not delete Upstash data yet.** Keep for 7 days as rollback safety.

## Success Criteria

- [ ] Migration endpoint requires valid `MIGRATION_TOKEN`
- [ ] Local migration: canvas_chunks count == CHUNK_COUNT after import
- [ ] Local migration: sample pixel at known coordinate matches pre-migration value
- [ ] Idempotency: re-running with `?force=1` yields same state
- [ ] Production migration successful (run once, log retained)
- [ ] Pre-migration screenshot vs post-migration screenshot identical (visual diff)

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Migration corrupts canvas | Pre-flight refuses to overwrite unless `?force=1`; keep Upstash data 7 days |
| Token leaked in logs | Use `Authorization` header (less likely logged than query string); rotate after migration |
| Body size 16 MB exceeds worker request limit | CF Workers request body cap is 100 MB on free tier; 16 MB fits |
| Partial migration (network failure mid-way) | Transactional bulk insert in DO; either all chunks committed or none |
| Sample-check coordinate happens to be unset (0,0) | Use multiple sample coordinates; require ≥1 known-set coordinate to pass |
