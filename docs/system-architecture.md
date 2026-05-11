# System Architecture

## Overview

rplace is a collaborative pixel canvas deployed as a single Cloudflare Worker.
The frontend (Svelte SPA) is served as static assets, and a single
**Durable Object** (`CanvasRoom`, `idFromName('main')`) owns canvas state,
rate-limit cooldowns, and the WebSocket broadcast hub. The Worker is a
thin validation/routing proxy.

## Component Map

```
Browser (Svelte SPA + WebSocket)
  |  GET  /api/canvas   → 16 MB binary, edge-cached 10s
  |  POST /api/place    → batch pixel placement (validated at edge)
  |  WS   /api/ws       → real-time pixel deltas
  v
Cloudflare Worker (Hono — thin proxy)
  └─▶ CanvasRoom Durable Object  (single instance, 'main')
        ├── canvas_chunks   SQLite BLOB rows (256 × 64 KB = 16 MB)
        ├── cooldowns       SQLite TTL rows  (1s rate-limit)
        └── WebSocket hub   Hibernation API broadcasts pixel deltas
```

## Data Flow

### Pixel Placement

```
1. User draws on canvas → optimistic render into a pending buffer.
2. User hits Submit → POST /api/place { pixels: [{x, y, color}, ...] }.
3. Worker validates input (bounds, types, batch ≤ 2048, Content-Length).
4. Worker resolves identity (cookie or IP fallback) and forwards to DO /place.
5. DO atomically:
     a. cooldowns.tryAcquire(userId, 1s) — UPDATE expired or INSERT new row.
        On conflict (active claim), responds 429.
     b. state.storage.transactionSync(() => chunk_storage.writePixels(...))
        — group pixels by chunk_id, read each touched chunk's BLOB, modify
        in memory, INSERT OR REPLACE. Transaction makes a multi-chunk batch
        all-or-nothing.
     c. On write failure, cooldown is refunded so transient errors don't
        soft-DOS the user.
     d. Broadcast `{type:'pixels', seq, pixels}` to all hibernating WebSockets.
6. Response: { ok: true } (or { error, retryAfter } on rate limit).
```

The DO is single-threaded; the cooldown + write + broadcast sequence runs
without preemption. The transactionSync wrapper provides atomicity across
multiple BLOB chunks.

### Canvas Loading

```
1. Client fetches GET /api/canvas (10s edge-cache; CDN serves 99% of hits).
2. Worker forwards to DO /canvas on miss.
3. DO chunk_storage.readAllChunks: SELECT all canvas_chunks rows, copy each
   BLOB into a single 16 MB Uint8Array offset by chunk_id × CHUNK_BYTES.
4. Client receives raw bytes (CF auto-gzip), maps each byte → COLORS_RGBA.
5. Renders via OffscreenCanvas + ImageData.
```

### Real-time Updates

```
1. Client connects WS /api/ws.
2. Worker forwards upgrade to DO /ws (URL rewritten to /ws so the DO
   pathname dispatch matches).
3. DO state.acceptWebSocket(server) — Hibernation API; idle sockets
   survive DO eviction at zero CPU cost.
4. On placement → DO iterates state.getWebSockets() and sends JSON.
5. Client merges received pixels into local ImageData; re-renders dirty
   region.
6. On disconnect → exponential-backoff reconnect (1 s → 30 s).
```

## Storage

### `canvas_chunks` (canvas pixels)

| Column | Type | Notes |
|---|---|---|
| `chunk_id` | INTEGER PRIMARY KEY | 0 .. CHUNK_COUNT − 1 |
| `bytes` | BLOB NOT NULL | Exactly CHUNK_BYTES bytes (last chunk may be short) |

- Linear byte layout: `offset = y * CANVAS_WIDTH + x`
- `chunk_id = floor(offset / CHUNK_BYTES)`
- `CHUNK_BYTES = 65536`, `CHUNK_COUNT = ceil(TOTAL_PIXELS / CHUNK_BYTES)`
- **Lazy initialization:** missing rows read as zero-filled buffers. Resizing
  the canvas is just a constants change — new chunks materialize on first
  read. No migration script needed.
