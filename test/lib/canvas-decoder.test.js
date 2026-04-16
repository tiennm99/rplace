import { describe, it, expect } from 'vitest';
import { decodeCanvas, indicesToRgba } from '../../src/lib/canvas-decoder.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, COLORS_RGBA } from '../../src/lib/constants.js';

/** Encode color indices into 5-bit packed bytes (test helper, mirrors BITFIELD storage) */
function encodeIndices(indices) {
  const totalBits = indices.length * 5;
  const bytes = new Uint8Array(Math.ceil(totalBits / 8));
  for (let i = 0; i < indices.length; i++) {
    const bitPos = i * 5;
    const byteIndex = bitPos >> 3;
    const bitOffset = bitPos & 7;
    // Write 5-bit value across 1-2 bytes
    bytes[byteIndex] |= (indices[i] << (11 - bitOffset)) >> 8;
    if (bitOffset > 3) {
      bytes[byteIndex + 1] |= (indices[i] << (11 - bitOffset)) & 0xff;
    } else {
      bytes[byteIndex] |= (indices[i] << (3 - bitOffset));
    }
  }
  return bytes;
}

describe('decodeCanvas', () => {
  it('decodes empty buffer as all zeros', () => {
    const buffer = new ArrayBuffer(0);
    const indices = decodeCanvas(buffer);
    expect(indices.length).toBe(CANVAS_WIDTH * CANVAS_HEIGHT);
    expect(indices.every((v) => v === 0)).toBe(true);
  });

  it('decodes a single pixel', () => {
    // Color 15 at pixel 0: binary 01111 in first 5 bits
    // Byte 0: 0111_1000 = 0x78
    const bytes = new Uint8Array([0x78, 0]);
    const indices = decodeCanvas(bytes.buffer);
    expect(indices[0]).toBe(15);
  });

  it('round-trips all 32 color values', () => {
    const input = new Uint8Array(32);
    for (let i = 0; i < 32; i++) input[i] = i;
    const encoded = encodeIndices(input);
    const decoded = decodeCanvas(encoded.buffer);
    for (let i = 0; i < 32; i++) {
      expect(decoded[i]).toBe(i);
    }
  });

  it('round-trips repeated color patterns', () => {
    const input = new Uint8Array(100);
    for (let i = 0; i < 100; i++) input[i] = i % 32;
    const encoded = encodeIndices(input);
    const decoded = decodeCanvas(encoded.buffer);
    for (let i = 0; i < 100; i++) {
      expect(decoded[i]).toBe(i % 32);
    }
  });

  it('handles max color value (31) at various offsets', () => {
    const input = new Uint8Array(8).fill(31);
    const encoded = encodeIndices(input);
    const decoded = decodeCanvas(encoded.buffer);
    for (let i = 0; i < 8; i++) {
      expect(decoded[i]).toBe(31);
    }
  });
});

describe('indicesToRgba', () => {
  it('produces correct RGBA for all 32 colors', () => {
    const indices = new Uint8Array(32);
    for (let i = 0; i < 32; i++) indices[i] = i;
    const rgba = indicesToRgba(indices);

    expect(rgba.length).toBe(32 * 4);
    for (let i = 0; i < 32; i++) {
      const [r, g, b, a] = COLORS_RGBA[i];
      expect(rgba[i * 4]).toBe(r);
      expect(rgba[i * 4 + 1]).toBe(g);
      expect(rgba[i * 4 + 2]).toBe(b);
      expect(rgba[i * 4 + 3]).toBe(a);
    }
  });

  it('always sets alpha to 255', () => {
    const indices = new Uint8Array([0, 15, 27, 31]);
    const rgba = indicesToRgba(indices);
    for (let i = 0; i < 4; i++) {
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('returns Uint8ClampedArray', () => {
    const rgba = indicesToRgba(new Uint8Array([0]));
    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
  });
});

describe('COLORS_RGBA consistency', () => {
  it('has 32 entries matching COLORS hex values', () => {
    expect(COLORS_RGBA.length).toBe(32);
    expect(COLORS.length).toBe(32);

    for (let i = 0; i < 32; i++) {
      const hex = COLORS[i];
      const n = parseInt(hex.slice(1), 16);
      expect(COLORS_RGBA[i][0]).toBe((n >> 16) & 0xff);
      expect(COLORS_RGBA[i][1]).toBe((n >> 8) & 0xff);
      expect(COLORS_RGBA[i][2]).toBe(n & 0xff);
      expect(COLORS_RGBA[i][3]).toBe(255);
    }
  });
});
