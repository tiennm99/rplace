# Phase 03 — Transforms (Flip / Rotate)

## Overview
- **Priority:** P2 (medium)
- **Status:** Todo
- Let the user flip horizontally, flip vertically, and rotate in 90° increments without re-exporting the source.

## Requirements
- Buttons: Flip H, Flip V, Rotate CW 90°, Rotate CCW 90°, Reset.
- Cumulative state (internal): `{ flipH: bool, flipV: bool, rotation: 0|90|180|270 }`.
- Rotations by 90 swap width/height; resize controls must reflect post-transform dims.

## Architecture
New module `src/lib/image-transform.js`:
- `transformRgba(rgba, w, h, { flipH, flipV, rotation }) → { rgba, width, height }`
- Pure function, reusable by CLI.

Applied in pipeline **before** resize so resize targets the post-transform orientation:
```
srcRgba → transformRgba → resizeRgba → rgbaToPalette
```

## Related Code Files
- `src/lib/image-transform.js` (new)
- `src/client/components/ImageImporter.svelte` (toolbar row + state)
- `scripts/image-to-colors.js` (`--rotate 90 --flip-h --flip-v` flags)
- `test/lib/image-transform.test.js` (new)

## Implementation Steps
1. Implement pure transform on flat RGBA: flips are in-row or inter-row swaps; rotations reindex `(x,y) → (y, w-1-x)` etc.
2. Unit-test for all combinations — a known 2x3 grid rotated/flipped and compared pixel-exact.
3. Wire transform state + buttons in importer; pipeline insertion before resize.
4. CLI flags + doc update.

## Todo
- [ ] `image-transform.js` + tests
- [ ] Importer buttons + state
- [ ] CLI flags
- [ ] Verify preview, overlay (Phase 2), and upload agree

## Success Criteria
- Flip/rotate buttons produce visually correct preview.
- `npm test` green.
- CLI output byte-identical between rotating in-app and rotating via CLI.

## Risks
- Low. Pure-function transforms with tests cover correctness.

## Next Steps
- None blocking; proceed to Phase 4 or 5 independently.
