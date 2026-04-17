# Frontend Code Re-Review — rplace (post commit e0cf802)

**Date:** 2026-04-17
**Scope:** Frontend re-review after batch-drawing rewrite + 9 other commits
**Files reviewed:** App.svelte, CanvasRenderer.svelte, DrawToolbar.svelte (NEW), pixel-buffer.js (NEW), ColorPicker.svelte, CanvasControls.svelte, UserInfo.svelte, canvas-decoder.js, constants.js
**Reviewer mode:** adversarial — verify prior findings + scrutinize new batch-drawing flow
**Prior report:** code-review-260417-0919-frontend.md

---

## Prior Findings Status

| ID | Severity | Status | Evidence |
|---|---|---|---|
| C1 | Critical | **Unchanged** | `pan = { x: 0, y: 0 }` (CanvasRenderer:13) still plain object. All mutation sites (172-173, 180-181, 206-207, 252-254, 263-266) still rely on explicit `render()`. New `handleWheel` (206-207) mutates `pan` but `render()` only fires through `$effect(() => { zoom; render(); })` (285) — same problem. |
| C2 | Critical | **Unchanged** | `handleWheel` (202-209) still mutates pan then calls `onZoomChange(newZoom)`. If newZoom equals current zoom (clamped at 0.25 / 64), `$effect` does not re-run → pan changes are not rendered. No explicit `render()` at end of handler. |
| C3 | Critical | **Unchanged** | `canvas-decoder.js:18` identical: `(bytes[byteIndex] << 8 | (bytes[byteIndex + 1] || 0))`. No `buffer.byteLength === Math.ceil(totalPixels * 5 / 8)` check at top of `decodeCanvas`. Caller (CanvasRenderer:296-308) catches errors but does not surface to UI. |
| C4 | Critical | **Unchanged** | `App.svelte:46-50` only resets `wsRetryDelay` on `onopen`. No `isReconnect` flag. No call to `canvasRenderer.refetchCanvas()` (method doesn't exist). After WS reconnect, drift persists until full page reload. |
| H1 | High | **Unchanged** | `CanvasRenderer.svelte:289-290` still `canvasEl.width = window.innerWidth; canvasEl.height = window.innerHeight;`. No `devicePixelRatio` handling, no `ctx.scale(dpr, dpr)`, no separate CSS sizing. Blurry on Retina. |
| H2 | High | **Unchanged** | `onMount(async () => { ... return () => window.removeEventListener('resize', resize); })` (287-311). Returned cleanup is inside async — Svelte receives a `Promise<fn>`, not the fn. Resize listener leaks on remount/HMR. |
| H3 | High | **Unchanged** | `App.svelte:21-28` still naïve `setInterval(..., 1000)` without `lastTickTimestamp` math. No `visibilitychange` handler. Tab-inactive drift persists. Comment at line 20 ("server corrects on submit") acknowledges drift but does not fix the UI lie. |
| H4 | High | **Regressed (in different direction)** | New `handleSubmit` (App:73-101) catches errors but only `console.error` / `console.warn`. No toast/banner. New failure mode: on rejected submit, `commitPending()` is NOT called — pending pixels stay in buffer, `submitting` resets to false, but user sees no error message. Worse than before because the user has potentially placed *many* pixels via batch and they all silently fail to commit. |
| H5 | High | **Fixed (architecture change)** | Optimistic credit deduction removed entirely. `placePixel` no longer exists; pixels accumulate in `pixelBuffer` locally. Credits only decremented on successful submit (App:91 `credits = data.credits` from server). Race no longer possible. New trade-off: client never gates "is this batch affordable?" client-side — server may reject entire batch. See N1 below. |
| H6 | High | **Unchanged** | `ColorPicker.svelte:8-17` identical. Still no `role="radiogroup"`, no roving tabindex, no arrow-key handler, no `aria-pressed`/`aria-checked`, no `:focus` style. |
| H7 | High | **Unchanged** | `handleTouchStart`/`handleTouchMove` (CanvasRenderer:223, 240) still call `e.preventDefault()` unconditionally. Same trade-off discussion applies. |
| H8 | High | **Partially Fixed** | Long-press-to-place still in `handleTouchEnd` (276-281) without visual indicator. Movement threshold still 4px (245). Touch start still records time (226), but no progress UI shown during the 300ms wait. *However*, draw mode (drag-to-draw, 247-250) now provides a clear alternative for mobile — users wanting to place multiple pixels can switch to draw mode and just drag. Reduces severity of H8 in practice. |

---

## New Critical Findings (Batch Drawing Flow)

### NC1 — Submit failure leaves buffer + UI in inconsistent state with no recovery
**File:** `src/client/App.svelte:73-101`
**What:** On HTTP error (network, 500), or `data.ok === false` (rate_limited, batch_too_large, invalid_pixel, storage_failed), code logs to console and resets `submitting = false`. Pending pixels stay in buffer. Credits not updated. User sees their pixels still drawn locally with the Submit button re-enabled but no indication anything went wrong.
**Specifically broken paths:**
- `429 rate_limited`: server returns `{ retryAfter, remaining }` — both ignored. User can immediately re-click Submit and get rejected again in a loop.
- `400 batch_too_large`: returned when `pixels.length > 512`. Buffer can grow unbounded (see NC2). User clicks Submit, gets silent reject, pixels still pending forever.
- `400 invalid_pixel`: should be impossible if client validates, but server returns `pixel: p` so client could surface bad-pixel info.
- Network/timeout: `catch (err)` — buffer state preserved but no retry UX.
**Why it matters:** With per-pixel placement (old flow) the cost of failure was 1 pixel. With batch drawing, a single failed Submit can lose hundreds of pixels of work that the user thinks they've saved. In a multi-user scenario, those pending-but-not-submitted pixels also block WS pixel updates from other users at those coords (line 98 of CanvasRenderer: `if (buffer.getColorAt(x, y) < 0 && !currentStrokeKeys.has(...))`) — so the user is staring at a stale local view.
**Fix:** Add error toast/banner UI (single text element + state). On 429 honor `retryAfter` (disable Submit button, countdown). On 400 surface error code. On 500/network preserve buffer and show "Submit failed — try again". Consider `commitPending()` only the successfully accepted pixel range if server returns partial-accept (server currently doesn't, but should — see UQ4).

### NC2 — Pixel buffer is unbounded — memory & client-side batch-size violation
**File:** `src/lib/pixel-buffer.js`, `src/client/components/CanvasRenderer.svelte:74-90`
**What:** No client-side check on buffer size. `addToStroke` keeps appending to `currentStroke` until `mouseup`/`touchend`. `addStroke` keeps pushing to `strokes` array. User in draw mode can drag for 30 seconds covering 100k+ pixels (a full-canvas swipe at 1x zoom hits 2048×2048 = 4M coords — `addToStroke` dedupes via `currentStrokeKeys` so realistic cap is `CANVAS_WIDTH * CANVAS_HEIGHT = 4M` unique pixels, eating ~64MB just for the Set keys).
**Concrete failure:** User drags across canvas to draw a long line. `currentStrokeKeys` is a `Set` of integers. After 100k pixels it's ~3-5MB. `currentStroke` is array of `{x, y, color}` objects — ~4MB. Then `buffer.addStroke` deep-copies via `[...pixels]` (pixel-buffer.js:13) → another 4MB. `getAllPixels()` builds another Map → another 4MB. Then `JSON.stringify` for fetch body → ~5MB string. Server has `MAX_BATCH_SIZE=512` so this is rejected with `batch_too_large` after burning all that memory and bandwidth.
**Worse:** `pixel-buffer.js:71-77 pixelCount` getter rebuilds a Set on EVERY access. The toolbar shows `pixelCount` reactively, so every reactivity tick (and there are many during a draw stroke) rebuilds the Set. O(N×M) where N=strokes, M=pixels per stroke.
**Why it matters:** Memory exhaustion on long draws. Failed submits with no recovery (NC1 compounds). Janky UI from O(N×M) `pixelCount`.
**Fix:**
1. Cap `currentStrokeKeys.size` at `MAX_BATCH_SIZE` (512). When reached, `addToStroke` early-returns or auto-finishes the stroke.
2. Cap total `buffer.pixelCount` at `MAX_BATCH_SIZE`. Disable drawing when full. Show warning in toolbar.
3. Cache `pixelCount` in pixel-buffer, invalidate on `addStroke`/`undo`/`redo`/`clear`.
4. Match client batch limit to server's `MAX_BATCH_SIZE` from constants (currently 512). Import and use it explicitly: `if (buffer.pixelCount >= MAX_BATCH_SIZE) return;`.

### NC3 — `committedColors` accessed before fetch completes — null deref
**File:** `src/client/components/CanvasRenderer.svelte:71, 96, 127, 137, 300`
**What:** `committedColors = null` initially, only assigned at line 300 inside `onMount`'s async fetch block. If WS message arrives before initial fetch completes (race condition: WS opens fast, canvas fetch takes >fetch-time), `applyUpdates` (94-103) writes to `committedColors[...]` — null deref → TypeError → unhandled. The `catch` in `connectWebSocket`'s `ws.onmessage` (App:43) silently swallows JSON parse errors but NOT this TypeError because it's outside the `try { JSON.parse ... }` block.

Wait — re-read App:37-44: the `try { ... } catch { /* ignore */ }` wraps the entire onmessage including `canvasRenderer.applyUpdates(...)`. So the error IS swallowed. But that means the WS update is silently dropped, and `committedColors` is never updated for that coord — drift on those pixels until next fetch.

Same null-deref in `restorePixel` (71), `clearPending` (127), `commitPending` (137) — all assume `committedColors` exists. None can be triggered before mount completes (they're only called via user interaction, which presumably comes after load), but there's no defensive check.
**Why it matters:** WS pixel updates that arrive during initial canvas load are silently dropped. Drift after page load if other users are actively placing.
**Fix:** Initialize `committedColors = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT)` at top, OR queue WS updates until fetch completes, OR guard `applyUpdates` early-return: `if (!committedColors) { pendingUpdates.push(pixels); return; }` and replay in onMount.

---

## New High Findings

### NH1 — `pixelCount` getter is O(N×M) on every access; called reactively from App.svelte
**File:** `src/lib/pixel-buffer.js:71-77`, `src/client/App.svelte:15, 132`, `src/client/components/CanvasRenderer.svelte:62-66`
**What:** `notifyBuffer` (CanvasRenderer:62) constructs `{ pixelCount: buffer.pixelCount }` on every stroke addition/undo/redo/clear/commit. The getter rebuilds a `Set` from all strokes' all pixels. `addToStroke` calls `notifyBuffer` indirectly (no — actually only `finishStroke` calls it). OK then — only fires on stroke completion, not per-pixel. But `getColorAt` (51-58) IS called per applyUpdate per pixel (CanvasRenderer:98), and IS O(N×M).
**Why it matters:** WS broadcast of 100 pixels with N=20 strokes of M=50 pixels each → 100 × 20 × 50 = 100k iterations per WS message.
**Fix:** Maintain a `Map<key, color>` inside pixel-buffer cached on stroke add/undo/redo. `getColorAt` becomes O(1). Same data also serves `getAllPixels` and `pixelCount`.

### NH2 — Undo/redo loses strokes silently when WS update arrives at affected coords
**File:** `src/client/components/CanvasRenderer.svelte:94-103, 105-119`
**What:** Scenario: user draws stroke at (100,100) red. WS broadcast arrives saying another user placed (100,100) blue. Code path:
1. `applyUpdates` line 96: `committedColors[idx] = blue` ✓
2. Line 98: `buffer.getColorAt(100, 100)` returns red (pending) → branch NOT taken → display stays red ✓ (correct — don't overwrite user's pending).
3. User clicks Undo. `undo()` line 105: pops stroke, calls `restorePixel(100, 100)`.
4. `restorePixel` line 69-72: `pending = buffer.getColorAt(100, 100)` returns -1 (we just popped the stroke). Falls through to `committedColors[idx]` = blue. Display becomes blue. ✓ Correct! Blue is the truth.

Actually OK — the design works. But: what about Redo? User Redo's the stroke. `redo()` line 113-119: re-applies stroke as red. Display becomes red (pending). On submit, server gets red, accepts, broadcasts red, `commitPending` sets `committedColors[idx] = red`. Now red is committed. The blue pixel from the other user is *lost* — we wrote red over it. Server's authoritative state will accept this (server doesn't know about the conflict).

**Why it matters:** Last-write-wins is the server's policy, so the conflict outcome is "correct by spec". But there's no UI signal of the conflict. User undid → saw blue pixel appear → redid → red comes back without warning that they're overwriting someone else's pixel.
**Fix:** Optional. Could mark stroke pixels as "stale" if WS update arrived during pending state. Show indicator. Likely Won't Fix — last-write-wins is canonical r/place behavior.

### NH3 — Mode switch mid-stroke leaves dangling state
**File:** `src/client/App.svelte:13, 125`, `src/client/components/CanvasRenderer.svelte:74-90, 145-198, 240-282`
**What:** User in draw mode is mid-drag (mouse held down, currentStroke populated). Clicks DrawToolbar `Paint` button. `mode` prop changes. Next mousemove (e.buttons & 1) goes through `handleMouseMove` line 165 → `mode === 'paint'` so falls into pan branch → `pan.x += dx`. The `currentStroke` array is now orphaned — never finished, never cleared. On mouseup, `handleMouseUp` line 188-198: `mode === 'paint'` (now), `!dragging` (depends), so falls into the place-single-pixel branch which calls `addToStroke` then `finishStroke` — but `finishStroke` line 84-90 commits whatever's in `currentStroke` (which contains the abandoned draw-mode pixels) PLUS the new paint pixel as a single combined stroke.
**Why it matters:** User intent violated. Pixels they thought they were panning over (after switching to paint) get committed as if drawn. Possibly hundreds of pixels.
**Fix:** In a `$effect(() => { mode; ... })` watcher in CanvasRenderer, finish any in-progress stroke when mode changes. Or expose `cancelStroke()` and call from App on mode change.

### NH4 — Touch handlers omit `cursorPos` updates AND don't update `committedColors` properly across mode switches
**File:** `src/client/components/CanvasRenderer.svelte:223-282`
**What:** Touch handlers never call `onCursorMove` (consistent with M6 prior unfixed). Coordinates display stays at (0,0) on mobile. Also: `handleTouchEnd` (273-282) calls `finishStroke` whenever mode is draw — even if no pixels were added (e.g., touchstart on an OOB coord, or user just panned with one finger after starting in draw mode). Empty stroke is no-op (line 85 early return) so OK. But: in pinch (touches=2, line 233-237) it calls `finishStroke` if `currentStroke.length` — defensive, good.

However: in two-finger pinch (line 257-270), no `finishStroke` after — if user started with one finger drawing (added stroke), then put down second finger to pinch-zoom, then released both, `handleTouchEnd` fires with `e.changedTouches.length` = 2 typically. The check `e.changedTouches.length === 1` (line 276) means no finishStroke for the long-press case. And `mode === 'draw'` calls finishStroke unconditionally on line 274 — which IS called regardless of changedTouches count. OK.

Actually wait — line 273: `handleTouchEnd(e)` — `mode === 'draw'` → `finishStroke()` always. Includes the pinch case where `currentStroke` was already finished at line 234. Empty `currentStroke` so finishStroke is a no-op. OK.

The real issue: `handleTouchEnd` does not preventDefault (only handlers 223, 240 do). If end fires and mode is draw and finishStroke was empty, no harm. But missing cursorPos update is real.
**Fix:** Add `onCursorMove` calls to `handleTouchMove` (single-finger branch).

### NH5 — Decoder error in onMount swallowed; loading set false → blank canvas with no error
**File:** `src/client/components/CanvasRenderer.svelte:296-308`
**What:** `try { fetch + decode } catch { console.error } finally { loading = false }`. On any failure (network, decoder throw, JSON parse), `imageData` stays null, `committedColors` stays null. Loading overlay disappears. User sees blank dark canvas. Mouse handlers no-op (setPixelRgba early returns when !imageData). User has no idea what's wrong. Equivalent to prior N2.
**Why it matters:** Same as before but compounds with NC3 (committedColors null) — drawing in draw mode silently does nothing.
**Fix:** Add error state, show retry button, disable interactivity when in error state.

---

## New Medium Findings

### NM1 — `getAffectedKeys` and `pixelCount` both rebuild Sets — duplicate work in `clearPending`
**File:** `src/client/components/CanvasRenderer.svelte:121-131`, `src/lib/pixel-buffer.js:60-67, 71-77`
**What:** `clearPending` calls `buffer.getAffectedKeys()` (rebuilds Set) then `buffer.clear()` then `notifyBuffer()` which reads `buffer.pixelCount` (rebuilds Set). Two full traversals of the strokes array.
**Fix:** Pre-compute `affectedKeys` from the cached map (NH1 fix).

### NM2 — `currentStrokeKeys` size cap missing → memory pressure on long strokes
**File:** `src/client/components/CanvasRenderer.svelte:74-82`
**What:** Same root cause as NC2 but specific to mid-stroke. `currentStrokeKeys` Set grows unbounded. Add cap.

### NM3 — Coordinate data type confusion (`buffer.getColorAt` returns -1 sentinel)
**File:** `src/lib/pixel-buffer.js:51-58`, `src/client/components/CanvasRenderer.svelte:70-71, 98`
**What:** Returns -1 sentinel for "not pending". Caller uses `pending >= 0` check — OK, but loses the distinction between "pending color 0" (which is valid: `0` is dark red `#6d001a`). Wait — color indices are 0-31, all valid. -1 is fine as sentinel since outside range. But code at line 71: `pending >= 0 ? pending : committedColors[...]` — if `pending` is exactly 0 (color 0), `0 >= 0` true, uses 0. ✓ Correct. False alarm.

But: `getColorAt` is O(strokes × pixels-per-stroke). Already noted in NH1.

### NM4 — `handleSubmit` does not handle non-2xx HTTP statuses correctly
**File:** `src/client/App.svelte:79-95`
**What:** `await fetch(...)` resolves with `Response` regardless of status. Code reads `text` then tries `JSON.parse`. If server returns plain-text 502 from a proxy, `JSON.parse` throws, catch logs and `return`. But `submitting` is in the outer `finally` (98-100) so resets correctly. Buffer untouched. Same NC1 issue: silent. No `res.ok` check.
**Fix:** `if (!res.ok) { showError(`HTTP ${res.status}`); return; }`. Then parse JSON.

### NM5 — Submit button can be clicked again immediately after submitting=false; no debounce
**File:** `src/client/App.svelte:73-101`, `DrawToolbar.svelte:25`
**What:** `submitting` flag prevents double-click during in-flight fetch. After resolve/reject, `submitting=false` immediately. If user double-clicks fast and request is fast (50ms), second click could fire after `submitting=false` set but before user notices first response. With successful first submit, `commitPending()` clears buffer, second click hits `if (!pixels?.length) return` at line 75 — safe. With failed first submit (NC1), buffer NOT cleared — second click resends same batch. Probably OK semantics (re-submit), but could double-charge credits if server accepts on second try after rejecting on first (race in server-side credit math). Server-side rate-limiter is atomic Lua so safe.
**Fix:** Add cooldown (200ms) after submit complete before re-enabling Submit button. Or only disable while submitting + during HTTP-429 retry-after window.

### NM6 — Keyboard shortcut Ctrl+Z works during text input
**File:** `src/client/App.svelte:62-70`
**What:** `<svelte:window onkeydown={handleKeyDown} />` listens globally. Currently no text inputs exist in the UI, so safe. But if a future feature adds an `<input>` (username, search), Ctrl+Z would intercept and break native undo in that input.
**Fix:** Defensive: `if (e.target.matches('input, textarea')) return;` early.

### NM7 — `mode` prop change doesn't update cursor style reactively in a clean way
**File:** `src/client/components/CanvasRenderer.svelte:328`
**What:** `style="cursor: {mode === 'draw' ? 'crosshair' : dragging ? 'grabbing' : 'crosshair'}; touch-action: none"` — paint mode and draw mode both show crosshair. No visual distinction. Toolbar shows mode (good) but the cursor doesn't change.
**Fix:** Different cursor for draw mode (e.g., `pen` or custom SVG). Currently both same.

### NM8 — Buffer survives no persistence across page reload
**File:** `src/lib/pixel-buffer.js`
**What:** User draws 200 pixels, accidentally reloads page (or browser crashes). All work lost. No localStorage backup.
**Why it matters:** Core promise of "buffer until submit" is that work is safe. It's not.
**Fix:** Optional but valuable. Persist `strokes` to localStorage on each `addStroke`/`undo`/`redo`/`clear`/`commitPending` (debounced). Restore on mount. Bound by quota.

---

## New Low Findings

### NL1 — `currentStroke` and `currentStrokeKeys` are not `$state` but read in template indirectly
**File:** `src/client/components/CanvasRenderer.svelte:19-20`
**What:** Plain `let`. Mutated directly, no reactivity. Not displayed, so OK. Comment-worthy as intentional non-reactive state.

### NL2 — `pixel-buffer.js` not unit-tested
Same as prior unresolved-question #2. Bit-buffer math, undo/redo invariants, dedup behavior are exactly the kind of code that benefits from unit tests. Now even more important since pixel-buffer is the core of the new feature.

### NL3 — `DrawToolbar` lacks `aria-label` on icon-less text buttons
**File:** `DrawToolbar.svelte:8-26`
**What:** Buttons have visible text ("Paint", "Draw", "Undo", "Redo", "Clear", "Submit"). Screen readers will read the text. `title` attributes provide tooltips. OK for a11y. But "Submit (5)" with `disabled` state could announce "Submit 5 pixels, button, dimmed" — currently announces "Submit, dimmed" which isn't clear about why disabled.
**Fix:** Optional. Use `aria-label="Submit 5 pixels"` when count > 0.

### NL4 — Touch double-tap to zoom not handled in draw mode
**File:** `src/client/components/CanvasRenderer.svelte:223-282`
**What:** No double-tap detection. iOS users may expect double-tap to zoom-in. Touch handlers preventDefault so OS double-tap is killed. No app-level replacement.
**Fix:** Optional.

### NL5 — `handleSubmit` doesn't disable other interactions during submit
**File:** `src/client/App.svelte:73-101`
**What:** While Submit is in-flight, user can keep drawing (extends buffer). Those new pixels are NOT included in the submitted batch. After submit succeeds, `commitPending()` (CanvasRenderer:135-141) commits all pending — including the new ones the user drew during submit, which were NOT submitted to server. Server doesn't know about them but client thinks they're committed. Drift!
**Why it matters:** Users will keep drawing during the latency of submit (network is slow on mobile). Their post-submit pixels appear committed locally but are absent server-side.
**Fix:** Snapshot buffer at submit time, send snapshot, on success only commit the snapshotted pixels (not whole buffer). Or disable drawing during submit.

This is borderline a high — promote if user testing confirms.

### NL6 — Constants from previous review still not addressed (L2, L3)
- `0.25` and `64` zoom limits still hardcoded at App:118-119, CanvasRenderer:205, 262.
- `selectedColor = $state(27)` still magic at App:9.

---

## Looked at and OK

- **`commitPending` correctly updates `committedColors` for accepted pixels** (CanvasRenderer:135-141).
- **`undo`/`redo` invariants in pixel-buffer.js** — `addStroke` clears redo stack (correct), undo pops to redo, redo pops to strokes. Sound.
- **Mode toggle in DrawToolbar** uses `class:active` correctly with mode comparison.
- **`getAllPixels` dedup with last-stroke-wins via Map** — correct semantics.
- **Right-click pan in draw mode** (CanvasRenderer:179-184) — works as documented in DrawToolbar tooltip.
- **`buffer.getColorAt` correctly handles color 0 (dark red)** — sentinel is -1, all colors are >=0.
- **WebSocket message `try/catch` around JSON.parse and applyUpdates** (App:37-44) — prevents bad messages from killing the WS handler.
- **Backend `MAX_BATCH_SIZE=512` matches the constant client uses** (constants.js:11) — single source of truth via shared lib import.
- **DrawToolbar buttons sized 44×44 min-height** — good touch target (Apple HIG).
- **Submit button disable when `pixelCount === 0`** — prevents empty submit.
- **Keyboard Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z** — covers all common undo/redo shortcuts.
- **No XSS surface introduced** — DrawToolbar uses interpolation only.
- **`bind:this={canvasRenderer}` + exported functions** — clean API surface.
- **Server-side validation independent of client** — no trust boundary leak (worker.js:40-52).

---

## Unresolved Questions

1. **Partial-batch acceptance:** Does the server need to support partial-accept (place first N pixels of batch, reject rest if rate-limited mid-batch)? Currently it's all-or-nothing, which is simpler but means a batch of 200 pixels with only 199 credits is fully rejected. UX-wise users will be frustrated.
2. **Buffer persistence:** Is losing all pending work on accidental reload acceptable? r/place historically did NOT have local buffering — you placed atomically. The new model creates a new failure mode (lost work) that didn't exist before.
3. **Conflict signaling:** When a remote pixel arrives at a coord with pending local pixel, should the user be told? Currently they're not — they may overwrite a popular team's work without realizing.
4. **Mode-switch UX intent:** Should mode switch mid-stroke commit the in-progress stroke, discard it, or block the switch until mouseup? Current behavior (NH3) is "merge with subsequent paint pixel" which is buggy.
5. **Why was the optimistic deduction removed?** H5 fix is good but loses snappy "credits go down immediately" UX. Is the trade-off intentional (correctness over feedback)?
6. **What's the reconnect story?** C4 still unfixed — does the team consider WS disconnect during active editing a real concern, or is the assumption that users won't be disconnected for long?
7. **Why was MAX_BATCH_SIZE bumped from 32 to 512?** Significant change in server load profile per request. Any rate-limit re-tuning planned to compensate?

---

## Metrics

- Files reviewed: 8 (including 2 new: DrawToolbar.svelte, pixel-buffer.js)
- LOC delta vs prior: +66 App.svelte, +74 CanvasRenderer.svelte, +117 DrawToolbar (new), +79 pixel-buffer (new) = +336 LOC
- Critical: 4 prior unfixed (C1, C2, C3, C4) + 3 new (NC1, NC2, NC3) = **7**
- High: 6 prior unfixed (H1, H2, H3, H4, H6, H7) + 1 partial (H8) + 1 fixed (H5) + 5 new (NH1-NH5) = **12 unresolved**
- Medium: most prior unfixed + 8 new (NM1-NM8)
- Low: prior + 6 new (NL1-NL6)
- Type coverage: N/A (vanilla JS, partial JSDoc)
- Test coverage: 0 frontend (some backend tests added in newer commits)

---

## Recommended Actions (Priority Order)

1. **NC2** — Cap `currentStrokeKeys` and `buffer.pixelCount` at `MAX_BATCH_SIZE` (512). Quick fix, prevents OOM on long draws.
2. **NC1** — Add error UI for failed Submit. Critical UX gap with batch flow.
3. **NC3** — Initialize `committedColors` upfront or queue WS updates during initial fetch.
4. **NH3** — Cancel/finish stroke on mode change to prevent dangling-state bugs.
5. **NH1** — Cache `getColorAt` / `pixelCount` via Map in pixel-buffer for O(1) access.
6. **C1 + C2** — Still open from prior. Fix pan reactivity OR call `render()` in `handleWheel`.
7. **C3** — Decoder buffer length validation.
8. **C4** — WS reconnect canvas refetch.
9. **H1** — devicePixelRatio.
10. **H2** — Resize listener leak in async onMount.
11. **NL5** — Snapshot buffer at submit time (drift bug).
12. **NM4** — Check `res.ok` before parsing JSON.
13. **NM8** — localStorage persistence of buffer (optional but high-value).
14. Remaining mediums + lows as time permits.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Batch drawing rewrite (e0cf802) introduces meaningful new UX (paint/draw modes, undo/redo, batch submit) but compounds existing failure modes. Of 12 prior findings (4 critical + 8 high), only H5 fully fixed (architecturally), H8 partially mitigated. Remaining 10 carry forward unchanged. New flow adds 3 critical bugs (silent submit failure, unbounded buffer, null deref race) and 5 high (perf, mode-switch dangling state, error swallow, missing cursor updates on touch). The new batch-drawing UX is a net feature win but the *failure modes* of batch operations are 100-1000x more painful than per-pixel failures.
**Concerns:** Buffer-loss-on-failed-submit (NC1) and unbounded-buffer (NC2) are user-visible disasters waiting to happen. Strongly recommend addressing NC1+NC2+NC3 before shipping further. Server-side `MAX_BATCH_SIZE=512` is large enough to cause significant memory + bandwidth issues if client allows reaching it without backpressure.
