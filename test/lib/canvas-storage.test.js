import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CANVAS_WIDTH, REDIS_CANVAS_KEY } from '../../src/lib/constants.js';

// Mock redis-client module
vi.mock('../../src/lib/redis-client.js', () => ({
  redisRaw: vi.fn(),
  redisRawBinary: vi.fn(),
}));

import { getFullCanvas, setPixels } from '../../src/lib/canvas-storage.js';
import { redisRaw, redisRawBinary } from '../../src/lib/redis-client.js';

const CANVAS_BYTES = Math.ceil((CANVAS_WIDTH * CANVAS_WIDTH * 5) / 8);

describe('setPixels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing for empty array', async () => {
    await setPixels({}, []);
    expect(redisRaw).not.toHaveBeenCalled();
  });

  it('builds correct BITFIELD command for single pixel', async () => {
    redisRaw.mockResolvedValue({ result: [0] });
    await setPixels({}, [{ x: 10, y: 20, color: 5 }]);

    const call = redisRaw.mock.calls[0][1];
    expect(call[0]).toBe('BITFIELD');
    expect(call[1]).toBe(REDIS_CANVAS_KEY);
    expect(call[2]).toBe('SET');
    expect(call[3]).toBe('u5');
    // offset = 20 * 2048 + 10 = 40970
    expect(call[4]).toBe('#40970');
    expect(call[5]).toBe('5');
  });

  it('builds correct BITFIELD command for multiple pixels', async () => {
    redisRaw.mockResolvedValue({ result: [0, 0] });
    await setPixels({}, [
      { x: 0, y: 0, color: 1 },
      { x: 1, y: 0, color: 31 },
    ]);

    const call = redisRaw.mock.calls[0][1];
    // BITFIELD key SET u5 #0 1 SET u5 #1 31
    expect(call).toEqual([
      'BITFIELD', REDIS_CANVAS_KEY,
      'SET', 'u5', '#0', '1',
      'SET', 'u5', '#1', '31',
    ]);
  });

  it('computes offset correctly for various positions', async () => {
    redisRaw.mockResolvedValue({ result: [0] });

    // Pixel at (2047, 2047) — last pixel
    await setPixels({}, [{ x: 2047, y: 2047, color: 0 }]);
    const offset = 2047 * CANVAS_WIDTH + 2047;
    expect(redisRaw.mock.calls[0][1][4]).toBe(`#${offset}`);
  });
});

describe('getFullCanvas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zero-filled buffer when Redis returns null', async () => {
    redisRawBinary.mockResolvedValue(null);
    const buf = await getFullCanvas({});
    expect(buf.length).toBe(CANVAS_BYTES);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('returns zero-filled buffer when Redis returns empty string', async () => {
    redisRawBinary.mockResolvedValue('');
    const buf = await getFullCanvas({});
    expect(buf.length).toBe(CANVAS_BYTES);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('decodes base64 response correctly', async () => {
    // 3 bytes: [0x78, 0xAB, 0xFF]
    const base64 = btoa(String.fromCharCode(0x78, 0xAB, 0xFF));
    redisRawBinary.mockResolvedValue(base64);
    const buf = await getFullCanvas({});
    expect(buf[0]).toBe(0x78);
    expect(buf[1]).toBe(0xAB);
    expect(buf[2]).toBe(0xFF);
  });

  it('pads short responses to full canvas size', async () => {
    const base64 = btoa(String.fromCharCode(0xFF));
    redisRawBinary.mockResolvedValue(base64);
    const buf = await getFullCanvas({});
    expect(buf.length).toBe(CANVAS_BYTES);
    expect(buf[0]).toBe(0xFF);
    expect(buf[1]).toBe(0);
  });

  it('handles all byte values (0x00-0xFF) without corruption', async () => {
    // This is the test that would have caught the binary encoding bug
    const allBytes = new Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = String.fromCharCode(i);
    const base64 = btoa(allBytes.join(''));
    redisRawBinary.mockResolvedValue(base64);

    const buf = await getFullCanvas({});
    for (let i = 0; i < 256; i++) {
      expect(buf[i]).toBe(i);
    }
  });
});
