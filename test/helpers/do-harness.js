import { unstable_dev } from 'wrangler';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

/**
 * Boot a local Worker + Durable Object via miniflare (`wrangler unstable_dev`).
 *
 * Returns:
 *   - worker:   the UnstableDevWorker instance
 *   - fetch:    a bound fetch(url, init) that hits the local worker
 *   - close:    async () => worker.stop()
 *
 * The Worker uses real DO SQLite storage, so reads/writes/broadcasts behave
 * as in production. State persists across tests within one suite (one worker
 * per setupDO call). Tests should use unique identities (random cookies) to
 * avoid cooldown cross-talk.
 */

function ensureDistPlaceholder() {
  // The wrangler.json `assets.directory` must exist or miniflare warns.
  // Don't fail tests just because the user hasn't run `npm run build`.
  if (!existsSync('dist')) {
    mkdirSync('dist', { recursive: true });
    writeFileSync('dist/index.html', '<!-- test placeholder -->');
  }
}

export async function setupDO(overrides = {}) {
  ensureDistPlaceholder();
  const worker = await unstable_dev('src/worker.js', {
    config: 'wrangler.json',
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
    persist: false,
    ip: '127.0.0.1',
    ...overrides,
  });
  return {
    worker,
    fetch: worker.fetch.bind(worker),
    address: `${worker.address}:${worker.port}`,
    close: () => worker.stop(),
  };
}

/**
 * POST /api/place helper. Computes Content-Length explicitly because the
 * Worker's edge validation requires it.
 */
export async function placePixel(harness, { x, y, color, cookie }) {
  const body = JSON.stringify({ pixels: [{ x, y, color }] });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(new TextEncoder().encode(body).byteLength),
  };
  if (cookie) headers.Cookie = `rplace_id=${cookie}`;
  const res = await harness.fetch('/api/place', { method: 'POST', headers, body });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    setCookie,
    json: res.headers.get('content-type')?.includes('json') ? await res.json() : null,
  };
}

/** GET /api/canvas — returns { status, bytes, setCookie }. */
export async function fetchCanvas(harness, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `rplace_id=${cookie}`;
  const res = await harness.fetch('/api/canvas', { headers });
  const bytes = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
  return {
    status: res.status,
    bytes,
    setCookie: res.headers.get('set-cookie'),
  };
}

/**
 * Open a WS connection against the running worker. `unstable_dev`'s fetch is
 * undici-based and strips the CF-specific `.webSocket` field, so we connect
 * with the `ws` package against the worker's HTTP port instead.
 *
 * Returns either `{ status: 101, ws }` once the open event fires, or
 * `{ status, ws: null }` if the upgrade is rejected with a non-101 response.
 */
export function openWs(harness, { cookie, origin } = {}) {
  const url = `ws://${harness.address}/api/ws`;
  const headers = {};
  if (cookie) headers.Cookie = `rplace_id=${cookie}`;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve) => {
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      ws.removeAllListeners('open');
      ws.removeAllListeners('unexpected-response');
      ws.removeAllListeners('error');
      resolve(value);
    }
    ws.once('open', () => done({ status: 101, ws }));
    ws.once('unexpected-response', (_req, res) => done({ status: res.statusCode, ws: null }));
    ws.once('error', (err) => {
      // Pull HTTP status out of common ws-library errors (e.g. "Unexpected
      // server response: 403"). Fall back to -1 to surface unknown errors.
      const match = String(err?.message || '').match(/(\d{3})/);
      done({ status: match ? Number(match[1]) : -1, ws: null });
    });
  });
}

/** Generate a UUID-shaped cookie value (matches the validator in get-user-id.js). */
export function randomCookie() {
  return crypto.randomUUID();
}

/** Promise wrapper for the next WS message (works with `ws` package). */
export function nextMessage(ws, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`WS message timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    function onMsg(data) {
      clearTimeout(t);
      ws.off('message', onMsg);
      resolve(typeof data === 'string' ? data : data.toString('utf8'));
    }
    ws.on('message', onMsg);
  });
}
