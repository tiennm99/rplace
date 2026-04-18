import { describe, it, expect } from 'vitest';
import { rgbaToPalette, nearestColorIndex, paletteToRgba, DITHER_METHODS } from '../../src/lib/image-to-palette.js';
import { ERROR_DIFFUSION_KERNELS } from '../../src/lib/dither-kernels.js';
import { COLORS_RGBA } from '../../src/lib/constants.js';

// Palette indices anchored to the new 256-color palette layout:
//   0..15 = grayscale ramp (0 = pure black, 15 = pure white)
const PALETTE_BLACK = 0;
const PALETTE_WHITE = 15;

function solidRgba(w, h, r, g, b, a = 255) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

describe('rgbaToPalette', () => {
  it('nearest (default / method=none) picks exact palette hits', () => {
    // Pick an actual palette entry from the new palette and feed it back.
    const probeIdx = 120;
    const [r, g, b] = COLORS_RGBA[probeIdx];
    const src = solidRgba(2, 2, r, g, b);
    const idx = rgbaToPalette(src, 2, 2);
    expect([...idx]).toEqual([probeIdx, probeIdx, probeIdx, probeIdx]);
  });

  it('transparent pixels become -1', () => {
    const src = solidRgba(1, 1, 255, 0, 0, 10); // low alpha
    const idx = rgbaToPalette(src, 1, 1, { alphaThreshold: 128 });
    expect(idx[0]).toBe(-1);
  });

  it('throws on unknown method', () => {
    const src = solidRgba(1, 1, 0, 0, 0);
    expect(() => rgbaToPalette(src, 1, 1, { method: 'nope' })).toThrow(/nope/i);
  });

  it('all documented methods run and return correct length', () => {
    const w = 8, h = 8;
    const src = solidRgba(w, h, 100, 150, 200);
    for (const method of DITHER_METHODS) {
      const idx = rgbaToPalette(src, w, h, { method });
      expect(idx.length).toBe(w * h);
      // Every index must be a valid opaque palette entry since all source pixels are opaque.
      for (let i = 0; i < idx.length; i++) {
        expect(idx[i]).toBeGreaterThanOrEqual(0);
        expect(idx[i]).toBeLessThan(256);
      }
    }
  });

  it('error-diffusion kernels have weights that sum sensibly', () => {
    // Most kernels fully diffuse (sum = 1.0); Atkinson deliberately diffuses
    // only 6/8 = 0.75. Assert both cases.
    for (const [name, kernel] of Object.entries(ERROR_DIFFUSION_KERNELS)) {
      const sum = kernel.reduce((s, [, , w]) => s + w, 0);
      if (name === 'atkinson') {
        expect(sum).toBeCloseTo(0.75, 5);
      } else {
        expect(sum).toBeCloseTo(1.0, 5);
      }
    }
  });

  it('on a solid-color image, dither produces the same single color everywhere', () => {
    // Feeding one exact palette color means zero error → all methods converge.
    const src = solidRgba(4, 4, 0, 0, 0); // pure black = palette index 0
    for (const method of ['floyd', 'atkinson', 'jarvis', 'burkes', 'sierra', 'sierra-lite']) {
      const idx = rgbaToPalette(src, 4, 4, { method });
      expect([...idx].every((v) => v === PALETTE_BLACK)).toBe(true);
    }
  });

  it('bayer ordered dither varies spatially on a mid-grey input', () => {
    // Grey (128,128,128) sits between palette greys. Bayer should produce
    // multiple distinct indices across the tile, not a single solid color.
    const src = solidRgba(8, 8, 128, 128, 128);
    const idx = rgbaToPalette(src, 8, 8, { method: 'bayer-4' });
    const unique = new Set([...idx]);
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('rgbaToPalette skip-white / paint-transparent', () => {
  it('skipWhite marks near-white source pixels as -1', () => {
    const src = new Uint8ClampedArray([
      255, 255, 255, 255, // white
      240, 240, 240, 255, // near-white (>= default threshold 230)
      100,   0,   0, 255, // red-ish
    ]);
    const idx = rgbaToPalette(src, 3, 1, { skipWhite: true });
    expect(idx[0]).toBe(-1);
    expect(idx[1]).toBe(-1);
    expect(idx[2]).not.toBe(-1);
  });

  it('skipWhite respects a custom whiteThreshold', () => {
    const src = new Uint8ClampedArray([
      240, 240, 240, 255, // under custom threshold
      255, 255, 255, 255, // above
    ]);
    const idx = rgbaToPalette(src, 2, 1, { skipWhite: true, whiteThreshold: 250 });
    expect(idx[0]).not.toBe(-1);
    expect(idx[1]).toBe(-1);
  });

  it('paintTransparent maps transparent pixels to palette white', () => {
    const src = new Uint8ClampedArray([
      100, 100, 100, 10,  // transparent
      255, 255, 255, 255, // white
    ]);
    const idx = rgbaToPalette(src, 2, 1, { paintTransparent: true });
    expect(idx[0]).toBe(PALETTE_WHITE);
    expect(idx[1]).toBe(PALETTE_WHITE);
  });

  it('paintTransparent + skipWhite: transparent pixels end up skipped', () => {
    const src = new Uint8ClampedArray([100, 100, 100, 10]);
    const idx = rgbaToPalette(src, 1, 1, { paintTransparent: true, skipWhite: true });
    expect(idx[0]).toBe(-1);
  });
});

describe('nearestColorIndex', () => {
  it('exact palette match returns that index', () => {
    const probe = 77;
    const [r, g, b] = COLORS_RGBA[probe];
    expect(nearestColorIndex(r, g, b)).toBe(probe);
  });
  it('pure white maps to the grayscale-white palette entry', () => {
    expect(nearestColorIndex(255, 255, 255)).toBe(PALETTE_WHITE);
  });
  it('pure black maps to the grayscale-black palette entry', () => {
    expect(nearestColorIndex(0, 0, 0)).toBe(PALETTE_BLACK);
  });
});

describe('paletteToRgba', () => {
  it('valid indices map to their palette RGB', () => {
    const rgba = paletteToRgba([PALETTE_BLACK, PALETTE_WHITE], 2, 1);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 0]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([255, 255, 255]);
  });
  it('-1 renders as a checkerboard cell, alpha 255', () => {
    const rgba = paletteToRgba([-1], 1, 1);
    expect(rgba[3]).toBe(255);
    expect(rgba[0]).toBe(rgba[1]); // greyscale
    expect(rgba[0]).toBe(rgba[2]);
  });
});
