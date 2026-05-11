import { describe, it, expect, vi, afterEach } from 'vitest';
import { tryAcquire, release, gc } from '../../src/durable-objects/lib/cooldown-store.js';
import { REQUEST_COOLDOWN_SEC } from '../../src/lib/constants.js';
import { createFakeSql } from '../helpers/fake-sql.js';

const TTL_MS = REQUEST_COOLDOWN_SEC * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tryAcquire — first call', () => {
  it('inserts a fresh row and returns allowed', () => {
    const sql = createFakeSql();
    const now = 1_000_000;
    const r = tryAcquire(sql, 'cookie:abc', now);
    expect(r).toEqual({ allowed: true, retryAfter: 0 });
    expect(sql._cooldowns.get('cookie:abc')).toBe(now + TTL_MS);
  });
});

describe('tryAcquire — within window', () => {
  it('rejects a second call inside TTL', () => {
    const sql = createFakeSql();
    const now = 1_000_000;
    tryAcquire(sql, 'cookie:abc', now);
    const r = tryAcquire(sql, 'cookie:abc', now + 500);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBe(REQUEST_COOLDOWN_SEC);
    // The active row should remain untouched.
    expect(sql._cooldowns.get('cookie:abc')).toBe(now + TTL_MS);
  });
});

describe('tryAcquire — after window expires', () => {
  it('accepts a second call after expires_at', () => {
    const sql = createFakeSql();
    const now = 1_000_000;
    tryAcquire(sql, 'cookie:abc', now);
    const later = now + TTL_MS + 1;
    const r = tryAcquire(sql, 'cookie:abc', later);
    expect(r.allowed).toBe(true);
    expect(sql._cooldowns.get('cookie:abc')).toBe(later + TTL_MS);
  });

  it('accepts exactly at expires_at boundary (<=)', () => {
    const sql = createFakeSql();
    const now = 1_000_000;
    tryAcquire(sql, 'cookie:abc', now);
    const r = tryAcquire(sql, 'cookie:abc', now + TTL_MS);
    expect(r.allowed).toBe(true);
  });
});

describe('tryAcquire — independent users', () => {
  it('does not interfere across user IDs', () => {
    const sql = createFakeSql();
    const now = 1_000_000;
    expect(tryAcquire(sql, 'cookie:a', now).allowed).toBe(true);
    expect(tryAcquire(sql, 'cookie:b', now).allowed).toBe(true);
    expect(tryAcquire(sql, 'cookie:a', now).allowed).toBe(false);
    expect(tryAcquire(sql, 'cookie:b', now).allowed).toBe(false);
  });
});

describe('tryAcquire — INSERT branch executes (cursor drain)', () => {
  it('persists the INSERT even when no UPDATE preceded it', () => {
    const sql = createFakeSql();
    let inserts = 0;
    const origExec = sql.exec;
    sql.exec = (q, ...p) => {
      if (q.startsWith('INSERT INTO cooldowns')) inserts++;
      return origExec(q, ...p);
    };
    tryAcquire(sql, 'cookie:fresh', 1_000_000);
    expect(inserts).toBe(1);
    expect(sql._cooldowns.has('cookie:fresh')).toBe(true);
  });
});

describe('tryAcquire — GC sweep sampling', () => {
  it('deletes expired rows when the sample fires', () => {
    const sql = createFakeSql();
    // Seed expired rows.
    sql._seedCooldown('cookie:dead1', 100);
    sql._seedCooldown('cookie:dead2', 200);
    // Force the sample to fire.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    tryAcquire(sql, 'cookie:fresh', 1_000_000);
    expect(sql._cooldowns.has('cookie:dead1')).toBe(false);
    expect(sql._cooldowns.has('cookie:dead2')).toBe(false);
    expect(sql._cooldowns.has('cookie:fresh')).toBe(true);
  });

  it('does not run GC when sample misses', () => {
    const sql = createFakeSql();
    sql._seedCooldown('cookie:dead', 100);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    tryAcquire(sql, 'cookie:fresh', 1_000_000);
    expect(sql._cooldowns.has('cookie:dead')).toBe(true);
  });

  it('continues if GC throws (best-effort)', () => {
    const sql = createFakeSql();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const origExec = sql.exec;
    sql.exec = (q, ...p) => {
      if (q.startsWith('DELETE FROM cooldowns WHERE expires_at')) {
        throw new Error('boom');
      }
      return origExec(q, ...p);
    };
    const r = tryAcquire(sql, 'cookie:fresh', 1_000_000);
    expect(r.allowed).toBe(true);
  });
});

describe('release', () => {
  it('removes the cooldown row so the next acquire succeeds immediately', () => {
    const sql = createFakeSql();
    tryAcquire(sql, 'cookie:abc', 1_000_000);
    expect(sql._cooldowns.has('cookie:abc')).toBe(true);
    release(sql, 'cookie:abc');
    expect(sql._cooldowns.has('cookie:abc')).toBe(false);
    // Second acquire at the same instant should succeed now.
    expect(tryAcquire(sql, 'cookie:abc', 1_000_000).allowed).toBe(true);
  });

  it('is a no-op when the row does not exist', () => {
    const sql = createFakeSql();
    expect(() => release(sql, 'cookie:missing')).not.toThrow();
  });
});

describe('gc', () => {
  it('deletes only expired rows', () => {
    const sql = createFakeSql();
    sql._seedCooldown('cookie:dead', 100);
    sql._seedCooldown('cookie:alive', 1_000_000_000);
    gc(sql, 5_000_000);
    expect(sql._cooldowns.has('cookie:dead')).toBe(false);
    expect(sql._cooldowns.has('cookie:alive')).toBe(true);
  });
});
