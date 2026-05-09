import { describe, it, expect } from 'vitest';
import { resolveIdentity, NoIdentityError } from '../../src/lib/get-user-id.js';

/** Helper to build a mock Request with selected headers. */
function mockRequest(headers = {}) {
  return new Request('http://localhost', { headers: new Headers(headers) });
}

describe('resolveIdentity — cookie-first', () => {
  it('returns cookie:<uuid> when rplace_id cookie is present', async () => {
    const cookie = '12345678-1234-1234-1234-123456789abc';
    const r = await resolveIdentity(mockRequest({ cookie: `rplace_id=${cookie}` }));
    expect(r.id).toBe(`cookie:${cookie}`);
    expect(r.mintCookieValue).toBeUndefined();
  });

  it('rejects malformed cookie values and falls back to IP', async () => {
    const r = await resolveIdentity(mockRequest({
      cookie: 'rplace_id=" OR 1=1 --"',
      'cf-connecting-ip': '1.2.3.4',
    }));
    expect(r.id).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(r.mintCookieValue).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cookie wins over IP when both present', async () => {
    const cookie = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await resolveIdentity(mockRequest({
      cookie: `rplace_id=${cookie}`,
      'cf-connecting-ip': '1.2.3.4',
    }));
    expect(r.id).toBe(`cookie:${cookie}`);
    expect(r.mintCookieValue).toBeUndefined();
  });
});

describe('resolveIdentity — IP fallback', () => {
  it('returns ip:<hash> with mintCookieValue when only IP is present', async () => {
    const r = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '1.2.3.4' }));
    expect(r.id).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(r.mintCookieValue).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('IP hash is deterministic per IP', async () => {
    const a = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '192.168.1.1' }));
    const b = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '192.168.1.1' }));
    expect(a.id).toBe(b.id);
  });

  it('different IPs produce different hashes', async () => {
    const a = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '1.1.1.1' }));
    const b = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '2.2.2.2' }));
    expect(a.id).not.toBe(b.id);
  });

  it('mintCookieValue is unique per call', async () => {
    const a = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '1.2.3.4' }));
    const b = await resolveIdentity(mockRequest({ 'cf-connecting-ip': '1.2.3.4' }));
    expect(a.mintCookieValue).not.toBe(b.mintCookieValue);
  });
});

describe('resolveIdentity — no cookie, no IP', () => {
  it('falls back to dev:shared in non-production env', async () => {
    const r = await resolveIdentity(mockRequest({}), { ENVIRONMENT: 'development' });
    expect(r.id).toBe('dev:shared');
    expect(r.mintCookieValue).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to dev:shared when env is undefined', async () => {
    const r = await resolveIdentity(mockRequest({}));
    expect(r.id).toBe('dev:shared');
  });

  it('throws NoIdentityError in production', async () => {
    await expect(resolveIdentity(mockRequest({}), { ENVIRONMENT: 'production' }))
      .rejects.toBeInstanceOf(NoIdentityError);
  });
});
