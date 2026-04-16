# System Architecture

## Overview

rplace is a collaborative pixel canvas deployed as a single Cloudflare Worker. The frontend (Svelte SPA) is served as static assets, the API (Hono) handles pixel operations, and a Durable Object manages WebSocket broadcasting.

## Data Flow

### Pixel Placement

```
1. User clicks canvas → optimistic render + credit deduction
2. POST /api/place { pixels: [{x, y, color}] }
3. Worker validates input (bounds, types, batch size ≤ 32)
4. Worker checks credits via Lua script (atomic check-and-deduct)
5. Worker writes pixels via Redis BITFIELD (atomic batch)
6. Worker sends pixels to Durable Object /broadcast
7. Durable Object fans out to all WebSocket clients
8. Response: { ok: true, credits: N }
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

### Redis HASH (Credits)

- Key pattern: `credits:{userId}`
- Fields: `lu` (last update, unix seconds), `cr` (current credits)
- TTL: 24 hours (auto-expire inactive users)
- Accessed via Lua script for atomic check-and-deduct

## Rate Limiting

Token bucket algorithm implemented as a Lua script:

```
On placement request:
1. Read stored credits + lastUpdate from HASH
2. Calculate accrued = stored + floor(elapsed_seconds * regen_rate)
3. Cap at MAX_CREDITS (256)
4. If accrued < requested → reject (429)
5. Else → deduct, update HASH, return remaining
```

New users start with full credits (256). Anonymous identity via CF-Connecting-IP hash.

## Security

- **Rate limiting**: Atomic Lua script prevents race conditions
- **Identity**: CF-Connecting-IP (set by Cloudflare, unspoofable)
- **Input validation**: Bounds checking, type checking, integer validation on all pixel data
- **Batch cap**: Max 32 pixels per request to limit burst damage
- **DO isolation**: /broadcast route only reachable via DO stub, not externally
