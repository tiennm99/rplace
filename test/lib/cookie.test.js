import { describe, it, expect } from 'vitest';
import { parseCookie, formatSetCookie } from '../../src/lib/cookie.js';

describe('parseCookie', () => {
  it('returns empty Map for null/undefined header', () => {
    expect(parseCookie(null).size).toBe(0);
    expect(parseCookie(undefined).size).toBe(0);
    expect(parseCookie('').size).toBe(0);
  });

  it('parses a single name=value pair', () => {
    const m = parseCookie('rplace_id=abc');
    expect(m.get('rplace_id')).toBe('abc');
    expect(m.size).toBe(1);
  });

  it('parses multiple cookies separated by ;', () => {
    const m = parseCookie('a=1; b=2; c=3');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('2');
    expect(m.get('c')).toBe('3');
  });

  it('trims whitespace around names and values', () => {
    const m = parseCookie('  a = 1 ;  b=2');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('2');
  });

  it('skips malformed entries (no equals)', () => {
    const m = parseCookie('a; b=2');
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe('2');
  });

  it('handles values with embedded equals', () => {
    const m = parseCookie('token=abc=def=');
    expect(m.get('token')).toBe('abc=def=');
  });
});

describe('formatSetCookie', () => {
  it('formats minimum required attributes', () => {
    expect(formatSetCookie('a', '1')).toBe('a=1');
  });

  it('emits Path, Max-Age, HttpOnly, Secure, SameSite in expected order', () => {
    const s = formatSetCookie('rplace_id', 'uuid', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 31536000,
    });
    expect(s).toBe('rplace_id=uuid; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax');
  });

  it('omits attributes that are not set', () => {
    expect(formatSetCookie('a', '1', { secure: true })).toBe('a=1; Secure');
  });
});
