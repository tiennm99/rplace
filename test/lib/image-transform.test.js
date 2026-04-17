import { describe, it, expect } from 'vitest';
import { transformRgba } from '../../src/lib/image-transform.js';

/** Build an RGBA buffer where pixel (x, y) has red = (y*w+x+1)*10, green = y, blue = x.
 *  Unique per-pixel so we can assert exact placement after transforms. */
function build(w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = (y * w + x + 1) * 10;
      out[i + 1] = y;
      out[i + 2] = x;
      out[i + 3] = 255;
    }
  }
  return out;
}

function pixel(rgba, w, x, y) {
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

describe('transformRgba', () => {
  it('identity (no flips, rotation=0) returns input copy', () => {
    const src = build(2, 3);
    const { rgba, width, height } = transformRgba(src, 2, 3);
    expect(width).toBe(2);
    expect(height).toBe(3);
    expect(rgba).toEqual(src);
    expect(rgba).not.toBe(src);
  });

  it('flipH mirrors columns', () => {
    const src = build(3, 2);
    const { rgba, width, height } = transformRgba(src, 3, 2, { flipH: true });
    expect(width).toBe(3);
    expect(height).toBe(2);
    // Row 0: src cols 0,1,2 → dst cols 2,1,0
    expect(pixel(rgba, 3, 0, 0)).toEqual(pixel(src, 3, 2, 0));
    expect(pixel(rgba, 3, 2, 0)).toEqual(pixel(src, 3, 0, 0));
  });

  it('flipV mirrors rows', () => {
    const src = build(2, 3);
    const { rgba } = transformRgba(src, 2, 3, { flipV: true });
    expect(pixel(rgba, 2, 0, 0)).toEqual(pixel(src, 2, 0, 2));
    expect(pixel(rgba, 2, 0, 2)).toEqual(pixel(src, 2, 0, 0));
  });

  it('rotate 90° CW swaps dims and maps top-left → top-right', () => {
    const src = build(2, 3); // 2 wide, 3 tall
    const { rgba, width, height } = transformRgba(src, 2, 3, { rotation: 90 });
    expect(width).toBe(3); // h
    expect(height).toBe(2); // w
    // src (0,0) is top-left → dst top-right, i.e. (width-1, 0) = (2, 0)
    expect(pixel(rgba, 3, 2, 0)).toEqual(pixel(src, 2, 0, 0));
    // src (1, 0) top-right → dst bottom-right (2, 1)
    expect(pixel(rgba, 3, 2, 1)).toEqual(pixel(src, 2, 1, 0));
    // src (0, 2) bottom-left → dst top-left (0, 0)
    expect(pixel(rgba, 3, 0, 0)).toEqual(pixel(src, 2, 0, 2));
  });

  it('rotate 180° flips both axes', () => {
    const src = build(2, 3);
    const { rgba, width, height } = transformRgba(src, 2, 3, { rotation: 180 });
    expect(width).toBe(2);
    expect(height).toBe(3);
    expect(pixel(rgba, 2, 0, 0)).toEqual(pixel(src, 2, 1, 2));
    expect(pixel(rgba, 2, 1, 2)).toEqual(pixel(src, 2, 0, 0));
  });

  it('rotate 270° CW is inverse of 90° CW', () => {
    const src = build(2, 3);
    const r90 = transformRgba(src, 2, 3, { rotation: 90 });
    const back = transformRgba(r90.rgba, r90.width, r90.height, { rotation: 270 });
    expect(back.width).toBe(2);
    expect(back.height).toBe(3);
    expect(back.rgba).toEqual(new Uint8ClampedArray(src));
  });

  it('flipH + flipV equals 180° rotation (for square or rectangular)', () => {
    const src = build(3, 2);
    const flipped = transformRgba(src, 3, 2, { flipH: true, flipV: true });
    const rotated = transformRgba(src, 3, 2, { rotation: 180 });
    expect(flipped.rgba).toEqual(rotated.rgba);
    expect(flipped.width).toBe(rotated.width);
    expect(flipped.height).toBe(rotated.height);
  });

  it('throws on unsupported rotation', () => {
    const src = build(2, 2);
    expect(() => transformRgba(src, 2, 2, { rotation: 45 })).toThrow();
  });
});
