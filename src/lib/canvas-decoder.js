import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA } from './constants';

/**
 * Decode 5-bit packed canvas buffer into an array of color indices.
 * @param {ArrayBuffer} buffer - raw canvas bytes
 * @returns {Uint8Array} color index per pixel (length = CANVAS_WIDTH * CANVAS_HEIGHT)
 */
export function decodeCanvas(buffer) {
  const bytes = new Uint8Array(buffer);
  const totalPixels = CANVAS_WIDTH * CANVAS_HEIGHT;
  const indices = new Uint8Array(totalPixels);

  let bitPos = 0;
  for (let i = 0; i < totalPixels; i++) {
    const byteIndex = bitPos >> 3;
    const bitOffset = bitPos & 7;
    // Read 5 bits spanning at most 2 bytes
    const value =
      ((bytes[byteIndex] << 8 | (bytes[byteIndex + 1] || 0)) >> (11 - bitOffset)) & 0x1f;
    indices[i] = value;
    bitPos += 5;
  }

  return indices;
}

/**
 * Convert color indices array to RGBA ImageData pixels.
 * @param {Uint8Array} indices - color index per pixel
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
