import { describe, it, expect } from 'vitest';
import { getUserId } from '../../src/lib/get-user-id.js';

/** Helper to create a mock Request with headers */
function mockRequest(headers = {}) {
  return new Request('http://localhost', {
    headers: new Headers(headers),
  });
}

describe('getUserId', () => {
  it('returns anon: prefix', async () => {
    const id = await getUserId(mockRequest({ 'cf-connecting-ip': '1.2.3.4' }));
    expect(id).toMatch(/^anon:/);
  });

  it('returns deterministic ID for same IP', async () => {
    const id1 = await getUserId(mockRequest({ 'cf-connecting-ip': '192.168.1.1' }));
    const id2 = await getUserId(mockRequest({ 'cf-connecting-ip': '192.168.1.1' }));
    expect(id1).toBe(id2);
  });

  it('returns different IDs for different IPs', async () => {
    const id1 = await getUserId(mockRequest({ 'cf-connecting-ip': '1.1.1.1' }));
    const id2 = await getUserId(mockRequest({ 'cf-connecting-ip': '2.2.2.2' }));
    expect(id1).not.toBe(id2);
  });

  it('falls back to a shared dev bucket when header is missing', async () => {
    const id = await getUserId(mockRequest({}));
    expect(id).toBe('anon:dev');
    // Deterministic for missing header
    expect(await getUserId(mockRequest({}))).toBe(id);
  });

  it('uses 16-hex-char (8-byte) suffix from SHA-256', async () => {
    const id = await getUserId(mockRequest({ 'cf-connecting-ip': '203.0.113.45' }));
    expect(id).toMatch(/^anon:[0-9a-f]{16}$/);
  });
});
