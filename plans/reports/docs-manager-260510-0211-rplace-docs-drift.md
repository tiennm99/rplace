# rplace Documentation Drift Audit
**Date:** 2026-05-10  
**Scope:** Verify docs alignment with recent Upstash → DO migration (commits a977adc through c3f7c02)  
**Methodology:** Cross-check README, docs/, package.json, wrangler.json, .env.example, and active plan against actual src/ tree

---

## Summary

**Migration Status:** Phases 1–4 complete (files deleted, dependencies removed). Phase 5 partial (deploy done, 7-day observation window).

**Drift Found:** 4 stale/misleading items in README.md and .env.example. Docs in `docs/` directory are **accurate and current**. Migration plan ready for archival.

---

## Drift Findings

### STALE — README.md Project Structure (Lines 79–111)

**Severity:** Stale (factually wrong)

**Current State:**
```md
src/
├── worker.js                          # ✓ exists
├── admin/
│   └── migrate-from-upstash.js        # ✗ DOES NOT EXIST (deleted in Phase 4)
├── durable-objects/                   # ✓ exists
│   ├── canvas-room.js                 # ✓ exists
│   └── lib/
│       ├── schema.js                  # ✓ exists
│       ├── chunk-storage.js           # ✓ exists
│       └── cooldown-store.js          # ✓ exists
├── lib/
│   ├── constants.js                   # ✓ exists
│   ├── canvas-decoder.js              # ✓ exists
│   ├── canvas-storage.js              # ✗ DOES NOT EXIST (deleted in Phase 4)
│   ├── redis-client.js                # ✗ DOES NOT EXIST (deleted in Phase 4)
│   ├── rate-limiter.js                # ✗ DOES NOT EXIST (deleted in Phase 4)
│   ├── image-uploader.js              # ✓ exists
│   └── get-user-id.js                 # ✓ exists
```

**Proposed Fix:**
Remove the entire `src/admin/` block and the three legacy lib files from the tree display:

```markdown
## Project Structure

```
src/
├── worker.js                          # Hono entry — thin proxy + edge validation
├── durable-objects/
│   ├── canvas-room.js                 # DO: storage + cooldown + WS hub
│   └── lib/
│       ├── schema.js                  # Idempotent CREATE TABLE
│       ├── chunk-storage.js           # BLOB chunk read/write
│       └── cooldown-store.js          # Rate-limit acquire + lazy GC
├── lib/
│   ├── constants.js                   # CANVAS_WIDTH/HEIGHT, CHUNK_BYTES, palette
│   ├── canvas-decoder.js              # Raw bytes → RGBA (client-side)
│   ├── image-uploader.js              # Browser-side batched uploader
│   ├── get-user-id.js                 # IP-based identity
│   ├── dither-kernels.js              # Dithering algorithms
│   ├── image-color-correction.js      # Color-space transform
│   ├── image-to-palette.js            # Quantization
│   ├── image-transform.js             # Scaling + rotation
│   ├── image-resize.js                # Image dimensions
│   ├── image-pipeline.js              # Multi-step image processing
│   ├── image-pipeline-client.js       # Client-side queue
│   ├── image-pipeline-worker.js       # Worker-side handler
│   ├── image-job-storage.js           # Job persistence
│   └── pixel-buffer.js                # Batch accumulator
├── client/
│   ├── main.js                        # Svelte mount
│   ├── App.svelte                     # Root + WebSocket
│   ├── app.css                        # Global styles
│   └── components/
│       ├── CanvasRenderer.svelte      # Canvas + zoom/pan + touch
│       ├── ColorPicker.svelte         # Favorites + 256-color grid
│       ├── CanvasControls.svelte      # Zoom buttons + coordinates
│       ├── DrawToolbar.svelte         # Paint / submit / undo / redo
│       └── ImageImporter.svelte       # Image-to-canvas uploader
└── index.html                         # Vite entry
```
```

**Reason:** Upstash files deleted in commit a977adc. Showing orphaned files confuses developers and suggests the migration is incomplete. Current tree is incomplete (missing image pipeline files); use actual tree from bash scan.

---

### MISLEADING — README.md API Section (Lines 146–151)

**Severity:** Misleading (technically exists but endpoint removed)

**Current Text:**
```markdown
### `POST /admin/migrate-from-upstash` (transitional)

Token-gated one-shot endpoint that pulls the canvas from a legacy Upstash
Redis instance and imports it into the Durable Object. Slated for removal
after the production migration completes (Phase 4 of
[`plans/260509-2309-canvas-on-do-storage`](plans/260509-2309-canvas-on-do-storage)).
```

**Proposed Fix:**
Delete this section entirely. The endpoint was removed in commit a977adc (Phase 4 cleanup). No need to document historical endpoints.

**Reason:** Endpoint no longer exists in worker.js. Documenting it as "slated for removal" when it's already removed is confusing. Developers might spend time looking for it.

---

### STALE — .env.example

**Severity:** Stale (now incorrect for setup)

