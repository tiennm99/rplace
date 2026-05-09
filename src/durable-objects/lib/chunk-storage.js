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
 */
export function readAllChunks(sql) {
  const out = new Uint8Array(TOTAL_PIXELS);
  const cursor = sql.exec('SELECT chunk_id, bytes FROM canvas_chunks');
  for (const row of cursor) {
    const chunkId = row.chunk_id;
    const blob = row.bytes;
    const view = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    out.set(view, chunkId * CHUNK_BYTES);
  }
  return out;
}

/**
 * Apply a batch of pixel writes. Groups by chunk so each touched chunk
 * incurs at most one read and one write. Single transaction so the batch
 * is atomic across all touched chunks.
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

  // For each touched chunk: read current bytes (or zero-fill), apply edits,
  // write back. INSERT OR REPLACE upserts the row.
  // Atomicity: this loop is fully synchronous (no `await`) and the DO is
  // single-threaded, so the chunk updates are atomic with respect to other
  // requests. If anyone adds an `await` inside this loop, wrap the whole
  // block in `state.storage.transactionSync(() => { ... })` to preserve it.
  for (const [chunkId, edits] of groups) {
    const buf = readChunk(sql, chunkId);
    // readChunk returns a fresh Uint8Array (or wraps a buffer); writes must
    // not alias persisted state, so copy to be safe.
    const next = new Uint8Array(buf);
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

/**
 * Bulk replace the entire canvas. Used by the one-shot Upstash migration.
 * Refuses to run if the canvas already has data, unless `force` is true.
 *
 * @param {SqlStorage} sql
 * @param {Uint8Array} fullCanvas - exactly TOTAL_PIXELS bytes
 * @param {boolean} force - overwrite even if rows already exist
 * @returns {{imported: number, skipped: boolean}}
 */
export function importFullCanvas(sql, fullCanvas, force = false) {
  if (fullCanvas.length !== TOTAL_PIXELS) {
    throw new Error(`expected ${TOTAL_PIXELS} bytes, got ${fullCanvas.length}`);
  }
  if (!force) {
    const existing = sql.exec('SELECT COUNT(*) AS n FROM canvas_chunks').one().n;
    if (existing > 0) {
      return { imported: 0, skipped: true };
    }
  }
  for (let chunkId = 0; chunkId < CHUNK_COUNT; chunkId++) {
    const start = chunkId * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, TOTAL_PIXELS);
    const slice = fullCanvas.slice(start, end);
    sql.exec(
      'INSERT INTO canvas_chunks (chunk_id, bytes) VALUES (?, ?) ' +
        'ON CONFLICT(chunk_id) DO UPDATE SET bytes = excluded.bytes',
      chunkId,
      slice,
    );
  }
  return { imported: CHUNK_COUNT, skipped: false };
}
