import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_COLORS, MAX_BATCH_SIZE } from '../lib/constants.js';
import { init as initSchema } from './lib/schema.js';
import { readAllChunks, writePixels } from './lib/chunk-storage.js';
import { tryAcquire } from './lib/cooldown-store.js';

/**
 * CanvasRoom: single Durable Object that owns
 *  - canvas pixel state (SQLite chunk_blob rows)
 *  - per-user rate-limit cooldowns (SQLite TTL rows)
 *  - the WebSocket broadcast hub (Hibernation API)
 *
 * The Worker is a thin proxy that validates input and forwards to one of
 * the four internal endpoints below.
 */
export class CanvasRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    initSchema(this.sql);
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/canvas': return this.#handleGetCanvas();
      case '/place':  return this.#handlePlace(request);
      case '/ws':     return this.#handleWsUpgrade();
      default:        return new Response('not found', { status: 404 });
    }
  }

  #handleGetCanvas() {
    const buffer = readAllChunks(this.sql);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=10, s-maxage=10, stale-while-revalidate=30',
      },
    });
  }

  async #handlePlace(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    const { userId, pixels } = body || {};
    if (typeof userId !== 'string' || !userId) {
      return Response.json({ error: 'invalid_user' }, { status: 400 });
    }
    if (!Array.isArray(pixels) || pixels.length === 0) {
      return Response.json({ error: 'pixels_required' }, { status: 400 });
    }
    if (pixels.length > MAX_BATCH_SIZE) {
      return Response.json({ error: 'batch_too_large', max: MAX_BATCH_SIZE }, { status: 400 });
    }
    for (const p of pixels) {
      if (
        !Number.isInteger(p?.x) || !Number.isInteger(p?.y) || !Number.isInteger(p?.color) ||
        p.x < 0 || p.x >= CANVAS_WIDTH ||
        p.y < 0 || p.y >= CANVAS_HEIGHT ||
        p.color < 0 || p.color >= MAX_COLORS
      ) {
        return Response.json({ error: 'invalid_pixel', pixel: p }, { status: 400 });
      }
    }

    // Rate-limit then write+broadcast atomically (DO single-threaded).
    const { allowed, retryAfter } = tryAcquire(this.sql, userId);
    if (!allowed) {
      return Response.json({ error: 'rate_limited', retryAfter }, { status: 429 });
    }

    try {
      writePixels(this.sql, pixels);
    } catch (err) {
      console.error('writePixels failed:', err);
      return Response.json({ error: 'storage_failed', message: String(err) }, { status: 500 });
    }

    this.#broadcastPixels(pixels);
    return Response.json({ ok: true });
  }

  #handleWsUpgrade() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  #broadcastPixels(pixels) {
    const message = JSON.stringify({ type: 'pixels', pixels });
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch (err) {
        console.warn('WS send failed, closing socket:', err?.message || err);
        try { ws.close(1011, 'send failed'); } catch { /* already closed */ }
      }
    }
  }

  /** Hibernation-API callbacks. */

  webSocketMessage(ws) {
    // Protocol is broadcast-only; reject any inbound payload.
    ws.close(1003, 'unexpected client message');
  }

  webSocketClose(ws, code, reason, wasClean) {
    if (!wasClean) {
      console.warn(`WS unclean close: code=${code} reason=${reason || '<none>'}`);
    }
    // Required pre-2026-04-07 compat date; harmless after.
    ws.close(code, reason);
  }

  webSocketError(ws, error) {
    console.error('WS error:', error?.message || error);
    ws.close(1011, 'error');
  }
}
