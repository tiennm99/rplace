import { Hono } from 'hono';
import { getUserId } from './lib/get-user-id.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from './lib/constants.js';
import { migrateFromUpstash } from './admin/migrate-from-upstash.js';

export { CanvasRoom } from './durable-objects/canvas-room.js';

const app = new Hono();

// ~64 bytes is generous per pixel JSON object {"x":2047,"y":2047,"color":31}
const MAX_BODY_BYTES = MAX_BATCH_SIZE * 64;

/** Resolve the singleton CanvasRoom DO stub. */
function room(env) {
  return env.CANVAS_ROOM.get(env.CANVAS_ROOM.idFromName('main'));
}

/** GET /api/canvas — full canvas binary, served by the DO directly. */
app.get('/api/canvas', async (c) => {
  return room(c.env).fetch('http://do/canvas');
});

/** POST /api/place — validate at the edge, forward to the DO. */
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
  for (const p of pixels) {
    if (
      !Number.isInteger(p?.x) || !Number.isInteger(p?.y) || !Number.isInteger(p?.color) ||
      p.x < 0 || p.x >= CANVAS_WIDTH ||
      p.y < 0 || p.y >= CANVAS_HEIGHT ||
      p.color < 0 || p.color >= MAX_COLORS
    ) {
      return c.json({ error: 'invalid_pixel', pixel: p }, 400);
    }
  }

  const userId = await getUserId(c.req.raw);

  // DO does cooldown check + pixel write + broadcast in one atomic step.
  return room(c.env).fetch('http://do/place', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pixels }),
  });
});

/** GET /api/ws — WebSocket upgrade routed to the DO. */
app.get('/api/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }
  return room(c.env).fetch(c.req.raw);
});

/**
 * POST /admin/migrate-from-upstash — one-shot Upstash → DO canvas import.
 * Token-gated; deleted in Phase 4 of the canvas-on-do storage plan.
 */
app.post('/admin/migrate-from-upstash', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const expected = `Bearer ${c.env.MIGRATION_TOKEN || ''}`;
  if (!c.env.MIGRATION_TOKEN || auth !== expected) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const force = c.req.query('force') === '1';
  return migrateFromUpstash(c.env, room(c.env), { force });
});

export default app;
