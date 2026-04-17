import { COLORS_RGBA } from './constants.js';
import { ERROR_DIFFUSION_KERNELS, BAYER_MATRICES, DITHER_METHODS } from './dither-kernels.js';

export { DITHER_METHODS };

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
 *
 * Back-compat: `dither: true` is treated as `method: 'floyd'`.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba - length = width*height*4
 * @param {number} width
 * @param {number} height
 * @param {Object} [options]
 * @param {number} [options.alphaThreshold=128]
 * @param {boolean} [options.dither=false] - legacy; prefer `method`
 * @param {('none'|'floyd'|'atkinson'|'jarvis'|'burkes'|'sierra'|'sierra-lite'|'bayer-2'|'bayer-4'|'bayer-8')} [options.method]
 * @returns {Int16Array} length = width*height
 */
export function rgbaToPalette(rgba, width, height, options = {}) {
  const { alphaThreshold = 128, dither = false } = options;
  const method = options.method ?? (dither ? 'floyd' : 'none');

  if (method === 'none') return quantizeNearest(rgba, width, height, alphaThreshold);
  if (ERROR_DIFFUSION_KERNELS[method]) {
    return runErrorDiffusion(rgba, width, height, alphaThreshold, ERROR_DIFFUSION_KERNELS[method]);
  }
  if (BAYER_MATRICES[method]) {
    return runOrderedDither(rgba, width, height, alphaThreshold, BAYER_MATRICES[method]);
  }
  throw new Error(`Unknown dither method: ${method}. Valid: ${DITHER_METHODS.join(', ')}.`);
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

/** Generic error-diffusion runner. Kernel rows only diffuse forward (dy > 0 or
 *  dy === 0 && dx > 0) so the working buffer can be a single-pass float image. */
function runErrorDiffusion(rgba, width, height, alphaThreshold, kernel) {
  const count = width * height;
  const out = new Int16Array(count);
  const buf = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    buf[i * 3]     = rgba[i * 4];
    buf[i * 3 + 1] = rgba[i * 4 + 1];
    buf[i * 3 + 2] = rgba[i * 4 + 2];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rgba[i * 4 + 3] < alphaThreshold) { out[i] = -1; continue; }

      const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
      const idx = nearestColorIndex(
        r < 0 ? 0 : r > 255 ? 255 : r,
        g < 0 ? 0 : g > 255 ? 255 : g,
        b < 0 ? 0 : b > 255 ? 255 : b,
      );
      out[i] = idx;
      const [pr, pg, pb] = COLORS_RGBA[idx];
      const er = r - pr, eg = g - pg, eb = b - pb;

      for (const [dx, dy, w] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        if (rgba[ni * 4 + 3] < alphaThreshold) continue; // skip transparent neighbors
        buf[ni * 3]     += er * w;
        buf[ni * 3 + 1] += eg * w;
        buf[ni * 3 + 2] += eb * w;
      }
    }
  }
  return out;
}

/** Ordered dither — bias each pixel by a threshold-matrix shift before
 *  nearest-color lookup. No error propagation; cheap and stateless. */
function runOrderedDither(rgba, width, height, alphaThreshold, matrix) {
  const mh = matrix.length;
  const mw = matrix[0].length;
  // Shift in RGB units: roughly the distance between neighboring palette
  // colors. The grey ramp in our palette spans ~50 units per step so 48
  // keeps the pattern visible without over-banding.
  const SPREAD = 48;
  const count = width * height;
  const out = new Int16Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rgba[i * 4 + 3] < alphaThreshold) { out[i] = -1; continue; }
      const bias = (matrix[y % mh][x % mw] - 0.5) * SPREAD;
      const r = rgba[i * 4] + bias;
      const g = rgba[i * 4 + 1] + bias;
      const b = rgba[i * 4 + 2] + bias;
      out[i] = nearestColorIndex(
        r < 0 ? 0 : r > 255 ? 255 : r,
        g < 0 ? 0 : g > 255 ? 255 : g,
        b < 0 ? 0 : b > 255 ? 255 : b,
      );
    }
  }
  return out;
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