- **Hard caps:** CF DO BLOB row size 2 MB → 64 KB chunks have 32× headroom.

### `cooldowns` (rate-limit windows)

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT PRIMARY KEY | `cookie:<uuid>` or `ip:<sha256-prefix>` |
| `expires_at` | INTEGER NOT NULL | ms epoch; row becomes stale past this point |

- `idx_cooldowns_expires` keeps lazy GC sweeps cheap.
- GC runs at 1% sample rate inside `tryAcquire`, wrapped in `try/catch` —
  best-effort; never blocks the rate-limit decision.

## Rate Limiting

Single-row per user, 1 s window. Race-safe inside the DO via:

```
UPDATE cooldowns SET expires_at = ? WHERE user_id = ? AND expires_at <= ?
  → if rowsWritten > 0: claim acquired (existing row was expired).
  → else: INSERT INTO cooldowns ...
        if INSERT throws on PK conflict → claim denied (active row exists).
```

Hardness comes from the DO single-threaded model; no SQL-level locking
needed.

## Free-tier Footprint (CF, 2026)

| Resource | Quota | rplace usage at hobby scale | Headroom |
|---|---|---|---|
| Workers requests | 100K/day | ~100/day (50 users) | 1000× |
| DO storage / object | 10 GB | 16 MB | 600× |
| DO storage / account | 5 GB | 16 MB | 300× |
| BLOB row size | 2 MB | 64 KB chunks | 32× |
| Per-DO request rate | 1,000 / s soft cap | <1 / s | 1000× |
| WS connections / DO | tens of thousands | ~50 | huge |

`/api/canvas` carries `Cache-Control: public, s-maxage=10, stale-while-revalidate=30`.
Verify edge HIT in production via `cf-cache-status: HIT`; if absent, wrap
the worker handler with the Cache API to enforce caching.

## Security

- **Rate limiting**: race-safe at the actor (single-threaded DO); writes
  wrapped in `state.storage.transactionSync` so a multi-chunk batch is
  all-or-nothing.
- **Identity**: opaque `rplace_id` cookie (HttpOnly, Secure, SameSite=Lax,
  1y) issued on first `/api/canvas`. Falls back to a SHA-256 prefix of
  `cf-connecting-ip` when no cookie is present. In production a request
  with neither returns 500 `no_identity`.
- **Cooldown refund**: failed writes refund the cooldown row so a
  transient storage error doesn't soft-DOS the user for 1 s.
- **Input validation**: strict bounds + type checks at the worker edge,
  re-validated at the DO trust boundary. `Content-Length` required on
  POST `/api/place` (411 if missing/zero, 413 if above cap).
- **Body cap**: ~128 KB per `/api/place` (2048 pixels × ~64 B JSON each).
- **WS Origin allowlist**: `ALLOWED_ORIGINS` env var (comma-separated)
  rejects upgrades from disallowed origins; empty = allow all (dev).
- **Per-identity WS cap**: 5 concurrent sockets per identity prevents
  broadcast amplification; further upgrades return 429.
- **DO isolation**: `/canvas`, `/place`, `/ws` are intra-DO paths only —
  not internet-reachable except via the worker.

## Operational Notes

- **Single-region.** DO is anchored to one Cloudflare colo; latency for
  far-away users mirrors the previous Upstash Redis topology — no
  regression.
- **DO eviction mid-place** is safe: the SQLite write commits before
  broadcast. If the DO evicts before broadcast fires, client WS receives
  no message but auto-reconnects and re-fetches `/api/canvas`. No data
  loss; minor latency tail.
- **Storage billing.** Per-account 5 GB free cap on Free plan as of
  Jan 7 2026 — current 16 MB is far under. Monitor on resize.
