import { Hono } from 'hono';
import { getFullCanvas, setPixels } from './lib/canvas-storage.js';
import { getUserId } from './lib/get-user-id.js';
import { checkAndDeductCredits } from './lib/rate-limiter.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from './lib/constants.js';

export { CanvasRoom } from './durable-objects/canvas-room.js';

const app = new Hono();

/** GET /api/canvas — full canvas as binary */
app.get('/api/canvas', async (c) => {
  const buffer = await getFullCanvas(c.env);
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=1, s-maxage=1, stale-while-revalidate=5',
    },
  });
});

/** POST /api/place — batch pixel placement */
app.post('/api/place', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { pixels } = body;
  if (!Array.isArray(pixels) || pixels.length === 0) {
    return c.json({ error: 'pixels_required' }, 400);
  }
  if (pixels.length > MAX_BATCH_SIZE) {
    return c.json({ error: 'batch_too_large', max: MAX_BATCH_SIZE }, 400);
  }

  // Validate each pixel
  for (const p of pixels) {
    if (
      typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.color !== 'number' ||
      p.x < 0 || p.x >= CANVAS_WIDTH ||
      p.y < 0 || p.y >= CANVAS_HEIGHT ||
      p.color < 0 || p.color >= MAX_COLORS ||
      !Number.isInteger(p.x) || !Number.isInteger(p.y) ||
      !Number.isInteger(p.color)
    ) {
      return c.json({ error: 'invalid_pixel', pixel: p }, 400);
    }
  }

  // Rate limiting
  const userId = getUserId(c.req.raw);
  const { allowed, remaining, retryAfter } = await checkAndDeductCredits(
    c.env, userId, pixels.length,
  );
  if (!allowed) {
    return c.json({ error: 'rate_limited', remaining, retryAfter }, 429);
  }

  // Write pixels to canvas + broadcast
  try {
    await setPixels(c.env, pixels);
  } catch (err) {
    console.error('Redis write failed:', err);
    return c.json({ error: 'storage_failed', message: String(err) }, 500);
  }

  try {
    const roomId = c.env.CANVAS_ROOM.idFromName('main');
    const room = c.env.CANVAS_ROOM.get(roomId);
    await room.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(pixels),
    }));
  } catch (err) {
    console.error('Broadcast failed:', err);
  }

  return c.json({ ok: true, credits: remaining });
});

/** WebSocket upgrade — delegate to Durable Object */
app.get('/api/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }

  const roomId = c.env.CANVAS_ROOM.idFromName('main');
  const room = c.env.CANVAS_ROOM.get(roomId);
  return room.fetch(c.req.raw);
});

export default app;
