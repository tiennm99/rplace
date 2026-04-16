import { getRedis } from './redis-client.js';
import { CANVAS_WIDTH, TOTAL_PIXELS, BITS_PER_PIXEL, REDIS_CANVAS_KEY } from './constants.js';

/** Total bytes needed for the canvas bitfield */
const CANVAS_BYTES = Math.ceil((TOTAL_PIXELS * BITS_PER_PIXEL) / 8);

/**
 * Get the full canvas as a Uint8Array of raw bytes.
 * Uses GETRANGE to fetch raw binary reliably (avoids encoding issues with GET).
 * Returns a zero-filled buffer if canvas doesn't exist yet.
 * @param {object} env
 * @returns {Promise<Uint8Array>}
 */
export async function getFullCanvas(env) {
  const redis = getRedis(env);

  // Use GETRANGE to fetch the full string as raw bytes
  // This is more reliable than GET for binary data written by BITFIELD
  const data = await redis.getrange(REDIS_CANVAS_KEY, 0, CANVAS_BYTES - 1);
  if (!data || data.length === 0) {
    return new Uint8Array(CANVAS_BYTES);
  }

  // Upstash REST may return base64 or raw string for binary data
  if (typeof data === 'string') {
    let raw;
    try {
      raw = atob(data);
    } catch {
      raw = data; // Already a raw string
    }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    // Pad to full canvas size if shorter
    if (bytes.length < CANVAS_BYTES) {
      const padded = new Uint8Array(CANVAS_BYTES);
      padded.set(bytes);
      return padded;
    }
    return bytes;
  }

  return new Uint8Array(CANVAS_BYTES);
}

/**
 * Set multiple pixels in a single atomic BITFIELD command.
 * Uses Upstash's builder pattern: redis.bitfield(key).set().set().exec()
 * @param {object} env
 * @param {Array<{x: number, y: number, color: number}>} pixels
 */
export async function setPixels(env, pixels) {
  if (!pixels.length) return;
  const redis = getRedis(env);

  let chain = redis.bitfield(REDIS_CANVAS_KEY);
  for (const { x, y, color } of pixels) {
    const offset = y * CANVAS_WIDTH + x;
    chain = chain.set('u5', `#${offset}`, color);
  }
  await chain.exec();
}
