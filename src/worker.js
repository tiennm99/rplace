import { Hono } from 'hono';
import { getFullCanvas, setPixels } from './lib/canvas-storage.js';
import { getUserId } from './lib/get-user-id.js';
import { checkAndDeductCredits } from './lib/rate-limiter.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from './lib/constants.js';

export { CanvasRoom } from './durable-objects/canvas-room.js';

const app = new Hono();

// ~64 bytes is generous per pixel JSON object {"x":2047,"y":2047,"color":31}
const MAX_BODY_BYTES = MAX_BATCH_SIZE * 64;

/** GET /api/canvas — full canvas as binary.
 * Cloudflare's edge auto-compresses compressible content; we don't set
 * Content-Encoding manually (caused double-encoding / undecoded blobs
 * through wrangler dev + vite proxy during testing). */
app.get('/api/canvas', async (c) => {
  try {
    const buffer = await getFullCanvas(c.env);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=10, s-maxage=10, stale-while-revalidate=30',
      },
    });
  } catch (err) {
    console.error('Canvas read failed:', err);
    return c.json({ error: 'canvas_read_failed', message: String(err) }, 500);
  }
});

/** POST /api/place — batch pixel placement */
app.post('/api/place', async (c) => {
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: 'body_too_large', max: MAX_BODY_BYTES }, 413);
  }

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
  const userId = await getUserId(c.req.raw);
  const { allowed, remaining, retryAfter } = await checkAndDeductCredits(
    c.env, userId, pixels.length,
  );
  if (!allowed) {
    return c.json({ error: 'rate_limited', remaining, retryAfter }, 429);
  }

  // Persist pixels (must succeed before broadcast)
  try {
    await setPixels(c.env, pixels);
  } catch (err) {
    console.error('Redis write failed:', err);
    return c.json({ error: 'storage_failed', message: String(err) }, 500);
  }

  // Broadcast in background — don't block the user response on DO fetch.
  // In non-CF runtimes (tests), executionCtx is unavailable; fall back to fire-and-forget.
  const broadcastTask = broadcastPixels(c.env, pixels);
  let ctx = null;
  try { ctx = c.executionCtx; } catch { /* no-op */ }
  if (ctx) {
    ctx.waitUntil(broadcastTask);
  } else {
    broadcastTask.catch((err) => console.error('Broadcast:', err));
  }

  return c.json({ ok: true, credits: remaining });
});

async function broadcastPixels(env, pixels) {
  try {
    const roomId = env.CANVAS_ROOM.idFromName('main');
    const room = env.CANVAS_ROOM.get(roomId);
    const r = await room.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(pixels),
    }));
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('Broadcast non-OK:', r.status, text);
    }
  } catch (err) {
    console.error('Broadcast threw:', err);
  }
}

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
