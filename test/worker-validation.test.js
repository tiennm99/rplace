import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from '../src/lib/constants.js';

// Mock all external dependencies before importing worker
vi.mock('../src/lib/canvas-storage.js', () => ({
  getFullCanvas: vi.fn(() => Promise.resolve(new Uint8Array(10))),
  setPixels: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/lib/rate-limiter.js', () => ({
  checkAndDeductCredits: vi.fn(() =>
    Promise.resolve({ allowed: true, remaining: 100, retryAfter: 0 }),
  ),
}));
vi.mock('../src/durable-objects/canvas-room.js', () => ({
  CanvasRoom: class {},
}));

import app from '../src/worker.js';
import { checkAndDeductCredits } from '../src/lib/rate-limiter.js';

/** Helper to create POST request */
function postPlace(body) {
  return new Request('http://localhost/api/place', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Minimal env mock with Durable Object stub */
const env = {
  CANVAS_ROOM: {
    idFromName: () => 'room-id',
    get: () => ({
      fetch: () => Promise.resolve(new Response('ok')),
    }),
  },
};

describe('POST /api/place validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/api/place', {
      method: 'POST',
      body: 'not json',
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_json');
  });

  it('rejects missing pixels array', async () => {
    const res = await app.fetch(postPlace({}), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('pixels_required');
  });

  it('rejects empty pixels array', async () => {
    const res = await app.fetch(postPlace({ pixels: [] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('pixels_required');
  });

  it('rejects non-array pixels', async () => {
    const res = await app.fetch(postPlace({ pixels: 'not an array' }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('pixels_required');
  });

  it('rejects batch exceeding MAX_BATCH_SIZE', async () => {
    const pixels = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      x: i % CANVAS_WIDTH, y: 0, color: 0,
    }));
    const res = await app.fetch(postPlace({ pixels }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('batch_too_large');
  });

  it('rejects pixel with x out of bounds', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: CANVAS_WIDTH, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects pixel with negative x', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: -1, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects pixel with y out of bounds', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: CANVAS_HEIGHT, color: 0 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects pixel with color out of range', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: MAX_COLORS }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects pixel with negative color', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: -1 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects non-integer coordinates', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: 1.5, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects non-integer color', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: 1.5 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('rejects string values for coordinates', async () => {
    const res = await app.fetch(postPlace({ pixels: [{ x: '0', y: 0, color: 0 }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_pixel');
  });

  it('returns 429 when rate limited', async () => {
    checkAndDeductCredits.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 5 });
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
  });

  it('accepts valid pixel placement', async () => {
    checkAndDeductCredits.mockResolvedValue({ allowed: true, remaining: 255, retryAfter: 0 });
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.credits).toBe(255);
  });

  it('accepts boundary pixel values', async () => {
    checkAndDeductCredits.mockResolvedValue({ allowed: true, remaining: 255, retryAfter: 0 });
    const res = await app.fetch(postPlace({
      pixels: [{ x: CANVAS_WIDTH - 1, y: CANVAS_HEIGHT - 1, color: MAX_COLORS - 1 }],
    }), env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('GET /api/ws', () => {
  it('returns 426 without WebSocket upgrade header', async () => {
    const req = new Request('http://localhost/api/ws');
    const res = await app.fetch(req, env);
    expect(res.status).toBe(426);
  });
});
