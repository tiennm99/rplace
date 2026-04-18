import { redisRaw, redisRawBinary } from './redis-client.js';
import { CANVAS_WIDTH, TOTAL_PIXELS, REDIS_CANVAS_KEY } from './constants.js';

const CANVAS_BYTES = TOTAL_PIXELS;

// Upstash REST returns binary as base64 (~4/3 overhead) and caps responses at
// 10 MB on the Free plan. 4 MiB raw → ~5.33 MB base64, safely under the limit,
// and divides a 16 MiB canvas into exactly 4 chunks.
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Get the full canvas as a Uint8Array of raw bytes.
 * Fetches in parallel chunks to stay under Upstash's per-request size cap.
 * Returns a zero-filled buffer if canvas doesn't exist yet; truncated chunks
 * are zero-padded (GETRANGE clamps past-end reads to "" by default).
 * @param {object} env
 * @returns {Promise<Uint8Array>}
 */
export async function getFullCanvas(env) {
  const ranges = [];
  for (let start = 0; start < CANVAS_BYTES; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, CANVAS_BYTES) - 1;
    ranges.push([start, end]);
  }

  const results = await Promise.all(
    ranges.map(([start, end]) =>
      redisRawBinary(env, ['GETRANGE', REDIS_CANVAS_KEY, String(start), String(end)])
    )
  );

  const out = new Uint8Array(CANVAS_BYTES);
  let totalRead = 0;
  for (let i = 0; i < ranges.length; i++) {
    const base64 = results[i];
    if (!base64) continue;
    const raw = atob(base64);
    const offset = ranges[i][0];
    for (let j = 0; j < raw.length; j++) {
      out[offset + j] = raw.charCodeAt(j);
    }
    totalRead += raw.length;
  }

  if (totalRead > 0 && totalRead < CANVAS_BYTES) {
    console.warn(`Canvas read short: got ${totalRead} bytes, expected ${CANVAS_BYTES}; zero-padding tail`);
  }
  return out;
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
