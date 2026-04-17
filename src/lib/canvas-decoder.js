import { CANVAS_WIDTH, CANVAS_HEIGHT, BITS_PER_PIXEL, COLORS_RGBA } from './constants.js';

const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;
const EXPECTED_BYTES = Math.ceil((TOTAL_PIXELS * BITS_PER_PIXEL) / 8);

/**
 * Decode 5-bit packed canvas buffer into an array of color indices.
 * Throws if buffer is shorter than the canvas size — silent zero-padding masks corruption.
 * @param {ArrayBuffer} buffer - raw canvas bytes
 * @returns {Uint8Array} color index per pixel
 */
export function decodeCanvas(buffer) {
  if (buffer.byteLength < EXPECTED_BYTES) {
    throw new Error(`Canvas buffer truncated: got ${buffer.byteLength} bytes, expected ${EXPECTED_BYTES}`);
  }
  const bytes = new Uint8Array(buffer);
  const indices = new Uint8Array(TOTAL_PIXELS);

  let bitPos = 0;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const byteIndex = bitPos >> 3;
    const bitOffset = bitPos & 7;
    const value = ((bytes[byteIndex] << 8 | bytes[byteIndex + 1]) >> (11 - bitOffset)) & 0x1f;
    indices[i] = value;
    bitPos += 5;
  }

  return indices;
}

/**
 * Convert color indices array to RGBA ImageData pixels.
 * @param {Uint8Array} indices
 * @returns {Uint8ClampedArray} RGBA data for ImageData
 */
export function indicesToRgba(indices) {
  const rgba = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const color = COLORS_RGBA[indices[i]] || COLORS_RGBA[0];
    const offset = i * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = color[3];
  }
  return rgba;
}
