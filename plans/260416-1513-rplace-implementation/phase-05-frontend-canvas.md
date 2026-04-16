---
phase: 5
title: "Frontend Canvas"
status: pending
effort: 5h
priority: P1
blocked_by: [2, 3, 4]
---

# Phase 5 — Frontend Canvas

## Overview
Build interactive HTML5 Canvas UI: load full canvas from API, render 2048x2048 grid, support zoom/pan, color picker with 32-color palette, pixel placement on click, real-time SSE updates.

## Key Insights
- HTML5 Canvas with `ImageData` is the performant way to render millions of pixels
- Use `OffscreenCanvas` or direct `putImageData` for bulk updates
- Zoom/pan via CSS `transform` on a wrapper or by scaling canvas draw calls
- Decode 5-bit packed binary into RGBA ImageData on client side
- Use `requestAnimationFrame` for smooth rendering

## Data Flow

```
Initial Load:
  1. fetch('/api/canvas') → gzipped binary (auto-decompressed by browser)
  2. Decode 5-bit packed buffer → Uint8Array of color indices
  3. Map color indices → RGBA via palette lookup
  4. Create ImageData, putImageData to canvas

Live Updates (SSE):
  1. EventSource('/api/canvas/stream?since=0')
  2. On message: parse pixel batch
  3. For each pixel: update ImageData at (x,y), queue re-render
  4. Batch re-renders via requestAnimationFrame

Pixel Placement:
  1. User clicks canvas → translate screen coords to canvas coords (account for zoom/pan)
  2. Validate selected color
  3. POST /api/canvas/place with [{x, y, color}]
  4. Optimistic update: paint pixel immediately
  5. On error: revert pixel
```

## Architecture

### Components

```
src/app/page.js
  └── Client-side canvas app
        ├── CanvasRenderer — HTML5 Canvas element, ImageData management
        ├── ColorPicker — 32-color palette grid
        ├── CanvasControls — Zoom buttons, coordinates display
        └── UserInfo — Credit counter, auth status
```

### `src/app/components/canvas-renderer.js`

Core rendering component. Manages:
- Canvas element ref
- ImageData buffer (2048x2048 RGBA)
- Zoom level and pan offset
- Mouse/touch event handlers for pan, zoom, click-to-place
- SSE connection lifecycle

### `src/app/components/color-picker.js`

- Grid of 32 color swatches
- Selected color highlighted
- Click to select

### `src/app/components/canvas-controls.js`

- Zoom in/out buttons
- Reset view button
- Coordinates display (current hover position)
- Scroll wheel zoom

### `src/app/components/user-info.js`

- Display remaining credits (poll or derive from last placement response)
- Login/logout button (Phase 6)
- Cooldown timer visualization

## Related Code Files

### Create
- `src/app/components/canvas-renderer.js`
- `src/app/components/color-picker.js`
- `src/app/components/canvas-controls.js`
- `src/app/components/user-info.js`
- `src/app/hooks/use-canvas-state.js` — shared state hook
- `src/app/hooks/use-sse-updates.js` — SSE connection hook

### Modify
- `src/app/page.js` — compose components
- `src/app/globals.css` — canvas styles
- `src/app/layout.js` — metadata, viewport

## Implementation Steps

1. **Binary decoding utility** (`src/lib/canvas-decoder.js` — client-side)
   - `decodeCanvas(buffer)` → Uint8Array of color indices
   - Read 5-bit values from packed binary: bit manipulation with DataView
   - `indicesToImageData(indices, palette)` → ImageData (RGBA)

2. **Canvas renderer component**
   - `useRef` for canvas element
   - On mount: fetch `/api/canvas`, decode, render with `putImageData`
   - Track zoom (1x-40x) and pan offset in state
   - Apply transform: scale canvas context or use CSS transform
   - Mouse events:
     - `mousedown` + `mousemove` → pan (when not placing)
     - `click` → place pixel (when color selected)
     - `wheel` → zoom in/out centered on cursor
   - Touch events for mobile: pinch-to-zoom, drag-to-pan

3. **SSE updates hook**
   - `useSSEUpdates(onBatch)` custom hook
   - Create `EventSource('/api/canvas/stream?since={ts}')`
   - On message: parse JSON, call `onBatch(pixels)`
   - Handle reconnection (EventSource does this natively)
   - Track last event timestamp for reconnect `since` param

4. **Color picker component**
   - Display 32 colors in 4x8 or 8x4 grid
   - CSS grid layout
   - Selected state with border/highlight
   - Keyboard shortcuts (number keys for quick select)

5. **Canvas controls**
   - Zoom level display (e.g., "4x")
   - +/- buttons
   - "Reset" to fit canvas in viewport
   - Coordinate display updating on mousemove

6. **User info component**
   - Display credit count from last placement response
   - Animate credit regeneration client-side (increment every second)
   - Show "Ready" / "Cooldown: Xs" status

7. **Main page composition**
   - Import all components
   - Shared state via `use-canvas-state.js` hook or props
   - Layout: canvas fills viewport, color picker bottom, controls top-right, user-info top-left

## Todo List

- [ ] Create binary decoder (5-bit unpacking to RGBA)
- [ ] Create canvas-renderer with zoom/pan
- [ ] Create SSE updates hook
- [ ] Create color-picker component
- [ ] Create canvas-controls component
- [ ] Create user-info component
- [ ] Compose in page.js
- [ ] Add mobile touch support (pinch-zoom, drag-pan)
- [ ] Style with globals.css
- [ ] Test: full canvas loads and renders
- [ ] Test: click places pixel with optimistic update
- [ ] Test: SSE updates render in real-time
- [ ] Test: zoom/pan works smoothly

## Success Criteria
- Canvas loads and renders 2048x2048 pixels from API
- Zoom in/out works (1x to 40x), smooth with mouse wheel
- Pan by click-drag works
- Color picker shows 32 colors, selection is visible
- Clicking canvas with selected color sends POST and updates pixel
- SSE updates from other users appear within 1 second
- Mobile: pinch-zoom and drag-pan functional
- Credits display updates after placement

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 2.5MB canvas download slow on mobile | Med | Med | Gzip reduces to ~1.5MB; show loading indicator |
| Canvas rendering performance at 40x zoom | Med | Med | Only render visible viewport tiles; use `drawImage` with source rect |
| 5-bit decoding bugs (off-by-one) | Med | High | Unit test decoder with known byte sequences |
| Touch event conflicts (pan vs place) | Med | Med | Long-press to place on mobile; short drag = pan |

## Failure Modes
1. **Canvas download fails** → Show error + retry button; cache last successful state in localStorage
2. **SSE disconnects** → EventSource auto-reconnects; on reconnect, fetch full canvas to resync
3. **Optimistic update wrong** → On POST error, revert pixel to previous color from ImageData backup
4. **Memory pressure (2048x2048 ImageData = 16MB RGBA)** → Acceptable for modern browsers; warn if <2GB RAM detected

## Rollback
Revert page.js to stub. Remove component files. Backend remains functional (testable via curl).
