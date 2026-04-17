# Phase 04 — More Dithering Algorithms

## Overview
- **Priority:** P2 (medium)
- **Status:** Done
- Add Atkinson, Jarvis, Stucki, Burkes, Sierra variants (error diffusion) and Bayer 2x2/4x4/8x8 ordered dithering so users can pick the visual style that fits their source.

## Key Insights
- Today we only ship Floyd-Steinberg. Atkinson produces softer output (good for photos). Bayer (ordered) creates the classic 8-bit texture (good for retro art).
- All error-diffusion kernels share the same inner loop — differ only in the kernel weights. Factor that out.
- Ordered dithering is a different algorithm: add a matrix-indexed bias before quantizing; no error propagation.

## Requirements
- Dropdown replaces the current dither checkbox: `none`, `floyd`, `atkinson`, `jarvis`, `stucki`, `burkes`, `sierra`, `sierra-lite`, `bayer-2`, `bayer-4`, `bayer-8`.
- Optional `strength` slider 0–1 for error-diffusion blends (default 1).

## Architecture
Refactor `src/lib/image-to-palette.js`:
- Extract a `runErrorDiffusion(rgba, w, h, alphaThreshold, kernel)` with the current Floyd-Steinberg loop generalized to take a kernel `[{ dx, dy, w }, …]`.
- Add `runOrderedDither(rgba, w, h, alphaThreshold, matrix)` using Bayer matrices.
- `rgbaToPalette(rgba, w, h, { alphaThreshold, method })` dispatches on `method`.
- Deprecate `dither: bool` option but keep it mapped to `method: 'floyd'` for back-compat with the CLI until the next breaking release.

## Related Code Files
- `src/lib/image-to-palette.js` (refactor)
- `src/client/components/ImageImporter.svelte` (dropdown + strength slider)
- `scripts/image-to-colors.js` (`--method` flag replaces `--dither`)
- `test/lib/image-to-palette.test.js` (extend)

## Implementation Steps
1. Extract shared kernel runner. Move FS kernel into a table.
2. Add Atkinson, Jarvis, Stucki, Burkes, Sierra, SierraLite kernels (copy weights from WPlace).
3. Add Bayer matrices (2x2, 4x4, 8x8) and the ordered-dither function.
4. Map UI dropdown → `method` option.
5. Extend unit tests: each method runs without throwing, returns correct length, transparent pixels preserved.
6. Visual regression: snapshot-test a fixed gradient across methods.

## Todo
- [x] Refactor FS into generalized error-diffusion runner (`runErrorDiffusion`)
- [x] Add Atkinson/Jarvis/Burkes/Sierra/SierraLite kernels (Stucki dropped; close to Jarvis)
- [x] Add Bayer 2/4/8 ordered dithering (`runOrderedDither`, SPREAD=48)
- [x] UI dropdown (strength slider dropped as YAGNI for now — add if users ask)
- [x] CLI `--dither-method`, kept `--dither` as floyd alias
- [x] Tests (13 cases including all-methods smoke, kernel-weight sanity)

## Success Criteria
- Each method produces distinct, visibly reasonable output on a test gradient.
- Existing `--dither` CLI flag still works (mapped to `method=floyd`).
- Build + tests green.

## Risks
- Kernel-weight typos produce wrong but still-plausible output. Mitigation: unit-test kernel sums equal 1.0.

## Next Steps
- None blocking.
