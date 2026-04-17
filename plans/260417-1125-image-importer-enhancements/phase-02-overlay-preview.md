# Phase 02 — Overlay Preview on Canvas

## Overview
- **Priority:** P1 (high UX value)
- **Status:** Todo
- Show a semi-transparent ghost of the palette-converted image on the main canvas at `(originX, originY)`, so the user can zoom/pan and confirm alignment *before* spending credits.

## Key Insights
- Today the user sees the preview in the panel only — they have to guess-and-upload, which wastes credits on misalignment.
- Ghost overlay must live at the canvas layer, not in the importer, because the user pans/zooms the canvas freely.
- Overlay must not interfere with manual drawing mode.
- Overlay opacity toggle (e.g. 50%) helps differentiate it from committed pixels.

## Requirements
- `CanvasRenderer` accepts an optional overlay: `{ x, y, width, height, indices }` (same `Int16Array` the importer already builds).
- Rendered as a second layer after committed + pending, at configurable alpha.
- Toggle on/off from the importer panel.
- Updates on importer changes (resize/dither/etc.) with no jank.

## Architecture
Extend `CanvasRenderer` with:
- A dedicated OffscreenCanvas for the overlay, same dims as the overlay's bounding box.
- `setOverlay({ x, y, width, height, indices, alpha } | null)` method.
- Render pipeline: commit/pending → offscreen → main canvas → `ctx.globalAlpha = alpha; ctx.drawImage(overlay, x, y);`.

`ImageImporter.svelte` holds a toggle `showOverlay` (default true); a reactive `$effect` calls `canvasRenderer.setOverlay(...)` whenever `paletteIndices` / `originX` / `originY` / `showOverlay` changes, and clears on close.

## Related Code Files
**Modify:**
- `src/client/components/CanvasRenderer.svelte` — overlay layer + method
- `src/client/components/ImageImporter.svelte` — show/hide toggle, wiring
- `src/client/App.svelte` — pass `canvasRenderer` ref to importer (already has bind, may need forwarding)

## Implementation Steps
1. In `CanvasRenderer`, allocate `overlayCanvas: OffscreenCanvas | null = null`. On `setOverlay(o)`:
   - If `o == null`, drop the overlay and re-render.
   - Else, build an `ImageData` from `paletteToRgba(o.indices, o.width, o.height)`, paint it on a fresh OffscreenCanvas, store `overlayState = { x, y, canvas, alpha }`.
2. Extend `render()` to draw the overlay after `offscreen`, respecting `globalAlpha`.
3. Expose `setOverlay` via `export function`.
4. In `ImageImporter`, add `showOverlay` checkbox (default true) and an opacity slider (default 0.5).
5. Wire a `$effect` that calls `setOverlay(showOverlay && paletteIndices ? { x: originX, y: originY, width: resizeW, height: resizeH, indices: paletteIndices, alpha } : null)` on relevant changes.
6. Clear overlay on panel close and when upload finishes successfully (optional; keep if user wants to re-align).

## Todo
- [ ] `CanvasRenderer.setOverlay` + render integration
- [ ] Importer toggle + alpha slider
- [ ] Reactive wiring (importer ↔ renderer)
- [ ] Verify overlay clears on close / unmount

## Success Criteria
- Toggle overlay on → preview appears on the canvas at the chosen position at 50% alpha.
- Move origin X/Y → overlay follows in real time.
- Disable overlay → canvas returns to normal appearance.
- No regression in existing draw/paint/undo/redo flows.

## Risks
- Performance on large overlays (up to canvas size): limit overlay dims to `resizeW*resizeH <= some cap` (e.g. 1M pixels) or always use OffscreenCanvas (GPU-accelerated).
- Race with WebSocket updates changing `committedColors` — overlay is drawn on top so it's fine.

## Next Steps
- Phase 3 (transforms) will rotate/flip the indices; overlay must re-render on transform toggle.
