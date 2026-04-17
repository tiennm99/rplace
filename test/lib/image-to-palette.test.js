import { describe, it, expect } from 'vitest';
import { rgbaToPalette, nearestColorIndex, paletteToRgba, DITHER_METHODS } from '../../src/lib/image-to-palette.js';
import { ERROR_DIFFUSION_KERNELS } from '../../src/lib/dither-kernels.js';

function solidRgba(w, h, r, g, b, a = 255) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

describe('rgbaToPalette', () => {
  it('nearest (default / method=none) picks exact palette hits', () => {
    // #ff4500 is palette index 2. Feed that exact color.
    const src = solidRgba(2, 2, 0xff, 0x45, 0x00);
    const idx = rgbaToPalette(src, 2, 2);
    expect([...idx]).toEqual([2, 2, 2, 2]);
  });

  it('transparent pixels become -1', () => {
    const src = solidRgba(1, 1, 255, 0, 0, 10); // low alpha
    const idx = rgbaToPalette(src, 1, 1, { alphaThreshold: 128 });
    expect(idx[0]).toBe(-1);
  });

  it('dither:true is equivalent to method:"floyd"', () => {
    const src = solidRgba(4, 4, 120, 120, 120);
    const a = rgbaToPalette(src, 4, 4, { dither: true });
    const b = rgbaToPalette(src, 4, 4, { method: 'floyd' });
    expect([...a]).toEqual([...b]);
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
      // Every index must be valid palette (0..31) since all pixels are opaque.
      for (let i = 0; i < idx.length; i++) {
        expect(idx[i]).toBeGreaterThanOrEqual(0);
        expect(idx[i]).toBeLessThan(32);
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
    const src = solidRgba(4, 4, 0x00, 0x00, 0x00); // palette 27 (#000000)
    for (const method of ['floyd', 'atkinson', 'jarvis', 'burkes', 'sierra', 'sierra-lite']) {
      const idx = rgbaToPalette(src, 4, 4, { method });
      expect([...idx].every((v) => v === 27)).toBe(true);
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

  it('paintTransparent maps transparent pixels to palette white (31)', () => {
    const src = new Uint8ClampedArray([
      100, 100, 100, 10,  // transparent
      255, 255, 255, 255, // white
    ]);
    const idx = rgbaToPalette(src, 2, 1, { paintTransparent: true });
    expect(idx[0]).toBe(31); // ffffff
    expect(idx[1]).toBe(31);
  });

  it('paintTransparent + skipWhite: transparent pixels end up skipped', () => {
    const src = new Uint8ClampedArray([100, 100, 100, 10]);
    const idx = rgbaToPalette(src, 1, 1, { paintTransparent: true, skipWhite: true });
    expect(idx[0]).toBe(-1);
  });
});

describe('nearestColorIndex', () => {
  it('exact palette match returns that index', () => {
    // Palette 0 is #6d001a → (0x6d, 0x00, 0x1a)
    expect(nearestColorIndex(0x6d, 0x00, 0x1a)).toBe(0);
  });
  it('pure white maps to palette 31 (#ffffff)', () => {
    expect(nearestColorIndex(255, 255, 255)).toBe(31);
  });
  it('pure black maps to palette 27 (#000000)', () => {
    expect(nearestColorIndex(0, 0, 0)).toBe(27);
  });
});

describe('paletteToRgba', () => {
  it('valid indices map to their palette RGB', () => {
    const rgba = paletteToRgba([27, 31], 2, 1);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 0]);        // black
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([255, 255, 255]);  // white
  });
  it('-1 renders as a checkerboard cell, alpha 255', () => {
    const rgba = paletteToRgba([-1], 1, 1);
    expect(rgba[3]).toBe(255);
    expect(rgba[0]).toBe(rgba[1]); // greyscale
    expect(rgba[0]).toBe(rgba[2]);
  });
});
