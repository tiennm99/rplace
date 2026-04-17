# Phase 01 — Resize Controls

## Overview
- **Priority:** P0 (must-have, user requested)
- **Status:** Done
- Let the user change the output image size *before* it is palette-converted and uploaded, with a choice of resampling method so pixel art and photos both look good.

## Key Insights
- Canvas is 2048x2048 and images often don't fit. Forcing the user to pre-resize externally is friction.
- Resampling choice matters on our tiny palette: nearest preserves sharp pixel art; bilinear/box avoids aliasing on photos.
- Resize must happen *before* palette quantization — quantizing then scaling produces garbage.
- Aspect-lock prevents accidentally squishing logos; free mode supports deliberate stretch.
- HTMLCanvas `drawImage(scaled)` already provides nearest + bilinear cheaply. Box/median/dominant are pixel-art-friendly and need manual loops (see WPlace's `resampleBox`, `resampleMedian`, `resampleDominant`).

## Requirements
- Width + height number inputs, with a lock-aspect-ratio toggle.
- "Fit to canvas" helper that caps to `CANVAS_WIDTH`/`CANVAS_HEIGHT` minus current origin.
- Resampling dropdown: `nearest`, `bilinear`, `box`, `median`, `dominant` (ship at minimum `nearest` + `bilinear` in this phase; `box`/`median`/`dominant` optional).
- Reactive: changing any resize input re-runs pipeline and updates preview.
- Must keep preview snappy on 512x512 inputs (< 100ms).

## Architecture
New module `src/lib/image-resize.js` exports:
- `resizeRgba(rgba, srcW, srcH, dstW, dstH, method) → Uint8ClampedArray` — pure function operating on RGBA buffers so it's framework-free and CLI-usable.

`ImageImporter.svelte` adds resize state (`resizeW`, `resizeH`, `lockAspect`, `resampleMethod`) and inserts resize as the first pipeline step before `rgbaToPalette`.

```
srcRgba (srcW×srcH)
  → resizeRgba(rgba, srcW, srcH, resizeW, resizeH, method)
  → rgbaToPalette(resized, resizeW, resizeH, { dither })
```

## Related Code Files
**Modify:**
- `src/client/components/ImageImporter.svelte` — add UI + pipeline wiring
- `scripts/image-to-colors.js` — add `--width`, `--height`, `--method` flags (DRY with lib)

**Create:**
- `src/lib/image-resize.js` — resize function(s)
- `test/lib/image-resize.test.js` — unit tests

## Implementation Steps
1. Write `src/lib/image-resize.js` with `resampleNearest`, `resampleBilinear` (both via OffscreenCanvas `imageSmoothingEnabled`). Add `resampleBox` and `resampleMedian` only if time permits (optional stretch).
2. Export `resizeRgba(rgba, srcW, srcH, dstW, dstH, method = 'nearest')` — dispatches to the right resampler and returns a fresh `Uint8ClampedArray`.
3. Add unit tests: identity-resize (same dims) returns equivalent data; down/up scale by integer factors produce expected shape; unknown method falls back to nearest.
4. In `ImageImporter.svelte`:
   - Add state `resizeW`, `resizeH`, `lockAspect`, `resampleMethod` (default source dims, lock on, nearest).
   - When file loads, init `resizeW/resizeH` to source dims.
   - Reactive `$derived` or `$effect` computes `workingRgba` = `resizeRgba(srcRgba, srcW, srcH, resizeW, resizeH, method)`.
   - Feed `workingRgba` into `rgbaToPalette`. Preview canvas uses `resizeW/resizeH`.
   - Aspect-lock updates the other dim when one changes.
   - "Fit to canvas" button clamps to `CANVAS_WIDTH - originX` / `CANVAS_HEIGHT - originY` preserving aspect.
5. Update validation: overflow check uses `resizeW/resizeH`, not source dims.
6. CLI: add `--width`, `--height`, `--method` flags to `scripts/image-to-colors.js`, routing through the same `resizeRgba`. Keep defaults = source dims so behavior unchanged.

## Todo
- [x] `src/lib/image-resize.js` with `resizeRgba` + nearest/bilinear/box resamplers
- [x] Unit tests `test/lib/image-resize.test.js` (8 tests)
- [x] Wire into `ImageImporter.svelte` (state, pipeline, UI controls, aspect lock, "Fit to canvas", "1:1")
- [x] CLI flags in `scripts/image-to-colors.js` (`--width`, `--height`, `--method`)
- [x] `npm run build` + `npm test` green (84/84 tests)

## Success Criteria
- Upload a 512x512 photo, resize to 128x128 in-app, see palette preview update within one paint, upload fills a 128x128 area on canvas correctly.
- `node scripts/image-to-colors.js foo.png --width 128 --height 128 --method bilinear` produces same output pixel count (`128*128 = 16384`).
- All 76 existing tests still pass; new tests green.

## Risks
- Forgetting to rebase the pipeline on `workingRgba` everywhere → stale preview vs upload. Mitigation: single `$effect` owns the pipeline end-to-end; `buildPixels` reads the same `paletteIndices`.
- Very large upscales (e.g. 2000x2000) blow compute on preview re-render. Mitigation: cap resize inputs at `CANVAS_WIDTH`/`CANVAS_HEIGHT`.

## Next Steps
- Phase 2 builds on the final `resizeW/resizeH` to overlay the preview on the main canvas at `(originX, originY)`.
