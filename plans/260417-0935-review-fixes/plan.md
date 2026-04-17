# Plan: Review-Fix Sweep (2026-04-17)

Fixes for issues from `/ultrareview` reports:
- `plans/reports/code-review-260417-0926-backend.md`
- `plans/reports/code-review-260417-0926-frontend.md`
- `plans/reports/tester-260417-0927-test-suite.md`

## Status: COMPLETE — 76/76 unit tests pass; vite build OK.

## Backend fixes

| ID | File | Change |
|---|---|---|
| C1, C2 | `src/lib/rate-limiter.js` | Switch `lu` to ms precision. `retryAfter` now in seconds via `ceil(deficit * msPerCredit / 1000)`. Fractional regen handled (cap-aware lu advancement preserves sub-credit residue). |
| NH1 | `src/lib/redis-client.js` | `redisRaw` / `redisRawBinary` throw on Upstash 200-with-`error` envelope. `redisRaw` now returns `body.result` (was full envelope). |
| NC2 | `src/lib/constants.js` | `MAX_BATCH_SIZE = MAX_CREDITS = 256` (was 512 vs 256 mismatch). |
| NC2+L4 | `src/worker.js` | Early `Content-Length` reject (>16KB) before parsing JSON. |
| NH2 | `src/lib/canvas-storage.js` | `console.warn` on truncated canvas read instead of silent zero-pad. |
| H4 | `src/worker.js` | Bumped `s-maxage` 1→10, `stale-while-revalidate` 5→30. Manual gzip via `CompressionStream` when `Accept-Encoding: gzip`. `Vary: Accept-Encoding`. |
| H5 | `src/worker.js` | Broadcast moved to `c.executionCtx.waitUntil(broadcastPixels(...))` with `r.ok` check + error log. Resilient when `executionCtx` absent (test env). |
| H1, H2 | `src/lib/get-user-id.js` | SHA-256 (16 hex chars) replaces 32-bit string hash. Missing `cf-connecting-ip` → `anon:dev` shared bucket + `console.warn`. Function is now async — `worker.js` awaits. |
| NH4, N5 | `src/durable-objects/canvas-room.js` | Constructor now `(state, env)`. `webSocketClose` logs unclean disconnects. `webSocketError` logs error message. `webSocketMessage` defensively closes (1003) on unexpected client message. |

## Frontend fixes

| ID | File | Change |
|---|---|---|
| NC2 | `CanvasRenderer.svelte`, `App.svelte` | `addToStroke` blocks when `buffer.pixelCount + currentStrokeKeys.size >= MAX_BATCH_SIZE` (only if pixel isn't already buffered). New `onBufferFull` callback shows toast in App. |
| NC1 | `App.svelte` | `handleSubmit` shows toast on 429 (with `retryAfter`), 413, 400, 5xx, network error. `commitPending` only on `data.ok === true`. Single `toast` state with auto-dismiss. |
| NC3 | `CanvasRenderer.svelte` | `committedColors` allocated as zero-filled `Uint8Array` upfront (was `null` until fetch). Replaced after fetch. WS updates during initial fetch no longer null-deref. |
| C1, C2 | `CanvasRenderer.svelte` | `render(effZoom = zoom)` accepts explicit zoom. `handleWheel` always calls `render(newZoom)` after pan mutation, fixing the clamped-zoom no-render case. Touch pinch-zoom branch same. |
| C3 | `src/lib/canvas-decoder.js` | Throws on `buffer.byteLength < EXPECTED_BYTES` instead of silently `\|\| 0` reading past end. |
| C4 | `App.svelte`, `CanvasRenderer.svelte` | `isReconnect` flag in App; `canvasRenderer.refetchCanvas()` exported and called on reconnect `onopen`. Recovers pixels missed during disconnect. |
| NH1 | `src/lib/pixel-buffer.js` | Internal `Map<key,color>` cache. O(1) `getColorAt`, `pixelCount`, `getAffectedKeys`, `getAllPixels`. Invalidated on `addStroke/undo/redo/clear`. |
| NH3 | `CanvasRenderer.svelte` | `$effect(() => { mode; ... })` calls `cancelStroke()` (restores pixels, clears state) on mode change. No more dangling-stroke merge across modes. |
| NH5 | `CanvasRenderer.svelte` | `loadError` state + retry button overlay on initial fetch failure. |
| H1 | `CanvasRenderer.svelte` | DPR-aware sizing: `canvasEl.{width,height} = innerSize * dpr` + CSS sets logical size. `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` in render before pan/zoom. |
| H2 | `CanvasRenderer.svelte` | `onMount` is now sync; cleanup returns sync fn. `loadCanvas()` runs in background. Resize listener cleanup no longer leaks across HMR. |
| Touch | `CanvasRenderer.svelte` | Single-finger touch move now calls `onCursorMove` (was only mouse). |
| Defensive | `App.svelte` | `handleKeyDown` skips when target is `<input>/<textarea>/[contenteditable]`. |

## Test additions / updates

| File | Change |
|---|---|
| `test/lib/canvas-decoder.test.js` | Pad inputs to full canvas size. Added `throws on truncated buffer` test. |
| `test/lib/get-user-id.test.js` | Async/await all calls. Asserts `anon:dev` for missing header + 16-hex-char suffix shape. |
| `test/lib/redis-client.test.js` | Updated error message expectations to `Redis HTTP`. Added `Upstash 200 with error envelope` test (verifies NH1 fix). |

## Issues NOT addressed (intentionally deferred)

- **NC1 backend (wrangler `v1` migration tag reuse)** — left as-is; requires confirmation of whether DO has been deployed under `v1` with `new_classes` previously. If never deployed, current state is correct. If deployed, requires `v2` migration coordinated with Cloudflare (out-of-band decision).
- **M3 (BITFIELD u5 overflow guard inside setPixels)** — input already validated in worker; redundant guard skipped per YAGNI.
- **M5 (CORS / security headers)** — separate cross-cutting change; would prefer a Hono `secureHeaders` middleware in a follow-up.
- **M6 / NH4 nit (compatibility_date bump)** — leaving compat date `2025-04-01`; pre-auto-close path still works correctly.
- **Frontend tests** — no Svelte component test framework added in this sweep; core logic (`pixel-buffer`, `canvas-decoder`) covered by unit tests.
- Various M/L/N items from reports — KISS / scope.

## Verification

- `npm test` → 7 files / 76 tests pass.
- `npm run build` → vite production build succeeds (51.98 kB JS, 19.65 kB gzipped).
- Integration tests still skipped on Windows CI (Docker unavailable).

## Unresolved questions

1. NC1: confirm whether worker has ever been deployed (decides v1→v2 migration need).
2. Should `MAX_CREDITS` ever be raised (256 may be too restrictive for batch drawing UX)?
3. Add CI workflow file (`.github/workflows/test.yml`) to enforce tests on PR? (not done in this sweep)
