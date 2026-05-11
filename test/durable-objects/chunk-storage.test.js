import { describe, it, expect } from 'vitest';
import { readChunk, readAllChunks, writePixels } from '../../src/durable-objects/lib/chunk-storage.js';
import {
  CANVAS_WIDTH,
  CHUNK_BYTES,
  CHUNK_COUNT,
  TOTAL_PIXELS,
} from '../../src/lib/constants.js';
import { createFakeSql } from '../helpers/fake-sql.js';

describe('readChunk', () => {
  it('returns a zero-filled buffer for missing rows (lazy init)', () => {
    const sql = createFakeSql();
    const buf = readChunk(sql, 0);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBe(CHUNK_BYTES);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('returns the persisted blob when row exists', () => {
    const sql = createFakeSql();
    const seed = new Uint8Array(CHUNK_BYTES);
    seed[42] = 99;
    sql._seedChunk(0, seed);
    const buf = readChunk(sql, 0);
    expect(buf[42]).toBe(99);
  });
});

describe('writePixels — single chunk', () => {
  it('persists pixels and reads them back identically', () => {
    const sql = createFakeSql();
    writePixels(sql, [
      { x: 0, y: 0, color: 5 },
      { x: 1, y: 0, color: 17 },
      { x: 5, y: 0, color: 250 },
    ]);
    const chunk0 = readChunk(sql, 0);
    expect(chunk0[0]).toBe(5);
    expect(chunk0[1]).toBe(17);
    expect(chunk0[5]).toBe(250);
  });

  it('overwrites previous color at same coordinate', () => {
    const sql = createFakeSql();
    writePixels(sql, [{ x: 10, y: 0, color: 1 }]);
    writePixels(sql, [{ x: 10, y: 0, color: 42 }]);
    const chunk0 = readChunk(sql, 0);
    expect(chunk0[10]).toBe(42);
  });

  it('is a no-op on empty input', () => {
    const sql = createFakeSql();
    writePixels(sql, []);
    expect(sql._chunks.size).toBe(0);
  });
});

describe('writePixels — multi-chunk', () => {
  it('groups writes across chunks correctly', () => {
    const sql = createFakeSql();
    // (x=0,y=0) → offset 0 → chunk 0
    // (x=CHUNK_BYTES,y=0) → offset CHUNK_BYTES → chunk 1, byteOffset 0
    writePixels(sql, [
      { x: 0, y: 0, color: 11 },
      { x: CHUNK_BYTES, y: 0, color: 22 },
    ]);
    expect(sql._chunks.size).toBe(2);
    expect(readChunk(sql, 0)[0]).toBe(11);
    expect(readChunk(sql, 1)[0]).toBe(22);
  });

  it('issues exactly one INSERT per touched chunk regardless of pixel count', () => {
    const sql = createFakeSql();
    let writes = 0;
    const origExec = sql.exec;
    sql.exec = (q, ...p) => {
      if (q.startsWith('INSERT INTO canvas_chunks')) writes++;
      return origExec(q, ...p);
    };
    writePixels(sql, [
      { x: 0, y: 0, color: 1 },
      { x: 1, y: 0, color: 2 },
      { x: 2, y: 0, color: 3 },
      { x: 3, y: 0, color: 4 },
    ]);
    expect(writes).toBe(1);
  });
});

describe('writePixels — BLOB-grow safety', () => {
  it('writes against chunkSize, not the persisted blob length', () => {
    const sql = createFakeSql();
    // Pre-seed chunk 0 with a short blob (e.g. legacy 8 KB).
    const shortBlob = new Uint8Array(8192);
    shortBlob[100] = 7;
    sql._seedChunk(0, shortBlob);

    // Write a pixel at byteOffset 30000 — well beyond the seeded 8 KB.
    // y=0, x=30000 → offset=30000 → chunk 0, byteOffset 30000.
    writePixels(sql, [{ x: 30000, y: 0, color: 123 }]);

    const buf = readChunk(sql, 0);
    expect(buf.length).toBe(CHUNK_BYTES);
    expect(buf[100]).toBe(7);       // preserved
    expect(buf[30000]).toBe(123);   // newly written, would have been dropped
  });
});

describe('readAllChunks', () => {
  it('returns a TOTAL_PIXELS Uint8Array even when chunks are empty', () => {
    const sql = createFakeSql();
    const out = readAllChunks(sql);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(TOTAL_PIXELS);
    expect(out[0]).toBe(0);
    expect(out[TOTAL_PIXELS - 1]).toBe(0);
  });

  it('concatenates seeded chunks at correct offsets', () => {
    const sql = createFakeSql();
    const c0 = new Uint8Array(CHUNK_BYTES);
    c0[0] = 1;
    c0[CHUNK_BYTES - 1] = 2;
    const c1 = new Uint8Array(CHUNK_BYTES);
    c1[0] = 3;
    sql._seedChunk(0, c0);
    sql._seedChunk(1, c1);

    const out = readAllChunks(sql);
    expect(out[0]).toBe(1);
    expect(out[CHUNK_BYTES - 1]).toBe(2);
    expect(out[CHUNK_BYTES]).toBe(3);
  });

  it('skips orphan rows with chunk_id >= CHUNK_COUNT (canvas-shrink residue)', () => {
    const sql = createFakeSql();
    // Seed a valid chunk and an orphan past the boundary.
    const c0 = new Uint8Array(CHUNK_BYTES);
    c0[0] = 9;
    sql._seedChunk(0, c0);
    const orphan = new Uint8Array(CHUNK_BYTES);
    orphan[0] = 99;
    sql._seedChunk(CHUNK_COUNT + 5, orphan);

    const out = readAllChunks(sql);
    expect(out.length).toBe(TOTAL_PIXELS);
    expect(out[0]).toBe(9);
    // Orphan would have caused a RangeError on out.set() if not bounded.
  });

  it('trims oversized blobs at the last chunk to expected size', () => {
    const sql = createFakeSql();
    // Last chunk's "expected" size equals CHUNK_BYTES when TOTAL_PIXELS is a
    // multiple of CHUNK_BYTES (our current case). Seed an oversized blob and
    // verify no overflow into adjacent memory.
    const lastId = CHUNK_COUNT - 1;
    const oversized = new Uint8Array(CHUNK_BYTES + 100);
    oversized[0] = 4;
    oversized[CHUNK_BYTES + 99] = 7; // beyond expected — must be trimmed
    sql._seedChunk(lastId, oversized);

    // Should not throw.
    const out = readAllChunks(sql);
    expect(out.length).toBe(TOTAL_PIXELS);
    const lastChunkStart = lastId * CHUNK_BYTES;
    expect(out[lastChunkStart]).toBe(4);
  });
});

describe('pixel-to-chunk math (coverage via writePixels)', () => {
  it('maps (x,y) coordinates to the expected chunk index', () => {
    const sql = createFakeSql();
    // Pick a y that crosses chunk boundaries: y=16 with CANVAS_WIDTH=4096
    // gives offset = 65536 → chunk 1, byteOffset 0.
    writePixels(sql, [{ x: 0, y: CHUNK_BYTES / CANVAS_WIDTH, color: 200 }]);
    expect(sql._chunks.size).toBe(1);
    expect(sql._chunks.has(1)).toBe(true);
    expect(readChunk(sql, 1)[0]).toBe(200);
  });
});
