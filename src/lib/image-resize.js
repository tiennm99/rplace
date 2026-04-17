/**
 * Pure RGBA buffer resizers. No DOM dependency — usable in both the browser
 * importer and the Node CLI (with a sharp-provided RGBA input).
 *
 * All methods return a fresh Uint8ClampedArray of length dstW*dstH*4.
 * If src dimensions match dst, returns a copy (identity).
 */

/**
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba - src RGBA (length = srcW*srcH*4)
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {'nearest'|'bilinear'|'box'} [method='nearest']
 * @returns {Uint8ClampedArray}
 */
export function resizeRgba(rgba, srcW, srcH, dstW, dstH, method = 'nearest') {
  if (dstW <= 0 || dstH <= 0) throw new Error('dstW and dstH must be > 0');
  if (srcW === dstW && srcH === dstH) return new Uint8ClampedArray(rgba);

  switch (method) {
    case 'bilinear': return resampleBilinear(rgba, srcW, srcH, dstW, dstH);
    case 'box':      return resampleBox(rgba, srcW, srcH, dstW, dstH);
    case 'nearest':
    default:         return resampleNearest(rgba, srcW, srcH, dstW, dstH);
  }
}

function resampleNearest(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y * yRatio) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x * xRatio) | 0);
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di]     = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function resampleBilinear(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xRatio = dw > 1 ? (sw - 1) / (dw - 1) : 0;
  const yRatio = dh > 1 ? (sh - 1) / (dh - 1) : 0;
  for (let y = 0; y < dh; y++) {
    const fy = y * yRatio;
    const y0 = fy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = x * xRatio;
      const x0 = fx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;

      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top    = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bottom = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        out[di + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return out;
}

/** Box filter: average pixels in each destination cell's source footprint.
 * Good for downscales; degrades to nearest for upscales (footprint < 1 pixel). */
function resampleBox(src, sw, sh, dw, dh) {
  if (dw >= sw || dh >= sh) return resampleBilinear(src, sw, sh, dw, dh);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(sh, Math.ceil((y + 1) * yRatio));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(sw, Math.ceil((x + 1) * xRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const si = (yy * sw + xx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
          n++;
        }
      }
      const di = (y * dw + x) * 4;
      out[di]     = r / n;
      out[di + 1] = g / n;
      out[di + 2] = b / n;
      out[di + 3] = a / n;
    }
  }
  return out;
}