**Current Content:**
```
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

**Proposed Fix:**
Delete file entirely or replace with a comment explaining that no external environment variables are required:

**Option A (Delete):** Remove `.env.example` — the repo has no external secrets now.

**Option B (Keep as placeholder):**
```
# No external secrets required.
# Canvas + cooldown state live inside CanvasRoom Durable Object (SQLite).
# All configuration is in src/lib/constants.js.
```

**Reason:** Current file references Upstash credentials that are no longer needed. New developers will be confused by empty placeholders for deleted services. Phase 4 success criteria explicitly calls for clean `.env.example`.

---

### ACCURATE — docs/ Directory

All docs files checked and found **accurate**:

- **canvas-resize-procedure.md** — correctly describes lazy-init, CHUNK_COUNT derivation, DO storage caps. No Upstash references.
- **deployment-guide.md** — migration section accurately marked `(Optional) One-Shot Migration from Upstash` with clear date context. No Upstash in main deploy flow.
- **system-architecture.md** — correctly describes CanvasRoom DO, SQLite schema, no Upstash. Migration endpoint marked "transitional" and "Removed in Phase 4".
- **code-standards.md** — does not reference Upstash or legacy code. Reflects current arch.
- **references.md** — informational only, no implementation details to drift.

---

## Cross-Check Results

### File Existence Verification

| File Reference | Status | Location |
|---|---|---|
| `src/worker.js` | ✓ Exists | Confirmed, 75 lines |
| `src/durable-objects/canvas-room.js` | ✓ Exists | Confirmed |
| `src/durable-objects/lib/schema.js` | ✓ Exists | Confirmed |
| `src/durable-objects/lib/chunk-storage.js` | ✓ Exists | Confirmed |
| `src/durable-objects/lib/cooldown-store.js` | ✓ Exists | Confirmed |
| `src/lib/constants.js` | ✓ Exists | Confirmed |
| `src/lib/canvas-decoder.js` | ✓ Exists | Confirmed |
| `src/lib/image-uploader.js` | ✓ Exists | Confirmed |
| `src/lib/get-user-id.js` | ✓ Exists | Confirmed |
| `src/admin/migrate-from-upstash.js` | ✗ Deleted | Removed in Phase 4 (a977adc) |
| `src/lib/canvas-storage.js` | ✗ Deleted | Removed in Phase 4 (a977adc) |
| `src/lib/redis-client.js` | ✗ Deleted | Removed in Phase 4 (a977adc) |
| `src/lib/rate-limiter.js` | ✗ Deleted | Removed in Phase 4 (a977adc) |

### Dependencies Verification

| Package | Current | Status |
|---|---|---|
| `@upstash/redis` | Not in package.json | ✓ Removed |
| `ioredis` | Not in package.json | ✓ Removed |
| `hono` | ^4.7.6 | ✓ Present, correct |
| `svelte` | ^5.28.2 | ✓ Present, correct |

### Configuration Verification

| Config Item | File | Status |
|---|---|---|
| DO binding name `CANVAS_ROOM` | wrangler.json line 11 | ✓ Matches docs reference |
| DO class `CanvasRoom` | wrangler.json line 12 | ✓ Matches src/durable-objects/canvas-room.js |
| SQLite migration tag `v1` | wrangler.json line 18 | ✓ Registered for CanvasRoom |

---

## Docs Directory Size Assessment

| File | Lines | Status |
|---|---|---|
| canvas-resize-procedure.md | 57 | ✓ Under 800 LOC limit |
| deployment-guide.md | 115 | ✓ Under 800 LOC limit |
| system-architecture.md | 165 | ✓ Under 800 LOC limit |
| code-standards.md | 51 | ✓ Under 800 LOC limit |
| references.md | 21 | ✓ Under 800 LOC limit |

---

## Plan Archive Status

`plans/260509-2309-canvas-on-do-storage/plan.md` marked `status: in-progress` but phases 1–4 complete and deployed to production.

**Proposed Action:** Update plan.md line 3 to `status: completed` (observing 7-day rollback window before archival).

---

## Unresolved Questions

1. **Image pipeline files** — README was outdated before audit (missing `image-pipeline.js`, `image-pipeline-client.js`, etc.). Was the tree intentionally simplified, or is it an ongoing drift issue unrelated to migration?

2. **.env.example strategy** — Are empty placeholder secrets (Option B) preferable to deletion (Option A) for discoverability?

---

## Recommended Actions (Priority Order)

1. **README.md line 85–97** — Remove `src/admin/` and three legacy lib files from project structure tree.
2. **README.md line 146–151** — Delete `/admin/migrate-from-upstash` API section.
3. **.env.example** — Delete or replace with placeholder comment.
4. **plans/260509-2309-canvas-on-do-storage/plan.md line 3** — Change `status: in-progress` → `status: completed` after 7-day window (ca. May 17, 2026).

---

**Status:** DONE  
**Summary:** 4 stale refs flagged (README tree + API section, .env.example, plan status). Docs directory accurate. No broken links or config mismatches. Ready for targeted edits.
