/** Canvas dimensions (configurable via wrangler.json vars) */
export const CANVAS_WIDTH = 2048;
export const CANVAS_HEIGHT = 2048;
export const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;

/** Color encoding */
export const BITS_PER_PIXEL = 5;
export const MAX_COLORS = 32;

/** Rate limiting — stackable credit system */
export const MAX_BATCH_SIZE = 32;
export const CREDIT_REGEN_RATE = 1; // credits per second
export const MAX_CREDITS = 256;

/** Redis keys */
export const REDIS_KEY_PREFIX = 'rplace:';
export const REDIS_CANVAS_KEY = `${REDIS_KEY_PREFIX}canvas`;

/** 32-color palette from rplace.live (hex values) */
export const COLORS = [
  '#6d001a', '#be0039', '#ff4500', '#ffa800', '#ffd635', '#fff8b8',
  '#00a368', '#00cc78', '#7eed56', '#00756f', '#009eaa', '#00ccc0',
  '#2450a4', '#3690ea', '#51e9f4', '#493ac1', '#6a5cff', '#94b3ff',
  '#811e9f', '#b44ac0', '#e4abff', '#de107f', '#ff3881', '#ff99aa',
  '#6d482f', '#9c6926', '#ffb470', '#000000', '#515252', '#898d90',
  '#d4d7d9', '#ffffff',
];

/**
 * RGBA values for each color (pre-computed for canvas rendering).
 * Each entry is [r, g, b, 255].
 */
export const COLORS_RGBA = COLORS.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
});
