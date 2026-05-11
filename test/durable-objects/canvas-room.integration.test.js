import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupDO,
  placePixel,
  fetchCanvas,
  openWs,
  nextMessage,
  randomCookie,
} from '../helpers/do-harness.js';
import {
  CANVAS_WIDTH,
  TOTAL_PIXELS,
  MAX_BATCH_SIZE,
  MAX_WS_PER_IDENTITY,
} from '../../src/lib/constants.js';

let harness;

beforeAll(async () => {
  harness = await setupDO();
}, 30_000);

afterAll(async () => {
  await harness?.close();
});

describe('GET /api/canvas', () => {
  it('returns a TOTAL_PIXELS-sized body on first call', async () => {
    const { status, bytes } = await fetchCanvas(harness);
    expect(status).toBe(200);
    expect(bytes.length).toBe(TOTAL_PIXELS);
  });

  it('issues Set-Cookie when no cookie is present', async () => {
    const { setCookie } = await fetchCanvas(harness);
    expect(setCookie).toMatch(/^rplace_id=[0-9a-f-]{36}/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
  });

  it('does not re-issue Set-Cookie when a valid cookie is present', async () => {
    const cookie = randomCookie();
    const { setCookie } = await fetchCanvas(harness, { cookie });
    expect(setCookie).toBeNull();
  });
});

describe('POST /api/place — happy path', () => {
  it('places a single pixel and is visible on /api/canvas', async () => {
    const cookie = randomCookie();
    const x = 100, y = 200, color = 42;
    const res = await placePixel(harness, { x, y, color, cookie });
    expect(res.status).toBe(200);
    expect(res.json?.ok).toBe(true);

    const canvas = await fetchCanvas(harness, { cookie });
    const offset = y * CANVAS_WIDTH + x;
    expect(canvas.bytes[offset]).toBe(color);
  });
});

describe('POST /api/place — cooldown', () => {
  it('429s the same cookie within 1 second', async () => {
    const cookie = randomCookie();
    const a = await placePixel(harness, { x: 0, y: 0, color: 1, cookie });
    expect(a.status).toBe(200);
    const b = await placePixel(harness, { x: 1, y: 0, color: 2, cookie });
    expect(b.status).toBe(429);
    expect(b.json?.error).toBe('rate_limited');
  });

  it('does not interfere across distinct cookies', async () => {
    const c1 = randomCookie();
    const c2 = randomCookie();
    const r1 = await placePixel(harness, { x: 10, y: 0, color: 5, cookie: c1 });
    const r2 = await placePixel(harness, { x: 11, y: 0, color: 6, cookie: c2 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe('POST /api/place — Content-Length guard', () => {
  it('rejects POST with missing Content-Length (411)', async () => {
    const res = await harness.fetch('/api/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"pixels":[]}',
    });
    expect(res.status).toBe(411);
  });

  it('rejects POST with zero Content-Length (411)', async () => {
    const res = await harness.fetch('/api/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '0' },
      body: '',
    });
    expect(res.status).toBe(411);
  });

  it('rejects POST above the body cap (413)', async () => {
    // Send a body that actually matches the declared Content-Length so the
    // HTTP transport accepts it; the edge validation should still reject on
    // size alone, before parsing.
    const oversized = '{"pad":"' + 'x'.repeat(MAX_BATCH_SIZE * 64 + 10) + '"}';
    const res = await harness.fetch('/api/place', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(oversized).byteLength),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });
});

describe('WS upgrade', () => {
  it('rejects requests missing the Upgrade header', async () => {
    const res = await harness.fetch('/api/ws');
    expect(res.status).toBe(426);
  });

  it('accepts an upgrade with a valid cookie', async () => {
    const { status, ws } = await openWs(harness, { cookie: randomCookie() });
    expect(status).toBe(101);
    ws.close();
  });
});

describe('WS broadcast', () => {
  it('delivers a pixels frame with monotonic seq to every connected socket', async () => {
    const subCookie = randomCookie();
    const placerCookie = randomCookie();
    const { ws } = await openWs(harness, { cookie: subCookie });

    // Pre-arm the listener BEFORE triggering the broadcast: the WS message
    // can arrive faster than the HTTP response, so registering after the
    // placePixel await would miss it.
    const msgPromise = nextMessage(ws);
    const res = await placePixel(harness, { x: 50, y: 50, color: 9, cookie: placerCookie });
    expect(res.status).toBe(200);

    const data = JSON.parse(await msgPromise);
    expect(data.type).toBe('pixels');
    expect(typeof data.seq).toBe('number');
    expect(data.seq).toBeGreaterThan(0);
    expect(Array.isArray(data.pixels)).toBe(true);
    expect(data.pixels[0]).toMatchObject({ x: 50, y: 50, color: 9 });

    ws.close();
  });

  it('seq increments across placements', async () => {
    const subCookie = randomCookie();
    const p1 = randomCookie();
    const p2 = randomCookie();
    const { ws } = await openWs(harness, { cookie: subCookie });

    const m1Promise = nextMessage(ws);
    await placePixel(harness, { x: 60, y: 0, color: 1, cookie: p1 });
    const m1 = JSON.parse(await m1Promise);

    const m2Promise = nextMessage(ws);
    await placePixel(harness, { x: 61, y: 0, color: 2, cookie: p2 });
    const m2 = JSON.parse(await m2Promise);

    expect(m2.seq).toBeGreaterThan(m1.seq);
    ws.close();
  });
});

describe('WS ping/pong', () => {
  it('responds to "ping" with {type:"pong"}', async () => {
    const { ws } = await openWs(harness, { cookie: randomCookie() });
    ws.send('ping');
    const msg = await nextMessage(ws);
    const data = JSON.parse(msg);
    expect(data.type).toBe('pong');
    ws.close();
  });
});

describe('WS per-identity cap', () => {
  it('accepts up to MAX_WS_PER_IDENTITY sockets, rejects the next', async () => {
    const cookie = randomCookie();
    const sockets = [];
    for (let i = 0; i < MAX_WS_PER_IDENTITY; i++) {
      const r = await openWs(harness, { cookie });
      expect(r.status).toBe(101);
      sockets.push(r.ws);
    }
    const over = await openWs(harness, { cookie });
    expect(over.status).toBe(429);
    for (const ws of sockets) ws.close();
  });
});

describe('WS Origin allowlist (env override)', () => {
  let restricted;
  beforeAll(async () => {
    restricted = await setupDO({
      vars: { ALLOWED_ORIGINS: 'https://allowed.example', ENVIRONMENT: 'development' },
    });
  }, 30_000);
  afterAll(async () => {
    await restricted?.close();
  });

  it('rejects WS upgrade from a disallowed Origin (403)', async () => {
    const r = await openWs(restricted, {
      cookie: randomCookie(),
      origin: 'https://evil.example',
    });
    expect(r.status).toBe(403);
  });

  it('accepts WS upgrade from an allowed Origin', async () => {
    const r = await openWs(restricted, {
      cookie: randomCookie(),
      origin: 'https://allowed.example',
    });
    expect(r.status).toBe(101);
    r.ws?.close();
  });
});
