/**
 * Pure RGBA color correction: brightness, contrast, saturation, gamma.
 *
 * Order of operations: brightness → contrast → saturation → gamma.
 * All input values are in "human" ranges; the function converts internally.
 *
 * Identity (defaults) returns a copy of the input so callers can safely mutate.
 */

/**
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba
 * @param {number} width
 * @param {number} height
 * @param {Object} [opts]
 * @param {number} [opts.brightness=0]   -100..+100
 * @param {number} [opts.contrast=0]     -100..+100
 * @param {number} [opts.saturation=0]   -100..+100 (-100 = greyscale, 0 = identity, +100 = 2× saturation)
 * @param {number} [opts.gamma=1]         (0.1..3.0 typical; 1 = identity)
 * @returns {Uint8ClampedArray}
 */
export function applyColorCorrection(rgba, width, height, opts = {}) {
  const { brightness = 0, contrast = 0, saturation = 0, gamma = 1 } = opts;
  const out = new Uint8ClampedArray(rgba);
  if (brightness === 0 && contrast === 0 && saturation === 0 && gamma === 1) return out;

  const bOffset = brightness * 2.55;
  const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const sFactor = 1 + saturation / 100;
  const applyGamma = gamma !== 1 && gamma > 0;
  const gammaInv = applyGamma ? 1 / gamma : 1;

  for (let i = 0; i < out.length; i += 4) {
    let r = out[i], g = out[i + 1], b = out[i + 2];

    if (brightness !== 0) {
      r += bOffset; g += bOffset; b += bOffset;
    }
    if (contrast !== 0) {
      r = cFactor * (r - 128) + 128;
      g = cFactor * (g - 128) + 128;
      b = cFactor * (b - 128) + 128;
    }
    if (saturation !== 0) {
      // Rec. 601 luma
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + sFactor * (r - lum);
      g = lum + sFactor * (g - lum);
      b = lum + sFactor * (b - lum);
    }
    if (applyGamma) {
      const rc = r < 0 ? 0 : r > 255 ? 255 : r;
      const gc = g < 0 ? 0 : g > 255 ? 255 : g;
      const bc = b < 0 ? 0 : b > 255 ? 255 : b;
      r = Math.pow(rc / 255, gammaInv) * 255;
      g = Math.pow(gc / 255, gammaInv) * 255;
      b = Math.pow(bc / 255, gammaInv) * 255;
    }

    out[i] = r; out[i + 1] = g; out[i + 2] = b;
    // alpha (out[i + 3]) passes through from the copy.
  }
  return out;
}
