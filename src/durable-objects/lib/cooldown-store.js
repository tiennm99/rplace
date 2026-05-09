import { REQUEST_COOLDOWN_SEC } from '../../lib/constants.js';

const TTL_MS = REQUEST_COOLDOWN_SEC * 1000;

// Probability of running a GC sweep on each tryAcquire. Cheap insurance
// against unbounded table growth without paying for it on every call.
const GC_SAMPLE_RATE = 0.01;

/**
 * Atomically claim a 1-second cooldown window for a user. Returns
 * { allowed:true } on success, { allowed:false, retryAfter } if the user
 * already holds an unexpired claim.
 *
 * Implementation: UPDATE existing row only if expired; if no rows changed,
 * try INSERT. If INSERT fails (race or fresh non-expired row), the user is
 * blocked.
 *
 * @param {SqlStorage} sql
 * @param {string} userId
 * @param {number} now - Date.now()
 */
export function tryAcquire(sql, userId, now = Date.now()) {
  const expiresAt = now + TTL_MS;

  // Update only if existing row is expired. CF DO sql.exec returns a cursor
  // with a `rowsWritten` property after execution.
  const updateCursor = sql.exec(
    'UPDATE cooldowns SET expires_at = ? WHERE user_id = ? AND expires_at <= ?',
    expiresAt,
    userId,
    now,
  );
  // Drain the cursor so rowsWritten is finalized.
  updateCursor.toArray();
  if (updateCursor.rowsWritten > 0) {
    if (Math.random() < GC_SAMPLE_RATE) {
      try { gc(sql, now); } catch { /* GC is best-effort */ }
    }
    return { allowed: true, retryAfter: 0 };
  }

  // No expired row to update. Either the user has never been seen (insert
  // succeeds) or they hold an active claim (insert fails on PK conflict).
  try {
    const insertCursor = sql.exec(
      'INSERT INTO cooldowns (user_id, expires_at) VALUES (?, ?)',
      userId,
      expiresAt,
    );
    // Drain symmetrically with the UPDATE branch so statement effects commit.
    insertCursor.toArray();
    if (Math.random() < GC_SAMPLE_RATE) {
      try { gc(sql, now); } catch { /* GC is best-effort */ }
    }
    return { allowed: true, retryAfter: 0 };
  } catch {
    return { allowed: false, retryAfter: REQUEST_COOLDOWN_SEC };
  }
}

/**
 * Refund a cooldown row so a transient write failure doesn't soft-DOS the
 * user for 1s. Called from the catch path in placePixels.
 */
export function release(sql, userId) {
  sql.exec('DELETE FROM cooldowns WHERE user_id = ?', userId).toArray();
}

/** Delete all expired cooldown rows. Cheap with the expires_at index. */
export function gc(sql, now = Date.now()) {
  sql.exec('DELETE FROM cooldowns WHERE expires_at <= ?', now).toArray();
}
