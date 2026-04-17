import { describe, it, expect } from 'vitest';
import { resizeRgba } from '../../src/lib/image-resize.js';

/** Build an RGBA buffer from a function (x,y) → [r,g,b,a]. */
function build(w, h, fn) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

describe('resizeRgba', () => {
  it('identity (same dims) returns copy with same contents', () => {
    const src = build(3, 2, (x, y) => [x * 10, y * 20, 0, 255]);
    const out = resizeRgba(src, 3, 2, 3, 2);
    expect(out).toEqual(new Uint8ClampedArray(src));
    expect(out).not.toBe(src); // must be a fresh buffer
  });

  it('throws on zero or negative destination dims', () => {
    const src = new Uint8ClampedArray(4);
    expect(() => resizeRgba(src, 1, 1, 0, 1)).toThrow();
    expect(() => resizeRgba(src, 1, 1, 1, -1)).toThrow();
  });

  it('nearest 2x downscale picks one of each 2x2 block (integer factor)', () => {
    // 4x4 where each 2x2 block has a unique color
    const src = build(4, 4, (x, y) => {
      const bx = x >> 1, by = y >> 1;
      return [bx * 80, by * 80, 0, 255];
    });
    const out = resizeRgba(src, 4, 4, 2, 2, 'nearest');
    expect(out.length).toBe(2 * 2 * 4);
    // Each output pixel must equal one of the four pixels in its source block.
    // For default nearest (floor), 2x downscale picks the top-left of the block.
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
    expect([out[4], out[5], out[6]]).toEqual([80, 0, 0]);
    expect([out[8], out[9], out[10]]).toEqual([0, 80, 0]);
    expect([out[12], out[13], out[14]]).toEqual([80, 80, 0]);
  });

  it('nearest 2x upscale duplicates pixels', () => {
    const src = build(2, 1, (x) => [x * 255, 0, 0, 255]);
    const out = resizeRgba(src, 2, 1, 4, 2, 'nearest');
    // Each source pixel appears in a 2x2 block
    expect([out[0], out[4]]).toEqual([0, 0]);
    expect([out[8], out[12]]).toEqual([255, 255]);
    expect([out[16], out[20]]).toEqual([0, 0]);
    expect([out[24], out[28]]).toEqual([255, 255]);
  });

  it('bilinear produces an in-between value at the midpoint', () => {
    // Two pixels: black (0) and white (255). Midpoint should blend toward 127/128.
    const src = build(2, 1, (x) => [x * 255, x * 255, x * 255, 255]);
    const out = resizeRgba(src, 2, 1, 3, 1, 'bilinear');
    // out[1] is the middle pixel — must be strictly between the endpoints.
    const mid = out[4];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
    // Endpoints are preserved
    expect(out[0]).toBe(0);
    expect(out[8]).toBe(255);
  });

  it('box averages a 2x2 block on 2x downscale', () => {
    const src = build(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [0, 0, 0, 255];
      if (x === 1 && y === 0) return [100, 0, 0, 255];
      if (x === 0 && y === 1) return [0, 100, 0, 255];
      return [100, 100, 0, 255];
    });
    const out = resizeRgba(src, 2, 2, 1, 1, 'box');
    expect(out.length).toBe(4);
    expect(out[0]).toBe(50); // avg of 0, 100, 0, 100
    expect(out[1]).toBe(50);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(255);
  });

  it('unknown method falls back to nearest', () => {
    const src = build(2, 1, (x) => [x * 255, 0, 0, 255]);
    const out = resizeRgba(src, 2, 1, 4, 1, /** @type any */ ('mystery'));
    // Should be nearest-neighbor output: 0,0,255,255
    expect([out[0], out[4], out[8], out[12]]).toEqual([0, 0, 255, 255]);
  });

  it('preserves alpha channel', () => {
    const src = build(2, 1, (x) => [255, 0, 0, x === 0 ? 0 : 128]);
    const out = resizeRgba(src, 2, 1, 2, 1, 'nearest');
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(128);
  });
});
