import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { redisRaw, redisRawBinary } from '../../src/lib/redis-client.js';

const env = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
};

describe('redisRaw', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends POST with JSON body and auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'OK' }),
    });

    await redisRaw(env, ['SET', 'key', 'value']);

    expect(mockFetch).toHaveBeenCalledWith(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '["SET","key","value"]',
    });
  });

  it('returns the response result field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'PONG' }),
    });
    const result = await redisRaw(env, ['PING']);
    expect(result).toBe('PONG');
  });

  it('throws on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    await expect(redisRaw(env, ['PING'])).rejects.toThrow('Redis HTTP 401');
  });

  it('throws on Upstash 200 with error envelope', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'ERR wrong number of arguments' }),
    });
    await expect(redisRaw(env, ['BITFIELD'])).rejects.toThrow(/Redis error.*wrong number of arguments/);
  });
});

describe('redisRawBinary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses path-based URL with Upstash-Encoding header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'dGVzdA==' }),
    });

    await redisRawBinary(env, ['GETRANGE', 'mykey', '0', '100']);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://redis.example.com/GETRANGE/mykey/0/100');
    expect(opts.headers['Upstash-Encoding']).toBe('base64');
    expect(opts.headers.Authorization).toBe(`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`);
  });

  it('URL-encodes special characters in path segments', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: null }),
    });

    await redisRawBinary(env, ['GETRANGE', 'rplace:canvas', '0', '10']);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('rplace%3Acanvas');
  });

  it('returns base64-encoded result string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'AQID' }),
    });

    const result = await redisRawBinary(env, ['GET', 'key']);
    expect(result).toBe('AQID');
  });

  it('throws on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Error'),
    });
    await expect(redisRawBinary(env, ['GET', 'key'])).rejects.toThrow('Redis HTTP 500');
  });

  it('throws on Upstash 200 with error envelope', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'ERR no such key' }),
    });
    await expect(redisRawBinary(env, ['GET', 'missing'])).rejects.toThrow(/Redis error.*no such key/);
  });
});
