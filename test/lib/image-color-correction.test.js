import { describe, it, expect } from 'vitest';
import { applyColorCorrection } from '../../src/lib/image-color-correction.js';

function solid(w, h, r, g, b, a = 255) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

describe('applyColorCorrection', () => {
  it('identity (all defaults) returns a copy of the input', () => {
    const src = solid(2, 2, 100, 150, 200, 220);
    const out = applyColorCorrection(src, 2, 2);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
  });

  it('brightness +100 clamps grey pixels to 255', () => {
    const src = solid(1, 1, 128, 128, 128);
    const out = applyColorCorrection(src, 1, 1, { brightness: 100 });
    // 128 + 255 = 383, clamped to 255
    expect([out[0], out[1], out[2]]).toEqual([255, 255, 255]);
  });

  it('brightness -100 clamps grey pixels to 0', () => {
    const src = solid(1, 1, 128, 128, 128);
    const out = applyColorCorrection(src, 1, 1, { brightness: -100 });
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
  });

  it('contrast +100 pushes dark darker and bright brighter', () => {
    const dark = solid(1, 1, 50, 50, 50);
    const bright = solid(1, 1, 200, 200, 200);
    const dOut = applyColorCorrection(dark, 1, 1, { contrast: 100 });
    const bOut = applyColorCorrection(bright, 1, 1, { contrast: 100 });
    expect(dOut[0]).toBeLessThan(50);
    expect(bOut[0]).toBeGreaterThan(200);
  });

  it('contrast 0 is identity (within rounding)', () => {
    const src = solid(1, 1, 100, 100, 100);
    const out = applyColorCorrection(src, 1, 1, { contrast: 0 });
    expect([out[0], out[1], out[2]]).toEqual([100, 100, 100]);
  });

  it('saturation -100 produces greyscale (R=G=B)', () => {
    const src = solid(1, 1, 200, 80, 30);
    const out = applyColorCorrection(src, 1, 1, { saturation: -100 });
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
  });

  it('gamma 1 is identity; gamma > 1 brightens midtones', () => {
    const src = solid(1, 1, 128, 128, 128);
    const id = applyColorCorrection(src, 1, 1, { gamma: 1 });
    expect(id[0]).toBe(128);
    const bright = applyColorCorrection(src, 1, 1, { gamma: 2.2 });
    expect(bright[0]).toBeGreaterThan(128);
  });

  it('gamma < 1 darkens midtones', () => {
    const src = solid(1, 1, 128, 128, 128);
    const out = applyColorCorrection(src, 1, 1, { gamma: 0.5 });
    expect(out[0]).toBeLessThan(128);
  });

  it('alpha channel is preserved unchanged', () => {
    const src = solid(1, 1, 50, 100, 150, 77);
    const out = applyColorCorrection(src, 1, 1, { brightness: 50, contrast: 50, saturation: 50, gamma: 2.2 });
    expect(out[3]).toBe(77);
  });
});
