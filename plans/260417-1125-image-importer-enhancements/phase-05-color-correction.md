# Phase 05 — Color Correction Sliders

## Overview
- **Priority:** P2 (medium)
- **Status:** Todo
- Sliders to adjust brightness, contrast, saturation, and gamma so photos map better onto our 32-color palette.

## Key Insights
- The 32-color palette is narrow. A slightly dark photo can palette-quantize entirely to black+dark-grey. Bumping brightness/contrast recovers detail.
- Saturation matters because our palette has vivid primaries — desaturating a photo first avoids neon-looking output.
- Gamma interacts well with dithering: mid-gamma lets dithering distribute error over mid-tones.

## Requirements
- Sliders:
  - Brightness: -100 to +100 (default 0)
  - Contrast: -100 to +100 (default 0)
  - Saturation: -100 to +100 (default 0)
  - Gamma: 0.1 to 3.0 (default 1.0)
- Reset button.
- Reactive — moving a slider re-quantizes and re-renders preview.

## Architecture
New module `src/lib/image-color-correction.js`:
- `applyColorCorrection(rgba, w, h, { brightness, contrast, saturation, gamma }) → Uint8ClampedArray`
- Pure, framework-free.

Inserted in pipeline after transform, before resize (applies at source resolution, better fidelity):
```
srcRgba → transform → colorCorrect → resize → palette
```
(Order note: applying after resize is cheaper but loses precision on gamma — keep at source res unless preview lag becomes a problem. If so, switch to post-resize.)

## Related Code Files
- `src/lib/image-color-correction.js` (new)
- `src/client/components/ImageImporter.svelte` (slider group)
- `scripts/image-to-colors.js` (flags: `--brightness`, `--contrast`, `--saturation`, `--gamma`)
- `test/lib/image-color-correction.test.js` (new)

## Implementation Steps
1. Implement brightness/contrast/saturation/gamma per-pixel. Reference: WPlace `applyColorCorrection`. Convert RGB→HSV for saturation, adjust S, HSV→RGB.
2. Unit tests: brightness +100 saturates to 255; gamma 1 is identity; etc.
3. Add slider group in importer with live reactive updates (debounce ~50ms if jank).
4. CLI flags.

## Todo
- [ ] `image-color-correction.js` + tests
- [ ] Sliders + reset button
- [ ] CLI flags
- [ ] Verify no jank on 512×512 with live slider

## Success Criteria
- Default sliders → output identical to previous pipeline (regression guard).
- Brightness/contrast/saturation/gamma each visibly change output in expected direction.
- Build + tests green.

## Risks
- Perf: re-running full pipeline per slider tick. Mitigation: debounce, or operate on post-resize buffer once resize is stable.

## Next Steps
- None blocking.
