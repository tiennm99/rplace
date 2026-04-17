# Image Importer Enhancements

Reference: [WPlace-AutoBOT image-processor.js](https://github.com/Wplace-AutoBot/WPlace-AutoBOT/blob/main/Extension/scripts/image-processor.js).

## Goal
Grow the in-app Image Import panel into a full pre-placement pipeline: resize, transforms, tune, quantize with multiple dither algorithms, overlay-preview on canvas, then upload.

## Principles
- YAGNI/KISS — only add the features with clear UX value on our 2048x2048, 32-color canvas.
- DRY — all pixel transforms live in `src/lib/image-*.js` and are reused by the CLI (`scripts/image-to-colors.js`).
- Keep reactivity driven by `$effect` over a cached source RGBA buffer; each toggle re-runs the pipeline without re-decoding the file.
- Never block manual drawing; uploader continues sharing the server-side rate limit.

## Phases

| # | Phase | Status | Value |
|---|---|---|---|
| 1 | [Resize controls](phase-01-resize-controls.md) | Done | Must-have — user explicitly asked |
| 2 | [Overlay preview on canvas](phase-02-overlay-preview.md) | Done | High — visualize alignment before spending credits |
| 3 | [Transforms (flip / rotate)](phase-03-transforms.md) | Done | Medium — quick fixes without re-editing source |
| 4 | [More dithering algorithms](phase-04-dithering-algorithms.md) | Todo | Medium — different looks per source |
| 5 | [Color correction sliders](phase-05-color-correction.md) | Todo | Medium — photos benefit most |
| 6 | [Skip-white + paint-transparent toggles](phase-06-skip-white.md) | Todo | Low — easy win, often useful for logos |

Later / parked: multi-algorithm color distance (Lab/Oklab), Kuwahara smoothing, template save/load, repair mode. Revisit after Phase 6.

## Dependencies
- Phase 1 (resize) blocks Phase 2 (overlay needs final dimensions) and Phase 3 (transforms sit before or after resize, but the pipeline shape is set by Phase 1).
- Phases 4, 5, 6 are independent of each other.

## Shared pipeline shape (locked after Phase 1)
```
File → decode → srcRgba
            ↓  (reactive on: resize/transforms/color-correction/dither/skip-white)
        pipeline()
            ↓
        Int16Array paletteIndices
            ↓
        preview (palette → RGBA)
        + buildPixels(originX, originY, skipMatching) → upload
```

All steps operate on RGBA buffers so they compose. `rgbaToPalette` stays the final step.
