/** Canvas dimensions (4096 × 4096 = 16,777,216 pixels). */
export const CANVAS_WIDTH = 4096;
export const CANVAS_HEIGHT = 4096;
export const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;

/** Color encoding: 1 byte per pixel, 256 palette entries. Byte-aligned means
 *  the raw Redis bytes are directly the pixel indices — no bit-level decode. */
export const BITS_PER_PIXEL = 8;
export const MAX_COLORS = 256;

/** Rate limiting — one request per second per user, batch size independent. */
export const REQUEST_COOLDOWN_SEC = 1;
export const MAX_BATCH_SIZE = 2048;

/** Redis keys. Key is versioned (":v2") so the old 32-color / 2048² canvas
 *  key (`rplace:canvas`) is ignored after this rollout — old data stays in
 *  Redis harmlessly until an operator deletes it. */
export const REDIS_KEY_PREFIX = 'rplace:';
export const REDIS_CANVAS_KEY = `${REDIS_KEY_PREFIX}canvas:v2`;

/**
 * Build the 256-color palette deterministically:
 *   - Indices 0..15   → 16 grayscale steps (pure black → pure white)
 *   - Indices 16..255 → 240 HSL wheel: 4 lightness rings × 60 hues @ 82% saturation
 * Layout is fixed so clients, tests, and image-quantizer all agree.
 */
function buildPalette() {
  const hexByte = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const asHex = (r, g, b) => `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (0 <= hp && hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (hp < 2)       [r1, g1, b1] = [x, c, 0];
    else if (hp < 3)       [r1, g1, b1] = [0, c, x];
    else if (hp < 4)       [r1, g1, b1] = [0, x, c];
    else if (hp < 5)       [r1, g1, b1] = [x, 0, c];
    else                   [r1, g1, b1] = [c, 0, x];
    const m = l - c / 2;
    return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
  }

  const out = [];
  for (let i = 0; i < 16; i++) {
    const v = Math.round((i * 255) / 15);
    out.push(asHex(v, v, v));
  }
  const lightnesses = [0.85, 0.65, 0.45, 0.25];
  const hueSteps = 60;
  for (const L of lightnesses) {
    for (let h = 0; h < hueSteps; h++) {
      const [r, g, b] = hslToRgb((h * 360) / hueSteps, 0.82, L);
      out.push(asHex(r, g, b));
    }
  }
  return out;
}

/** 256 hex strings — built once at module load. */
export const COLORS = buildPalette();

/** RGBA tuples for each palette entry, pre-computed for hot render loops. */
export const COLORS_RGBA = COLORS.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
});

/**
 * Find the nearest palette index to an arbitrary RGB triple. Simple Euclidean
 * distance in RGB — good enough for the "custom color" snap.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} index into COLORS
 */
export function nearestPaletteIndex(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < COLORS_RGBA.length; i++) {
    const [pr, pg, pb] = COLORS_RGBA[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = i; if (d === 0) return i; }
  }
  return best;
}
