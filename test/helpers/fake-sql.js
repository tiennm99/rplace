/**
 * Minimal stand-in for CF DO SqlStorage used in unit tests.
 *
 * Supports just the statements actually issued by chunk-storage.js and
 * cooldown-store.js. Anything else throws so tests fail loudly when the
 * source surface grows.
 *
 * Each table is an in-memory Map. Each exec() returns a cursor object that
 * mimics the CF shape:
 *   - cursor.toArray() returns the rows array
 *   - cursor.rowsWritten is the row count touched by the last write
 *   - cursor[Symbol.iterator] iterates rows (for of)
 */

function makeCursor(rows, rowsWritten = 0) {
  return {
    toArray: () => rows,
    rowsWritten,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

export function createFakeSql() {
  /** @type {Map<number, Uint8Array>} */
  const chunks = new Map();
  /** @type {Map<string, number>} */ // user_id -> expires_at
  const cooldowns = new Map();

  function exec(query, ...params) {
    const q = query.trim().replace(/\s+/g, ' ');

    // ── canvas_chunks ────────────────────────────────────────────────
    if (q.startsWith('SELECT bytes FROM canvas_chunks WHERE chunk_id = ?')) {
      const chunkId = params[0];
      const blob = chunks.get(chunkId);
      return makeCursor(blob ? [{ bytes: blob }] : []);
    }
    if (q.startsWith('SELECT chunk_id, bytes FROM canvas_chunks WHERE chunk_id < ?')) {
      const upper = params[0];
      const rows = [];
      for (const [chunkId, bytes] of chunks) {
        if (chunkId < upper) rows.push({ chunk_id: chunkId, bytes });
      }
      return makeCursor(rows);
    }
    if (q.startsWith('INSERT INTO canvas_chunks (chunk_id, bytes) VALUES (?, ?) ON CONFLICT')) {
      const [chunkId, bytes] = params;
      chunks.set(chunkId, bytes);
      return makeCursor([], 1);
    }

    // ── cooldowns ────────────────────────────────────────────────────
    if (q.startsWith('UPDATE cooldowns SET expires_at = ? WHERE user_id = ? AND expires_at <= ?')) {
      const [newExpires, userId, now] = params;
      const current = cooldowns.get(userId);
      if (current !== undefined && current <= now) {
        cooldowns.set(userId, newExpires);
        return makeCursor([], 1);
      }
      return makeCursor([], 0);
    }
    if (q.startsWith('INSERT INTO cooldowns (user_id, expires_at) VALUES (?, ?)')) {
      const [userId, expiresAt] = params;
      if (cooldowns.has(userId)) {
        const err = new Error('UNIQUE constraint failed: cooldowns.user_id');
        err.code = 'SQLITE_CONSTRAINT';
        throw err;
      }
      cooldowns.set(userId, expiresAt);
      return makeCursor([], 1);
    }
    if (q.startsWith('DELETE FROM cooldowns WHERE user_id = ?')) {
      const [userId] = params;
      const had = cooldowns.delete(userId);
      return makeCursor([], had ? 1 : 0);
    }
    if (q.startsWith('DELETE FROM cooldowns WHERE expires_at <= ?')) {
      const [now] = params;
      let n = 0;
      for (const [uid, exp] of cooldowns) {
        if (exp <= now) { cooldowns.delete(uid); n++; }
      }
      return makeCursor([], n);
    }

    throw new Error(`fake-sql: unhandled query: ${q}`);
  }

  return {
    exec,
    // Test-only inspection / seeding hooks.
    _chunks: chunks,
    _cooldowns: cooldowns,
    _seedChunk(chunkId, bytes) { chunks.set(chunkId, bytes); },
    _seedCooldown(userId, expiresAt) { cooldowns.set(userId, expiresAt); },
  };
}
