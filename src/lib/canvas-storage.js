import { getRedis } from './redis-client.js';
import { CANVAS_WIDTH, TOTAL_PIXELS, BITS_PER_PIXEL, REDIS_CANVAS_KEY } from './constants.js';

/** Total bytes needed for the canvas bitfield */
const CANVAS_BYTES = Math.ceil((TOTAL_PIXELS * BITS_PER_PIXEL) / 8);

/**
 * Get the full canvas as a Uint8Array of raw bytes.
 * Returns a zero-filled buffer if canvas doesn't exist yet.
 * @param {object} env
 * @returns {Promise<Uint8Array>}
 */
export async function getFullCanvas(env) {
  const redis = getRedis(env);
  const data = await redis.get(REDIS_CANVAS_KEY);
  if (!data) {
    return new Uint8Array(CANVAS_BYTES);
  }
  if (typeof data === 'string') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(data);
}

/**
 * Set multiple pixels in a single atomic BITFIELD command.
 * @param {object} env
 * @param {Array<{x: number, y: number, color: number}>} pixels
 */
export async function setPixels(env, pixels) {
  if (!pixels.length) return;
  const redis = getRedis(env);

  const commands = [];
  for (const { x, y, color } of pixels) {
    const offset = y * CANVAS_WIDTH + x;
    commands.push('SET', 'u5', `#${offset}`, color);
  }

  await redis.bitfield(REDIS_CANVAS_KEY, commands);
}
