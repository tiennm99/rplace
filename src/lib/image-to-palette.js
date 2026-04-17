import { COLORS_RGBA } from './constants.js';

/**
 * Return the palette index closest to (r, g, b) in squared-RGB distance.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} index in [0, COLORS_RGBA.length)
 */
export function nearestColorIndex(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < COLORS_RGBA.length; i++) {
    const [cr, cg, cb] = COLORS_RGBA[i];
    const dr = r - cr, dg = g - cg, db = b - cb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Convert an RGBA pixel buffer into a flat array of palette indices.
 * Pixels with alpha < threshold become -1 (caller should skip on upload).
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba - length = width*height*4
 * @param {number} width
 * @param {number} height
 * @param {Object} [options]
 * @param {number} [options.alphaThreshold=128]
 * @param {boolean} [options.dither=false] - Floyd-Steinberg error diffusion
 * @returns {Int16Array} length = width*height
 */
export function rgbaToPalette(rgba, width, height, options = {}) {
  const { alphaThreshold = 128, dither = false } = options;
  return dither
    ? ditherFloydSteinberg(rgba, width, height, alphaThreshold)
    : quantizeNearest(rgba, width, height, alphaThreshold);
}

function quantizeNearest(rgba, width, height, alphaThreshold) {
  const count = width * height;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 4;
    if (rgba[off + 3] < alphaThreshold) { out[i] = -1; continue; }
    out[i] = nearestColorIndex(rgba[off], rgba[off + 1], rgba[off + 2]);
  }
  return out;
}

function ditherFloydSteinberg(rgba, width, height, alphaThreshold) {
  const count = width * height;
  const out = new Int16Array(count);
  // Working RGB buffer in float so we can accumulate error without clamping early.
  const buf = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    buf[i * 3] = rgba[i * 4];
    buf[i * 3 + 1] = rgba[i * 4 + 1];
    buf[i * 3 + 2] = rgba[i * 4 + 2];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rgba[i * 4 + 3] < alphaThreshold) { out[i] = -1; continue; }

      const r = buf[i * 3];
      const g = buf[i * 3 + 1];
      const b = buf[i * 3 + 2];
      const idx = nearestColorIndex(
        r < 0 ? 0 : r > 255 ? 255 : r,
        g < 0 ? 0 : g > 255 ? 255 : g,
        b < 0 ? 0 : b > 255 ? 255 : b,
      );
      out[i] = idx;
      const [pr, pg, pb] = COLORS_RGBA[idx];
      const er = r - pr, eg = g - pg, eb = b - pb;

      diffuse(buf, rgba, width, height, x + 1, y,     er, eg, eb, 7 / 16, alphaThreshold);
      diffuse(buf, rgba, width, height, x - 1, y + 1, er, eg, eb, 3 / 16, alphaThreshold);
      diffuse(buf, rgba, width, height, x,     y + 1, er, eg, eb, 5 / 16, alphaThreshold);
      diffuse(buf, rgba, width, height, x + 1, y + 1, er, eg, eb, 1 / 16, alphaThreshold);
    }
  }
  return out;
}

function diffuse(buf, rgba, width, height, nx, ny, er, eg, eb, w, alphaThreshold) {
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
  const ni = ny * width + nx;
  if (rgba[ni * 4 + 3] < alphaThreshold) return; // skip transparent neighbors
  buf[ni * 3]     += er * w;
  buf[ni * 3 + 1] += eg * w;
  buf[ni * 3 + 2] += eb * w;
}

/**
 * Render palette indices back to an RGBA buffer for preview.
 * Transparent indices (-1) render as a checkerboard.
 * @param {Int16Array|number[]} indices
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray} RGBA buffer of length width*height*4
 */
export function paletteToRgba(indices, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const off = i * 4;
    const idx = indices[i];
    if (idx < 0) {
      const x = i % width;
      const y = (i / width) | 0;
      const checker = ((x >> 2) ^ (y >> 2)) & 1 ? 180 : 120;
      out[off] = out[off + 1] = out[off + 2] = checker;
      out[off + 3] = 255;
      continue;
    }
    const [r, g, b, a] = COLORS_RGBA[idx];
    out[off] = r;
    out[off + 1] = g;
    out[off + 2] = b;
    out[off + 3] = a;
  }
  return out;
}
