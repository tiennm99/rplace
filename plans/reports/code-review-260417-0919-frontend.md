# Frontend Code Review — rplace

**Date:** 2026-04-17
**Scope:** Frontend only — Svelte 5 + Canvas + WebSocket client
**Files reviewed:** 12 (client/, lib/canvas-decoder.js, lib/constants.js, index.html, vite/svelte config)
**LOC:** ~600 frontend
**Reviewer mode:** adversarial — assume bugs exist

---

## Summary

Solid Svelte 5 runes usage and clean component split. Several concrete bugs around reactivity (`pan` is plain object, won't trigger re-render), zoom math in handleWheel (uses stale `zoom` after onZoomChange), DPR not handled (blurry on retina/HiDPI), missing $effect cleanup for resize, decoder boundary read past buffer end, no UI feedback for 429 / network errors, and credit timer drift on tab inactive. Touch handlers prevent default unconditionally (blocks system gestures off-canvas). No keyboard a11y for color picker. WS reconnect lacks resync — client drifts after reconnect.

---

## Critical

### C1 — `pan` mutation does not trigger reactivity
**File:** `src/client/components/CanvasRenderer.svelte:10, 109-110, 168-169, 180-181, 184-185`
**What:** `let pan = { x: 0, y: 0 };` is plain (no `$state`). Code mutates `pan.x += dx` then calls `render()` manually.
**Why it matters:** Works only because `render()` is called explicitly after every mutation. Fragile — any future code path that mutates `pan` without calling `render()` will silently fail to redraw. Also bypasses the runes-based reactivity model that the rest of the app uses, violating the principle of least surprise.
**Fix:** Either (a) declare `let pan = $state({ x: 0, y: 0 })` and let `$effect(() => { pan.x; pan.y; render() })` fire (simpler, idiomatic), or (b) document explicitly that `pan` is intentionally non-reactive and all mutations must be paired with `render()`.

### C2 — `handleWheel` uses stale `zoom` after `onZoomChange`
**File:** `src/client/components/CanvasRenderer.svelte:124-133`
**What:** Computes `newZoom`, mutates `pan` using the *old* `zoom` prop, then calls `onZoomChange(newZoom)`. The pan math is correct (uses `newZoom / zoom` ratio), but the render pipeline relies on the `$effect(() => { zoom; render(); })` firing after zoom prop updates — which means render uses the new `zoom` *but* with pan computed against the old. Plus, `pan` mutation does not trigger render (see C1), so the wheel-zoom render relies entirely on the zoom prop changing to fire the effect.
**Why it matters:** If user wheel-zooms but newZoom equals current zoom (clamped at 0.25 or 64), pan mutates but render is never triggered → pan visually frozen at zoom limits. Repro: zoom out to min (0.25), keep scrolling down → pan adjustments accumulate invisibly until you scroll up.
**Fix:** Call `render()` explicitly at end of `handleWheel`, or fix C1 (make pan reactive).

### C3 — Decoder reads past buffer end on last pixel
**File:** `src/lib/canvas-decoder.js:18`
**What:** `(bytes[byteIndex] << 8 | (bytes[byteIndex + 1] || 0))` — guards `byteIndex+1` with `|| 0`, but does not guard `bytes[byteIndex]` itself. For a 2048×2048 5-bit canvas: `totalBits = 4194304 * 5 = 20971520 bits = 2621440 bytes`. Last pixel `bitPos = 20971515`, `byteIndex = 2621439`, `bitOffset = 3`. `bytes[2621439]` is valid (last byte index), `bytes[2621440]` is undefined → `0`. OK for exact-size buffer.

  **However** — if server returns a truncated buffer (network error, partial response, future smaller canvas), `bytes[byteIndex]` could be undefined → `(undefined << 8 | 0) = 0`. JavaScript silently coerces; you get black pixels instead of an error. No length check on incoming buffer.
**Why it matters:** Silent data corruption on truncated response. Also, `0 || 0 === 0` masks the case where a byte is genuinely 0 vs. missing.
**Fix:** Validate `buffer.byteLength === Math.ceil(totalPixels * 5 / 8)` at top of `decodeCanvas`, throw if mismatch. Caller in `CanvasRenderer.svelte:217-228` should handle the throw and surface to UI.

### C4 — WebSocket reconnect does not resync canvas
**File:** `src/client/App.svelte:42-46`
**What:** On `ws.onclose`, schedules reconnect with backoff. But after reconnect succeeds, client does not refetch `/api/canvas` — any pixels placed by other users during the disconnect window are lost forever (until next full reload).
**Why it matters:** Core correctness violation of the "real-time collaborative" promise. A 30s disconnect (worst-case backoff) on a busy canvas can lose hundreds of updates. User sees stale canvas with no indication.
**Fix:** On `ws.onopen` after a *reconnect* (not initial open), call `canvasRenderer.refetchCanvas()` which re-runs the GET /api/canvas + decode + render flow. Track `isReconnect` flag (true after first close).

---

## High

### H1 — DevicePixelRatio ignored — blurry on Retina/HiDPI
**File:** `src/client/components/CanvasRenderer.svelte:209-213`
**What:** `canvasEl.width = window.innerWidth; canvasEl.height = window.innerHeight;` — sets backing store to CSS pixels. On `devicePixelRatio = 2` displays (Mac, modern phones), every pixel is upscaled by browser → blurry rendering, especially zoomed-in pixel art (the entire point).
**Fix:**
```js
const dpr = window.devicePixelRatio || 1;
canvasEl.width = window.innerWidth * dpr;
canvasEl.height = window.innerHeight * dpr;
canvasEl.style.width = window.innerWidth + 'px';
canvasEl.style.height = window.innerHeight + 'px';
ctx.scale(dpr, dpr); // in render() before pan/zoom
```
Then `screenToCanvas` math stays in CSS pixel space (don't multiply clientX by dpr). Also wheel/touch focal points stay correct.

### H2 — Resize listener leak in onMount
**File:** `src/client/components/CanvasRenderer.svelte:208-231`
**What:** `onMount` returns a cleanup that removes resize listener. But `onMount`'s returned function is the standard Svelte teardown — works for unmount, but the `return` inside an `async` callback of `onMount` returns a Promise, not the cleanup function. Svelte will receive `Promise<() => void>`, not the cleanup fn.
**Why it matters:** Resize listener leaks on every component remount (HMR, route changes if added later, parent re-creates child). Each remount adds another listener → resize fires N times.
**Fix:** Move resize setup outside `async` — use a synchronous `onMount(() => { ... return cleanup; })` for the listener, and a separate `$effect` or top-level `await` for the canvas fetch. Or use `$effect`:
```js
$effect(() => {
  function resize() { ... }
  resize();
  window.addEventListener('resize', resize);
  return () => window.removeEventListener('resize', resize);
});
```

### H3 — Credit timer drifts on tab inactive
**File:** `src/client/App.svelte:17-24`
**What:** `setInterval(..., 1000)` regenerates 1 credit/sec client-side. When tab is backgrounded, browsers throttle setInterval to ≥1s but don't pause; on long inactivity (laptop sleep, tab discard), timer doesn't fire at all. After 5 min away, user expects ~256 credits (capped) but client may show only the value from 5 min ago. Server-side credits regen correctly via timestamp math, but client UI lies.
**Why it matters:** UX confusion — user sees "5 credits" but server says they have 256. Optimistic deduction (line 60) deducts from the wrong baseline. First placement after wake will get a server response with the correct credit count, but until then the bar is wrong, and rapid-clicking before that response arrives will be repeatedly rejected for no visible reason.
**Fix:** Track `lastTickTimestamp`. On each tick, compute `elapsed = now - lastTick` in seconds and add `elapsed * CREDIT_REGEN_RATE` (capped). Also re-fetch credits from server on `visibilitychange` → visible, or have server include `credits` in WS hello message.

### H4 — No UI feedback on 429 / network error
**File:** `src/client/components/CanvasRenderer.svelte:64-79`
**What:** On rate-limit (429) or network failure, code logs to console.warn/error. Optimistic pixel stays drawn (line 74 comment), credits remain deducted (line 60). User has no idea their action failed.
**Why it matters:** Silent failure mode. User clicks 10 times, sees 10 pixels appear locally, sees credits drop, then WS broadcasts arrive showing only the first one was accepted — pixels appear to flicker. Especially bad with `retryAfter` info (server provides it but client ignores).
**Fix:** Surface error state via prop callback or store. Show toast/banner: "Rate limited — try again in {retryAfter}s" or "Network error — retrying...". Roll back optimistic update on failure (revert pixel + restore credit).

### H5 — Optimistic credit deduction races with server response
**File:** `src/client/components/CanvasRenderer.svelte:60, 72`
**What:** Client deducts 1 credit optimistically (line 60), then awaits server which returns authoritative count (line 72). Between the two, user can click again — second click sees `credits - 1`, deducts again. But meanwhile credit timer may have ticked, adding back 1. The final `onCreditsChange(data.credits)` clobbers all of that with server truth, but timing of clobber matters.
**Why it matters:** Specifically — rapid clicks while `/api/place` is in flight all use a stale `credits` snapshot from props. Possible to over-spend client-side: 5 rapid clicks with `credits=3` → all 5 see `credits >= 1` at click time (each only checks before its own deduction), all 5 fire requests. Server rejects last 2, but client UI shows 5 placed.

  Actually re-reading: `credits` is a $state in App, prop to CanvasRenderer — when `onCreditsChange(credits - 1)` fires, Svelte 5 prop update is sync. Next click in same tick reads new value. So 5 clicks in 5 ticks → 3 succeed, 2 see `credits <= 0` and bail. OK *if* clicks happen sequentially.

  Still problematic: between optimistic deduct and server response, if server says `credits = 250` (regen happened server-side), client jumps from `credits - 1` back up to 250, throwing away any other in-flight optimistic deductions.
**Fix:** Either (a) drop optimistic deduction (rely on server response only — slower UX but correct), or (b) track in-flight count and reconcile: `onCreditsChange(data.credits - inFlight)`.

### H6 — Color picker has no keyboard navigation / no roving tabindex
**File:** `src/client/components/ColorPicker.svelte:8-17`
**What:** 32 `<button>` swatches with `aria-label` only. Keyboard users can Tab through all 32 (tedious), no arrow-key grid navigation, no `aria-pressed` to indicate selected. `title` attribute used for tooltip but not for screen readers.
**Why it matters:** WCAG 2.1 keyboard accessibility. Power users want arrow keys.
**Fix:** Use `role="radiogroup"`, swatches as `role="radio" aria-checked={i === selectedColor}`, single `tabindex=0` on selected (others `tabindex=-1`), arrow-key handler to move selection. Add visible focus ring (currently no `:focus` style — invisible focus).

### H7 — Touch `preventDefault` on canvas blocks legitimate browser gestures
**File:** `src/client/components/CanvasRenderer.svelte:151, 163`
**What:** `e.preventDefault()` unconditionally on every touchstart/touchmove. Combined with `touch-action: none` CSS (line 247).
**Why it matters:** Both together is correct *for the canvas*. But:
  - `preventDefault` in handler requires the listener to be non-passive. Svelte's `ontouchmove={handleTouchMove}` registers as non-passive automatically when handler calls preventDefault — but Chrome warns about non-passive touchstart listeners on scroll-blocking elements.
  - `e.preventDefault()` on touchstart also blocks browser-native double-tap zoom — your app overrides that with pinch-zoom, which is fine, but means iOS users can't double-tap to zoom (they expect this).
  - `touch-action: none` on canvas is correct, but the canvas fills the viewport — there is no scrollable area for users to escape. If they want to refresh by pull-down or use system back-swipe-from-edge, behavior is OS-dependent.
**Fix:** Acceptable trade-off given full-screen canvas is the app, but document. Consider not preventing default on touchstart when `touches.length === 1` (only on move, when actually panning) to allow OS gestures to start cleanly. Test mobile Safari edge swipe.

### H8 — Long-press detection has no visual feedback and is timing-sensitive
**File:** `src/client/components/CanvasRenderer.svelte:193-203`
**What:** Long-press = touchend after >300ms with no movement. No visual indicator during the wait — user doesn't know if they're holding correctly. `touchMoved` only flips on >4px move (line 167), so trembling fingers (especially over many seconds) may register movement and silently cancel placement.
**Why it matters:** UX — users will tap-and-hold, see nothing happen, lift, and wonder why nothing was placed. Also: a 200ms tap places nothing (correct, prevents accidental placement during pan), but no feedback distinguishes "tap" from "long-press canceled by movement".
**Fix:** Show a circular progress indicator at touch point during long-press wait. Cancel with haptic or visual on movement. Consider lowering threshold to 250ms and increasing movement tolerance to 8px (trembling).

---

## Medium

### M1 — `applyUpdates` does not validate WebSocket message shape
**File:** `src/client/components/CanvasRenderer.svelte:82-87`
**What:** Iterates `pixels` array and reads `x, y, color`. No bounds check on `x, y` (line 48 calculates `offset = (y * CANVAS_WIDTH + x) * 4` — out-of-bounds write to ImageData would silently corrupt other pixels). Server is trusted, but WS messages parsed in `App.svelte:36` from JSON → if server bug or malicious WS proxy injects bad data, client writes anywhere in the ImageData buffer.
**Why it matters:** Trust boundary — WS messages cross it. Defense in depth.
**Fix:** In `updatePixel` (line 45), early return if `x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT || colorIndex < 0 || colorIndex >= MAX_COLORS`.

### M2 — `render()` not batched via requestAnimationFrame
**File:** `src/client/components/CanvasRenderer.svelte:24-36`
**What:** `render()` called synchronously on every mousemove during pan, every touchmove, every applyUpdates. On a busy WS broadcast (many pixel updates per second), can fire render >60Hz, wasting CPU.
**Why it matters:** Perf — drawImage of 2048×2048 offscreen at 60Hz on a slow device is the bottleneck. Browser will skip frames anyway, but the redundant work runs.
**Fix:** Wrap `render()` in rAF coalescer:
```js
let rafScheduled = false;
function scheduleRender() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => { rafScheduled = false; render(); });
}
```
Replace all `render()` call sites with `scheduleRender()`. Single-frame coalescing eliminates redundant draws.

### M3 — `putImageData` to offscreen on every render
**File:** `src/client/components/CanvasRenderer.svelte:30`
**What:** `offCtx.putImageData(imageData, 0, 0)` runs on every render — even if ImageData hasn't changed (e.g., user is just panning).
**Why it matters:** Perf — putImageData of 2048×2048 (16MB) every pan frame is expensive.
**Fix:** Track `imageDataDirty` flag. Set true in `updatePixel` and `applyUpdates`, set false after putImageData. Only call putImageData when dirty.

### M4 — `loading` state never propagates to UI placement gating
**File:** `src/client/components/CanvasRenderer.svelte:13, 55-80`
**What:** `loading = $state(true)` shows "Loading canvas..." overlay, but `placePixel` doesn't check it. If user clicks before initial fetch completes, `imageData` is null → `updatePixel` early-returns (line 46), but `onCreditsChange(credits - 1)` already fired (line 60). Credits drop without any pixel placed.
**Why it matters:** UX bug + credit waste.
**Fix:** Early return at top of `placePixel`: `if (loading || !imageData) return;`.

### M5 — Coordinate display lags during fast cursor movement
**File:** `src/client/components/CanvasRenderer.svelte:99-103`
**What:** `onCursorMove` fires on every mousemove, updates `cursorPos` in App which re-renders `CanvasControls`. Throttle would help.
**Why it matters:** Minor perf, possible visible lag on slow devices.
**Fix:** Throttle to ~30Hz with rAF coalescing in App, or use `$effect.pre` on cursorPos.

### M6 — Touch handlers don't update `cursorPos` for `CanvasControls`
**File:** `src/client/components/CanvasRenderer.svelte:150-203`
**What:** Mouse handlers call `onCursorMove` (line 100) but touch handlers don't. On mobile, the coordinates display in CanvasControls stays at `(0, 0)` forever. Possibly intentional (no hover on touch), but inconsistent.
**Fix:** Either hide coords display on touch-only devices (`@media (hover: none)`), or update on touchmove.

### M7 — Pan not clamped — user can pan canvas off-screen entirely
**File:** `src/client/components/CanvasRenderer.svelte:109-110, 168-169`
**What:** `pan.x += dx` accumulates without limits. User can drag the 2048×2048 canvas completely off-screen and lose orientation.
**Why it matters:** UX — easy to "lose" the canvas. Reset zoom button restores zoom but not pan.
**Fix:** Clamp pan so at least `MIN_VISIBLE_PX` (e.g., 50px) of canvas remains visible:
```js
const minX = -CANVAS_WIDTH * zoom + 50;
const maxX = window.innerWidth - 50;
pan.x = Math.max(minX, Math.min(maxX, pan.x));
```
Same for y. Also fix `onResetZoom` in App.svelte:72 to also reset pan.

### M8 — Reset zoom doesn't reset pan
**File:** `src/client/App.svelte:72`
**What:** `onResetZoom={() => zoom = 1}` only resets zoom. Pan stays at whatever the user dragged to.
**Why it matters:** UX — "reset" implies "back to start". User clicks reset expecting to see whole canvas, sees same off-center view at 1x.
**Fix:** Add `onResetPan` callback that sets pan to center-the-canvas (or 0,0). Or have a single "reset view" button that does both. Centering math:
```js
pan = { x: (window.innerWidth - CANVAS_WIDTH) / 2, y: (window.innerHeight - CANVAS_HEIGHT) / 2 };
```

### M9 — `wsRetryDelay` is module-scope (not per-instance)
**File:** `src/client/App.svelte:27`
**What:** Declared outside any function/component scope (well, inside `<script>` but at module top). Works fine for an SPA with single root. But if App is mounted multiple times (testing, dev HMR), they share state.
**Fix:** Move inside `connectWebSocket` as a closure-scoped variable, or use `$state` inside the component.

### M10 — `<title>` only includes app name, no dynamic state
**File:** `src/index.html:6`
**What:** Static title. Could indicate disconnected state, credit availability, etc.
**Fix:** Optional. Could use `<svelte:head>` to show "(disconnected)" prefix when WS down.

---

## Low

### L1 — `zoomLabel` formatting breaks for non-power-of-2 zoom
**File:** `src/client/components/CanvasControls.svelte:4-6`
**What:** `1 / zoom` for fractional zoom — fine for 0.5, 0.25 (gives "1/2x", "1/4x"), but for 0.333 gives "1/3.0030030030030033x". Currently zoom is always doubled/halved so always power of 2 — but pinch-zoom (line 177) produces continuous values. After pinching to e.g. 0.7x, label shows "1/1.4285714285714286x".
**Fix:** `zoom >= 1 ? \`${zoom.toFixed(1)}x\` : \`${(zoom * 100).toFixed(0)}%\``. Or `Math.round(zoom * 100) / 100`.

### L2 — Hardcoded zoom limits duplicated
**File:** `App.svelte:70-71`, `CanvasRenderer.svelte:127, 177`
**What:** `0.25` and `64` hardcoded in 4+ places.
**Fix:** Add `MIN_ZOOM = 0.25, MAX_ZOOM = 64` to `constants.js`.

### L3 — `selectedColor = $state(27)` magic number
**File:** `src/client/App.svelte:8`
**What:** `27` is index of black in palette. Comment says so but not self-documenting.
**Fix:** Add `BLACK_INDEX = 27` or `DEFAULT_COLOR_INDEX = 27` to constants.

### L4 — `applyUpdates` does not deduplicate concurrent updates from optimistic + WS echo
**File:** `src/client/components/CanvasRenderer.svelte:55-87`
**What:** Client places pixel, optimistically updates locally (line 61), server broadcasts to all WS including the placer, client receives its own pixel back via `applyUpdates`, redraws same pixel.
**Why it matters:** Wastes a render cycle. If multiple pixels in batch, multiple re-draws.
**Fix:** Server could include placer ID and skip echo, OR client just lives with the redundant render (cheap if M3 fix applies). Low priority.

### L5 — Inline event handlers create new closures each render
**File:** `src/client/App.svelte:63, 65, 66, 70-72, 75`
**What:** `onCreditsChange={(c) => credits = c}` etc. — fresh function each parent render → child sees new prop → may trigger child re-render.
**Why it matters:** Svelte 5 fine-grained reactivity may handle this, but explicit functions are cheaper and more debuggable.
**Fix:** Optional. Hoist to `function setCredits(c) { credits = c; }` etc.

### L6 — Hex parsing in constants happens at module load, no error handling
**File:** `src/lib/constants.js:32-35`
**What:** `parseInt(hex.slice(1), 16)` — if any palette entry is malformed, NaN propagates silently, RGBA values become NaN, ImageData rejects.
**Why it matters:** Currently safe (palette is hardcoded, validated by humans). Defense-in-depth.
**Fix:** Optional. Validate at module load with `if (n !== n) throw` or similar.

### L7 — `Cache-Control: max-age=1` on /api/canvas
**File:** `src/worker.js:17` (server-side, but affects client behavior)
**What:** Browser cache for 1s. If user reloads twice within 1s, second load gets stale canvas. Fine for fresh page loads, but interacts with C4 fix (refetch on reconnect): the refetch may hit stale cache.
**Fix:** When refetching after reconnect, add `?_=Date.now()` cache-buster to bypass cache.

### L8 — `app.css` uses `overflow: hidden` on body without `html`
**File:** `src/client/app.css:11`
**What:** `body { overflow: hidden; }` but `html` not set. Some browsers (older Safari) need both.
**Fix:** `html, body { overflow: hidden; }`.

---

## Nit

### N1 — `cursor: grabbing` only when `dragging` true; otherwise crosshair
**File:** `src/client/components/CanvasRenderer.svelte:247`
**What:** Should show `cursor: grab` when hovering (not dragging) to hint draggability. `crosshair` suggests pixel-place mode, which is also true. Mixed UX signal.
**Fix:** Style: `crosshair` is appropriate for placing; `grabbing` during pan. Alternative: use `crosshair` always, since you can both place and drag from any state.

### N2 — `loading` state used only as guard but always finally set false
**File:** `src/client/components/CanvasRenderer.svelte:226-228`
**What:** Even on fetch failure, `loading = false` and overlay disappears. User sees blank canvas with no error indicator.
**Fix:** Add error state and overlay: "Failed to load — refresh".

### N3 — `console.warn`/`console.error` not gated by env
**File:** `App.svelte:39 (commented)`, `CanvasRenderer.svelte:75, 78, 225`
**What:** Production builds will log. Vite default keeps console.* unless explicitly stripped. Minor.
**Fix:** Use `import.meta.env.DEV` gate, or just leave (cheap diagnostic in prod).

### N4 — Variable name `lastMouse` reused for touch center
**File:** `src/client/components/CanvasRenderer.svelte:155, 158, 188`
**What:** `lastMouse` set from touch coords. Misleading name.
**Fix:** Rename to `lastPointer` to cover both.

### N5 — `aria-label="Select color #6d001a"` reads as "select color hash six d zero zero one a"
**File:** `src/client/components/ColorPicker.svelte:15`
**What:** Screen readers will spell out the hex character by character. Useless to a blind user.
**Fix:** Use color names ("dark red", "white", etc.) — adds 32 strings to constants but actually accessible. r/place's palette has standard names available.

### N6 — Build/dev: no source maps configured for production debugging
**File:** `vite.config.js`
**What:** No `build.sourcemap` set.
**Fix:** Add `sourcemap: true` for prod debugging (or `'hidden'` to not expose to users).

### N7 — `rgba` array creation in `indicesToRgba` could use bitwise pack
**File:** `src/lib/canvas-decoder.js:31-42`
**What:** Could use Uint32Array view for 1-write-per-pixel instead of 4. Marginal perf gain (~2-3x) on 4M pixel array.
**Fix:** Optional perf optimization for slower mobile devices.

---

## Looked at and OK

- **constants.js palette / RGBA precompute** — clean, immutable, correct hex→RGBA math.
- **canvas-decoder.js bit math** — correct 5-bit unpack formula `(bytes[i] << 8 | bytes[i+1]) >> (11 - bitOffset) & 0x1f`. Boundary handling for last byte OK *if* buffer length validated (see C3).
- **`indicesToRgba` fallback to `COLORS_RGBA[0]`** — graceful for OOB color indices. Good defense-in-depth.
- **OffscreenCanvas usage (CanvasRenderer:21)** — correct pattern for high-zoom rendering, avoids re-uploading ImageData per pan frame *if* M3 fix applies.
- **`imageSmoothingEnabled = false` (CanvasRenderer:27)** — correct for pixel art.
- **WebSocket protocol switching (App.svelte:30)** — correctly handles HTTPS→WSS upgrade.
- **WS exponential backoff** — capped at 30s, sensible.
- **Vite proxy config** — `/api` → :8787, ws: true, correct for dev mode.
- **`bind:this={canvasRenderer}`** — correct Svelte 5 ref pattern; `applyUpdates` exported correctly.
- **`$derived` usage in UserInfo, CanvasControls** — clean, no side effects, correct reactivity.
- **`touch-action: none`** — correct CSS for canvas drag/pan.
- **CSS `transform: translate(-50%, -50%)` for centering** — standard and correct.
- **Server-side validation (worker.js:40-52)** — full pixel validation independent of client; no trust boundary leak. Good.
- **`Number.isInteger` checks** — catches NaN/float attacks.
- **No XSS surface** — no innerHTML, no `{@html}` usage. All Svelte interpolation auto-escaped.
- **No localStorage / sensitive data on client** — nothing to leak.
- **No hardcoded URLs** — uses `location.host`, environment-portable.

---

## Recommended Actions (priority order)

1. **Fix C1 + C2** (pan reactivity + handleWheel render) — silent visual bugs.
2. **Fix C3** (decoder buffer length validation) — silent data corruption.
3. **Fix C4** (WS reconnect canvas refetch) — core correctness.
4. **Fix H1** (devicePixelRatio) — visible quality issue, easy fix.
5. **Fix H2** (resize listener leak in async onMount) — memory leak per remount.
6. **Fix H3** (credit timer drift) — UX confusion after tab inactive.
7. **Fix H4** (UI feedback for 429/error) — silent failure mode.
8. **Address M1** (applyUpdates validation) — defense in depth for WS trust boundary.
9. **Address M3 + M2** (render coalescing + ImageData dirty flag) — perf for busy canvas.
10. **Address M4** (placePixel before load) — credit waste.
11. **Address M7 + M8** (pan clamp + reset includes pan) — UX polish.
12. Lows + Nits as time permits.

---

## Metrics

- Files reviewed: 12 (all frontend + shared lib)
- LOC: ~600
- Critical: 4
- High: 8
- Medium: 10
- Low: 8
- Nit: 7
- Positive observations: 18
- Type coverage: N/A (vanilla JS, JSDoc partial)
- Test coverage: 0 (no test files in frontend)
- Linting: not checked (no config visible in scope)

---

## Unresolved Questions

1. Is the optimistic-update strategy intentional? If yes, what's the rollback policy on server reject? README implies "WS will correct" — does server actually broadcast the *correct* pixel back when rejecting an attempt? (Saw worker.js — server does *not* broadcast on rejection, so client's optimistic pixel stays drawn forever until user pans away or another update arrives at that location.)
2. Why no test coverage for the canvas-decoder? Bit-packing math is exactly the kind of code that benefits from unit tests (round-trip encode/decode against known fixtures).
3. Is mobile a P0 platform? Long-press UX (H8) and DPR (H1) matter most on mobile.
4. Should the canvas be panned-clamped, or is "lose the canvas off-screen" considered acceptable (some r/place clones intentionally allow it)?
5. WebSocket — what happens if Durable Object hibernates and the client's WS goes idle? Is there a heartbeat from server, or does TCP keepalive handle it? Browsers may close idle WS after 60s of no traffic.
6. Are emoji-rich labels (e.g., from N5 color names) acceptable in JSON / does the project have an i18n strategy planned?

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Solid Svelte 5 architecture but 4 critical correctness bugs (pan reactivity, wheel render gating, decoder boundary, WS resync), 8 high-severity (DPR, listener leak, credit drift, no error UX), and several mid-tier UX gaps. No security vulnerabilities found in frontend scope (server validates independently). Recommend addressing C1-C4 before next deploy.
**Concerns:** Frontend has silent failure modes (C2, H4, C4) that won't surface in CI but will frustrate real users on mobile/lossy networks. No tests cover the decoder or canvas math.
