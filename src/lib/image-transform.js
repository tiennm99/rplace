/**
 * Pure RGBA transforms: flip horizontal/vertical and rotate in 90° steps.
 * All functions return a fresh Uint8ClampedArray; rotations by 90/270 swap dims.
 *
 * Composition order in `transformRgba`: rotation → flipH → flipV.
 * (Order is fixed so state is well-defined regardless of UI click sequence.)
 */

/**
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba
 * @param {number} width
 * @param {number} height
 * @param {{flipH?: boolean, flipV?: boolean, rotation?: 0|90|180|270}} [opts]
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number}}
 */
export function transformRgba(rgba, width, height, opts = {}) {
  const { flipH = false, flipV = false, rotation = 0 } = opts;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new Error(`Unsupported rotation: ${rotation}. Use 0, 90, 180, or 270.`);
  }

  let cur = rgba, w = width, h = height;
  let owned = false; // true once we produced a fresh buffer and no longer alias the input

  if (rotation !== 0) {
    const r = rotate(cur, w, h, rotation);
    cur = r.rgba; w = r.width; h = r.height; owned = true;
  }
  if (flipH) { cur = flipHorizontal(cur, w, h); owned = true; }
  if (flipV) { cur = flipVertical(cur, w, h); owned = true; }
  if (!owned) cur = new Uint8ClampedArray(cur); // identity: still return a fresh buffer
  return { rgba: cur, width: w, height: h };
}

function rotate(src, w, h, degrees) {
  if (degrees === 180) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const di = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
      }
    }
    return { rgba: out, width: w, height: h };
  }
  // 90 CW or 270 CW — dst dims are h × w.
  const dstW = h, dstH = w;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let ny = 0; ny < dstH; ny++) {
    for (let nx = 0; nx < dstW; nx++) {
      const ox = degrees === 90 ? ny : (dstH - 1 - ny);
      const oy = degrees === 90 ? (h - 1 - nx) : nx;
      const si = (oy * w + ox) * 4;
      const di = (ny * dstW + nx) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return { rgba: out, width: dstW, height: dstH };
}

function flipHorizontal(src, w, h) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (y * w + (w - 1 - x)) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function flipVertical(src, w, h) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = ((h - 1 - y) * w + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}
