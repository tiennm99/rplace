import { describe, it, expect } from 'vitest';
import { getUserId } from '../../src/lib/get-user-id.js';

/** Helper to create a mock Request with headers */
function mockRequest(headers = {}) {
  return new Request('http://localhost', {
    headers: new Headers(headers),
  });
}

describe('getUserId', () => {
  it('returns anon: prefix', () => {
    const id = getUserId(mockRequest({ 'cf-connecting-ip': '1.2.3.4' }));
    expect(id).toMatch(/^anon:/);
  });

  it('returns deterministic ID for same IP', () => {
    const req1 = mockRequest({ 'cf-connecting-ip': '192.168.1.1' });
    const req2 = mockRequest({ 'cf-connecting-ip': '192.168.1.1' });
    expect(getUserId(req1)).toBe(getUserId(req2));
  });

  it('returns different IDs for different IPs', () => {
    const id1 = getUserId(mockRequest({ 'cf-connecting-ip': '1.1.1.1' }));
    const id2 = getUserId(mockRequest({ 'cf-connecting-ip': '2.2.2.2' }));
    expect(id1).not.toBe(id2);
  });

  it('falls back to 127.0.0.1 when header is missing', () => {
    const id = getUserId(mockRequest({}));
    expect(id).toMatch(/^anon:/);
    // Should be deterministic for missing header too
    expect(getUserId(mockRequest({}))).toBe(id);
  });
});
