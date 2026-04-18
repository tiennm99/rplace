# System Architecture

## Overview

rplace is a collaborative pixel canvas deployed as a single Cloudflare Worker. The frontend (Svelte SPA) is served as static assets, the API (Hono) handles pixel operations, and a Durable Object manages WebSocket broadcasting.

## Data Flow

### Pixel Placement

```
1. User draws on canvas → optimistic render into a pending buffer
2. User hits Submit → POST /api/place { pixels: [{x, y, color}] }
3. Worker validates input (bounds, types, batch size ≤ 2048)
4. Worker checks cooldown via SET NX EX (atomic per-user lock)
5. Worker writes pixels via Redis BITFIELD (atomic batch)
6. Worker sends pixels to Durable Object /broadcast
7. Durable Object fans out to all WebSocket clients
8. Response: { ok: true }
```

### Canvas Loading

```
1. Client fetches GET /api/canvas
2. Worker reads Redis key via GETRANGE → raw binary
3. Client receives ~2.5MB (5-bit packed pixels)
4. Client decodes 5-bit values → color indices → RGBA ImageData
5. Renders onto HTML5 Canvas with OffscreenCanvas
```

### Real-time Updates

```
1. Client connects WS /api/ws
2. Worker upgrades to Durable Object WebSocket
3. DO stores connection in memory Set
4. On pixel placement → DO broadcasts JSON to all connections
5. Client updates local ImageData + re-renders
6. On disconnect → auto-reconnect with exponential backoff (1s→30s)
```

## Storage

### Redis BITFIELD (Canvas)

- Key: `canvas`
- Encoding: 5 bits per pixel (u5), 32 colors
- Size: `2048 * 2048 * 5 / 8 = 2,621,440 bytes` (~2.5MB)
- Offset: `y * CANVAS_WIDTH + x`
- Atomic batch writes: single BITFIELD command with chained .set() calls

### Redis STRING (Cooldown)

- Key pattern: `cooldown:{userId}`
- Value: `"1"` (presence is the signal; content is irrelevant)
- TTL: `REQUEST_COOLDOWN_SEC` (1s) — auto-expires, no explicit cleanup
- Atomic via `SET key "1" NX EX 1`

## Rate Limiting

Fixed-window cooldown, one request per second per user:

```
On placement request:
1. SET cooldown:{userId} "1" NX EX 1
2. If reply == "OK" → allow (key set, TTL 1s)
3. If reply == null → reject (429, retryAfter = 1)
```

Batch size is independent of the cooldown; it is validated separately
(MAX_BATCH_SIZE = 2048). Anonymous identity via CF-Connecting-IP hash.

## Security

- **Rate limiting**: Atomic `SET NX EX` prevents race conditions
- **Identity**: CF-Connecting-IP (set by Cloudflare, unspoofable)
- **Input validation**: Bounds checking, type checking, integer validation on all pixel data
- **Batch cap**: Max 2048 pixels per request + request body size guard
- **DO isolation**: /broadcast route only reachable via DO stub, not externally
