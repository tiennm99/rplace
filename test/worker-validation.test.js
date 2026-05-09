import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from '../src/lib/constants.js';

// Worker validation runs at the edge before forwarding to the DO; we don't
// need the real DO for these tests, just a stub that returns whatever response
// the test wants to simulate.
vi.mock('../src/durable-objects/canvas-room.js', () => ({
  CanvasRoom: class {},
}));

import app from '../src/worker.js';

/** Helper to create POST request */
function postPlace(body) {
  return new Request('http://localhost/api/place', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Configurable DO stub. Tests that exercise edge-validation never reach the
 *  DO; tests that pass validation get this canned response. */
let doResponse = () => Response.json({ ok: true });
const env = {
  CANVAS_ROOM: {
    idFromName: () => 'room-id',
    get: () => ({ fetch: () => Promise.resolve(doResponse()) }),
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

  it('forwards rate-limit response from DO unchanged', async () => {
    doResponse = () => Response.json({ error: 'rate_limited', retryAfter: 1 }, { status: 429 });
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('rate_limited');
    expect(data.retryAfter).toBe(1);
  });

  it('forwards 200 OK from DO on valid placement', async () => {
    doResponse = () => Response.json({ ok: true });
    const res = await app.fetch(postPlace({ pixels: [{ x: 0, y: 0, color: 0 }] }), env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('accepts boundary pixel values', async () => {
    doResponse = () => Response.json({ ok: true });
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
