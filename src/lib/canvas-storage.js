import { redisRaw, redisRawBinary } from './redis-client.js';
import { CANVAS_WIDTH, TOTAL_PIXELS, REDIS_CANVAS_KEY } from './constants.js';

/** Total bytes needed for the canvas — 1 byte per pixel (u8 palette index). */
const CANVAS_BYTES = TOTAL_PIXELS;

/**
 * Get the full canvas as a Uint8Array of raw bytes.
 * Uses raw REST API to avoid SDK binary encoding corruption.
 * Returns a zero-filled buffer if canvas doesn't exist yet.
 * @param {object} env
 * @returns {Promise<Uint8Array>}
 */
export async function getFullCanvas(env) {
  // Use base64 encoding for binary-safe transport of BITFIELD data
  const base64 = await redisRawBinary(env, ['GETRANGE', REDIS_CANVAS_KEY, '0', String(CANVAS_BYTES - 1)]);

  if (!base64 || base64.length === 0) {
    return new Uint8Array(CANVAS_BYTES);
  }

  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }

  if (bytes.length < CANVAS_BYTES) {
    console.warn(`Canvas read truncated: got ${bytes.length} bytes, expected ${CANVAS_BYTES}; zero-padding tail`);
    const padded = new Uint8Array(CANVAS_BYTES);
    padded.set(bytes);
    return padded;
  }
  return bytes;
}

/**
 * Set multiple pixels in a single atomic BITFIELD command.
 * Uses raw REST API — SDK bitfield builder is broken in @upstash/redis 1.x.
 * With u8, BITFIELD offsets are byte-aligned (`#N` = byte N).
 * @param {object} env
 * @param {Array<{x: number, y: number, color: number}>} pixels
 */
export async function setPixels(env, pixels) {
  if (!pixels.length) return;

  const command = ['BITFIELD', REDIS_CANVAS_KEY];
  for (const { x, y, color } of pixels) {
    const offset = y * CANVAS_WIDTH + x;
    command.push('SET', 'u8', `#${offset}`, String(color));
  }
  await redisRaw(env, command);
}
