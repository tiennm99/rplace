import { Hono } from 'hono';
import { resolveIdentity, NoIdentityError } from './lib/get-user-id.js';
import { formatSetCookie } from './lib/cookie.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from './lib/constants.js';

export { CanvasRoom } from './durable-objects/canvas-room.js';

const app = new Hono();

// ~64 bytes is generous per pixel JSON object {"x":2047,"y":2047,"color":31}
const MAX_BODY_BYTES = MAX_BATCH_SIZE * 64;

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 365, // 1 year
};

/** Resolve the singleton CanvasRoom DO stub. */
function room(env) {
  return env.CANVAS_ROOM.get(env.CANVAS_ROOM.idFromName('main'));
}

/** GET /api/canvas — full canvas binary, served by the DO directly. Issues
 *  the rplace_id cookie on first request so future calls bypass NAT-shared
 *  IP buckets. */
app.get('/api/canvas', async (c) => {
  let identity;
  try {
    identity = await resolveIdentity(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof NoIdentityError) {
      return c.json({ error: 'no_identity' }, 500);
    }
    throw err;
  }
  const upstream = await room(c.env).fetch('http://do/canvas');
  if (!identity.mintCookieValue) return upstream;
  // Attach Set-Cookie without mutating the upstream Response (its body is a
  // stream; new Response keeps it linked).
  const out = new Response(upstream.body, upstream);
  out.headers.append(
    'Set-Cookie',
    formatSetCookie('rplace_id', identity.mintCookieValue, COOKIE_OPTS),
  );
  return out;
});

/** POST /api/place — validate at the edge, forward to the DO. */
app.post('/api/place', async (c) => {
  // Require a positive Content-Length. Missing or zero would otherwise let a
  // chunked-transfer-encoded body bypass the MAX_BODY_BYTES pre-parse cap.
  const contentLengthRaw = c.req.header('content-length');
  const contentLength = parseInt(contentLengthRaw ?? '', 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return c.json({ error: 'content_length_required' }, 411);
  }
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

  let identity;
  try {
    identity = await resolveIdentity(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof NoIdentityError) {
      return c.json({ error: 'no_identity' }, 500);
    }
    throw err;
  }

  // DO does cooldown check + pixel write + broadcast in one atomic step.
  return room(c.env).fetch('http://do/place', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: identity.id, pixels }),
  });
});

/** GET /api/ws — WebSocket upgrade routed to the DO.
 *  Origin allowlist + identity resolution + per-identity cap (in DO). */
app.get('/api/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }
  // Origin allowlist. Empty ALLOWED_ORIGINS ⇒ allow all (dev / preview).
  const origin = c.req.header('Origin');
  const allowed = parseAllowedOrigins(c.env?.ALLOWED_ORIGINS);
  if (origin && allowed.size > 0 && !allowed.has(origin)) {
    return c.text('forbidden_origin', 403);
  }
  let identity;
  try {
    identity = await resolveIdentity(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof NoIdentityError) {
      return c.json({ error: 'no_identity' }, 500);
    }
    throw err;
  }
  // Identity goes via URL query so the original request (with Upgrade header)
  // forwards unchanged. CF DO routing reads it from request.url.
  const url = `http://do/ws?identity=${encodeURIComponent(identity.id)}`;
  return room(c.env).fetch(url, c.req.raw);
});

/** Parse the comma-separated ALLOWED_ORIGINS env var into a Set. */
function parseAllowedOrigins(raw) {
  const out = new Set();
  if (!raw) return out;
  for (const o of String(raw).split(',')) {
    const trimmed = o.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

export default app;
