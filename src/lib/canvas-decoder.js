import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA } from './constants.js';

const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;
const EXPECTED_BYTES = TOTAL_PIXELS; // 1 byte per pixel (8-bit palette index)

/**
 * "Decode" a raw canvas buffer into color indices. With 8 bits per pixel the
 * bytes are already indices — we wrap/copy them into a Uint8Array of the
 * expected length. We throw on short buffers rather than silently zero-padding,
 * which previously masked corruption on the ingest path.
 * @param {ArrayBuffer|ArrayBufferView} buffer - raw canvas bytes
 * @returns {Uint8Array} one color index per pixel
 */
export function decodeCanvas(buffer) {
  const byteLength = buffer.byteLength;
  if (byteLength < EXPECTED_BYTES) {
    throw new Error(`Canvas buffer truncated: got ${byteLength} bytes, expected ${EXPECTED_BYTES}`);
  }
  if (buffer instanceof Uint8Array) {
    return buffer.byteLength === EXPECTED_BYTES ? buffer : buffer.subarray(0, EXPECTED_BYTES);
  }
  return new Uint8Array(
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
    buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset,
    EXPECTED_BYTES,
  );
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
