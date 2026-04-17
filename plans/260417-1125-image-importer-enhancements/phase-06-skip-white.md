# Phase 06 — Skip-White / Paint-Transparent Toggles

## Overview
- **Priority:** P3 (low, easy win)
- **Status:** Todo
- Two cheap toggles: treat near-white pixels as transparent (useful for logos on white backgrounds), and optionally paint pixels with alpha < threshold as white instead of skipping.

## Requirements
- Checkbox "Skip white pixels" + threshold (0–255, default 230).
- Checkbox "Paint transparent pixels as white" (default off).
- Reactive pipeline updates.

## Architecture
Extend `rgbaToPalette` options:
```js
rgbaToPalette(rgba, w, h, {
  alphaThreshold,
  method,
  skipWhite: false,
  whiteThreshold: 230,
  paintTransparent: false,
});
```
Logic:
- `paintTransparent=true`: alpha < threshold → treat as `(255,255,255,255)` instead of `-1`.
- `skipWhite=true`: if `r,g,b >= whiteThreshold` → output `-1` (skip).
- These are mutually compatible and commute (transparent→white happens first; white-skip sees the filled-in whites).

## Related Code Files
- `src/lib/image-to-palette.js` (extend options)
- `src/client/components/ImageImporter.svelte` (checkboxes + threshold slider)
- `scripts/image-to-colors.js` (`--skip-white`, `--white-threshold`, `--paint-transparent`)
- `test/lib/image-to-palette.test.js` (extend)

## Implementation Steps
1. Extend the `rgbaToPalette` options object; defaults preserve current behavior.
2. Update both `quantizeNearest` and error-diffusion paths to check the new conditions per pixel.
3. UI checkboxes with a small threshold input next to skip-white.
4. CLI flags.
5. Tests: near-white pixel → -1 iff skipWhite on; low-alpha pixel → -1 iff paintTransparent off.

## Todo
- [ ] Extend `rgbaToPalette` options
- [ ] UI toggles + threshold
- [ ] CLI flags
- [ ] Tests

## Success Criteria
- With defaults, output matches pre-change output.
- With skipWhite on, a white-background logo uploads only the logo (no background pixels queued).
- Build + tests green.

## Risks
- Order of operations between skipWhite and paintTransparent — tests pin this down.

## Next Steps
- After Phase 6 ships, revisit parked items: multi-algorithm color distance (Lab/Oklab), Kuwahara, template save/load, repair mode.
