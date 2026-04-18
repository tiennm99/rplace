import { describe, it, expect } from 'vitest';
import { decodeCanvas, indicesToRgba } from '../../src/lib/canvas-decoder.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, COLORS_RGBA, MAX_COLORS } from '../../src/lib/constants.js';

const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;
const EXPECTED_BYTES = TOTAL_PIXELS; // 1 byte per pixel

describe('decodeCanvas', () => {
  it('accepts a full zero-filled buffer', () => {
    const buffer = new ArrayBuffer(EXPECTED_BYTES);
    const indices = decodeCanvas(buffer);
    expect(indices.length).toBe(TOTAL_PIXELS);
    expect(indices.every((v) => v === 0)).toBe(true);
  });

  it('throws on truncated buffer', () => {
    expect(() => decodeCanvas(new ArrayBuffer(0))).toThrow(/truncated/);
    expect(() => decodeCanvas(new ArrayBuffer(EXPECTED_BYTES - 1))).toThrow(/truncated/);
  });

  it('returns bytes as-is when lengths match (identity decode)', () => {
    const bytes = new Uint8Array(EXPECTED_BYTES);
    bytes[0] = 200; bytes[1] = 42; bytes[EXPECTED_BYTES - 1] = 99;
    const decoded = decodeCanvas(bytes);
    expect(decoded[0]).toBe(200);
    expect(decoded[1]).toBe(42);
    expect(decoded[EXPECTED_BYTES - 1]).toBe(99);
  });

  it('handles all 256 color values', () => {
    const bytes = new Uint8Array(EXPECTED_BYTES);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = decodeCanvas(bytes);
    for (let i = 0; i < 256; i++) expect(decoded[i]).toBe(i);
  });

  it('slices when given a larger buffer', () => {
    const bytes = new Uint8Array(EXPECTED_BYTES + 10);
    bytes[EXPECTED_BYTES - 1] = 7;
    const decoded = decodeCanvas(bytes);
    expect(decoded.length).toBe(EXPECTED_BYTES);
    expect(decoded[EXPECTED_BYTES - 1]).toBe(7);
  });
});

describe('indicesToRgba', () => {
  it('produces correct RGBA across a sampling of palette indices', () => {
    const samples = [0, 1, 15, 16, 50, 120, 200, 255];
    const indices = new Uint8Array(samples);
    const rgba = indicesToRgba(indices);

    expect(rgba.length).toBe(samples.length * 4);
    samples.forEach((paletteIdx, i) => {
      const [r, g, b, a] = COLORS_RGBA[paletteIdx];
      expect(rgba[i * 4]).toBe(r);
      expect(rgba[i * 4 + 1]).toBe(g);
      expect(rgba[i * 4 + 2]).toBe(b);
      expect(rgba[i * 4 + 3]).toBe(a);
    });
  });

  it('always sets alpha to 255', () => {
    const indices = new Uint8Array([0, 15, 100, 255]);
    const rgba = indicesToRgba(indices);
    for (let i = 0; i < indices.length; i++) {
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('returns Uint8ClampedArray', () => {
    const rgba = indicesToRgba(new Uint8Array([0]));
    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
  });
});

describe('COLORS / COLORS_RGBA consistency', () => {
  it('has MAX_COLORS (256) entries', () => {
    expect(COLORS.length).toBe(MAX_COLORS);
    expect(COLORS_RGBA.length).toBe(MAX_COLORS);
  });

  it('each hex string maps to its RGBA tuple', () => {
    for (let i = 0; i < COLORS.length; i++) {
      const hex = COLORS[i];
      const n = parseInt(hex.slice(1), 16);
      expect(COLORS_RGBA[i][0]).toBe((n >> 16) & 0xff);
      expect(COLORS_RGBA[i][1]).toBe((n >> 8) & 0xff);
      expect(COLORS_RGBA[i][2]).toBe(n & 0xff);
      expect(COLORS_RGBA[i][3]).toBe(255);
    }
  });

  it('indices 0..15 form a monotonic grayscale ramp (black → white)', () => {
    for (let i = 0; i < 16; i++) {
      const [r, g, b] = COLORS_RGBA[i];
      expect(r).toBe(g);
      expect(g).toBe(b);
      if (i > 0) expect(r).toBeGreaterThan(COLORS_RGBA[i - 1][0]);
    }
    expect(COLORS_RGBA[0]).toEqual([0, 0, 0, 255]);
    expect(COLORS_RGBA[15]).toEqual([255, 255, 255, 255]);
  });
});
