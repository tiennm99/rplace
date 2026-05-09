import { CANVAS_WIDTH, TOTAL_PIXELS, CHUNK_BYTES, CHUNK_COUNT } from '../../lib/constants.js';

/**
 * Canvas pixel storage as fixed-size BLOB chunks in DO SQLite.
 *
 * Layout: linear byte stream (y * CANVAS_WIDTH + x), partitioned into
 * CHUNK_COUNT rows of CHUNK_BYTES bytes each. Missing rows read as zeros,
 * which is exactly the "uninitialized canvas" semantic.
 */

/** Map a pixel coordinate to its chunk and byte offset within that chunk. */
function pixelToChunk(x, y) {
  const offset = y * CANVAS_WIDTH + x;
  return {
    chunkId: Math.floor(offset / CHUNK_BYTES),
    byteOffset: offset % CHUNK_BYTES,
  };
}

/** Number of bytes the chunk at this id should hold. The last chunk may be
 *  short if TOTAL_PIXELS isn't a multiple of CHUNK_BYTES. */
function chunkSize(chunkId) {
  const start = chunkId * CHUNK_BYTES;
  return Math.min(CHUNK_BYTES, TOTAL_PIXELS - start);
}

/**
 * Read one chunk's bytes. Returns a zero-filled buffer of the correct length
 * if the row doesn't exist yet (lazy initialization).
 */
export function readChunk(sql, chunkId) {
  const cursor = sql.exec('SELECT bytes FROM canvas_chunks WHERE chunk_id = ?', chunkId);
  const rows = cursor.toArray();
  if (rows.length === 0) {
    return new Uint8Array(chunkSize(chunkId));
  }
  const blob = rows[0].bytes;
  // CF DO returns BLOBs as ArrayBuffer; normalize to Uint8Array.
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

/**
 * Read all chunks concatenated into a single TOTAL_PIXELS-sized buffer.
 * Used to serve GET /api/canvas.
 *
 * Bounded by chunk_id < CHUNK_COUNT so orphan rows left after a canvas-shrink
 * don't trip a RangeError on out.set(...).
 */
export function readAllChunks(sql) {
  const out = new Uint8Array(TOTAL_PIXELS);
  const cursor = sql.exec(
    'SELECT chunk_id, bytes FROM canvas_chunks WHERE chunk_id < ?',
    CHUNK_COUNT,
  );
  for (const row of cursor) {
    const chunkId = row.chunk_id;
    const blob = row.bytes;
    const view = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    // Defensive clamp: if a row's persisted blob is longer than this chunk's
    // expected size (e.g. legacy data), trim before copying.
    const expected = chunkSize(chunkId);
    const trimmed = view.length > expected ? view.subarray(0, expected) : view;
    out.set(trimmed, chunkId * CHUNK_BYTES);
  }
  return out;
}

/**
 * Apply a batch of pixel writes. Groups by chunk so each touched chunk
 * incurs at most one read and one write.
 *
 * Atomicity: each sql.exec auto-commits, so this function is NOT atomic on
 * its own. The caller must wrap the call in state.storage.transactionSync
 * (or transaction) to make a multi-chunk batch all-or-nothing.
 *
 * @param {SqlStorage} sql
 * @param {Array<{x:number, y:number, color:number}>} pixels
 */
export function writePixels(sql, pixels) {
  if (pixels.length === 0) return;

  // Group by chunk_id; each group is a list of {byteOffset, color}.
  /** @type {Map<number, Array<{byteOffset:number, color:number}>>} */
  const groups = new Map();
  for (const p of pixels) {
    const { chunkId, byteOffset } = pixelToChunk(p.x, p.y);
    let bucket = groups.get(chunkId);
    if (!bucket) {
      bucket = [];
      groups.set(chunkId, bucket);
    }
    bucket.push({ byteOffset, color: p.color });
  }

  for (const [chunkId, edits] of groups) {
    const buf = readChunk(sql, chunkId);
    // Allocate against chunkSize, never the persisted blob's length: after a
    // canvas grow, the old short blob would silently drop OOB writes.
    const expected = chunkSize(chunkId);
    const next = new Uint8Array(expected);
    next.set(buf.subarray(0, Math.min(buf.length, expected)));
    for (const { byteOffset, color } of edits) {
      next[byteOffset] = color;
    }
    sql.exec(
      'INSERT INTO canvas_chunks (chunk_id, bytes) VALUES (?, ?) ' +
        'ON CONFLICT(chunk_id) DO UPDATE SET bytes = excluded.bytes',
      chunkId,
      next,
    );
  }
}

