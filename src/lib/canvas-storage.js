import redis from './redis-client.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  TOTAL_PIXELS,
  BITS_PER_PIXEL,
  REDIS_CANVAS_KEY,
} from './constants.js';

/** Total bytes needed for the canvas bitfield */
const CANVAS_BYTES = Math.ceil((TOTAL_PIXELS * BITS_PER_PIXEL) / 8);

/**
 * Get the full canvas as a Buffer of raw bytes.
 * Each pixel is 5 bits at offset (y * CANVAS_WIDTH + x).
 * Returns a zero-filled buffer if canvas doesn't exist yet.
 */
export async function getFullCanvas() {
  const data = await redis.get(REDIS_CANVAS_KEY);
  if (!data) {
    return Buffer.alloc(CANVAS_BYTES);
  }
  // Upstash returns base64-encoded string for binary data
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64');
  }
  return Buffer.from(data);
}

/**
 * Set multiple pixels in a single atomic BITFIELD command.
 * @param {Array<{x: number, y: number, color: number}>} pixels
 */
export async function setPixels(pixels) {
  if (!pixels.length) return;

  // Build BITFIELD subcommands: SET u5 #offset value
  const commands = [];
  for (const { x, y, color } of pixels) {
    const offset = y * CANVAS_WIDTH + x;
    commands.push('SET', 'u5', `#${offset}`, color);
  }

  await redis.bitfield(REDIS_CANVAS_KEY, commands);
}

/**
 * Get a single pixel's color index.
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number>} color index (0-31)
 */
export async function getPixel(x, y) {
  const offset = y * CANVAS_WIDTH + x;
  const result = await redis.bitfield(REDIS_CANVAS_KEY, [
    'GET', 'u5', `#${offset}`,
  ]);
  return result?.[0] ?? 0;
}
