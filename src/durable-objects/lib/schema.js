/**
 * SQLite schema for the canvas Durable Object.
 *
 * Idempotent: safe to run on every DO construction. Cloudflare DOs persist
 * across evictions, so the first-ever run creates the tables; later runs are
 * no-ops because of IF NOT EXISTS.
 *
 * @param {SqlStorage} sql - state.storage.sql (CF DO SQLite handle)
 */
export function init(sql) {
  // Canvas pixel bytes, sharded into fixed-size BLOB rows. chunk_id =
  // floor(byteOffset / CHUNK_BYTES). Missing rows are zero-filled on read,
  // so growing the canvas never requires a migration — just a redeploy.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS canvas_chunks (
      chunk_id INTEGER PRIMARY KEY,
      bytes    BLOB NOT NULL
    )
  `);

  // Per-user request cooldown (1s rate-limit). Lazy GC: rows are deleted
  // opportunistically on read; the index keeps the GC sweep cheap if/when
  // we need to run it.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cooldowns (
      user_id    TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at)
  `);
}
