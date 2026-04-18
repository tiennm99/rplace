# rplace

A collaborative pixel art canvas inspired by [Reddit's r/place](https://www.reddit.com/r/place/). Place pixels, create art together in real-time.

## Features

- **2048x2048 canvas** with 32-color palette (from [rplace.live](https://rplace.live/))
- **Real-time updates** via WebSocket (Cloudflare Durable Objects)
- **Batch pixel placement** up to 2048 pixels per request
- **Rate limit** — 1 request per second per user (batch size independent)
- **Zoom/pan** with mouse wheel + drag (desktop) and pinch-zoom + drag (mobile)
- **Long-press to place** on touch devices
- **Image importer** — upload, dither, and auto-paint images onto the canvas

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | [Svelte 5](https://svelte.dev/) (runes) + HTML5 Canvas |
| Backend | [Hono](https://hono.dev/) on Cloudflare Workers |
| Real-time | WebSocket via Cloudflare Durable Objects |
| Storage | [Upstash Redis](https://upstash.com/) (BITFIELD for canvas, SET NX EX for rate limiting) |
| Build | [Vite](https://vite.dev/) |

## Architecture

```
Browser (Svelte SPA + WebSocket)
  |  GET  /api/canvas  → full canvas binary (2.5MB raw)
  |  POST /api/place   → batch pixel placement
  |  WS   /api/ws      → Durable Object broadcast room
  v
Cloudflare Worker (Hono)
  ├── Canvas API (read/write pixels via Redis BITFIELD)
  ├── Rate Limiter (SET NX EX — atomic per-user cooldown)
  └── Durable Object (WebSocket broadcast to all clients)
        ↕
Upstash Redis
  ├── BITFIELD "canvas" (5-bit per pixel, 2048x2048 = 2.62MB)
  └── STRING "cooldown:{userId}" (1s TTL, blocks repeat requests)
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/) (free tier works)
- [Upstash Redis](https://console.upstash.com/) database (free tier works)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd rplace
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Upstash Redis credentials

# For wrangler (Cloudflare Workers CLI)
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

### Development

```bash
# Run worker locally (serves both API and frontend)
npm run dev

# Or run frontend and worker separately
npm run dev:client   # Vite dev server on :5173 (proxies /api to :8787)
npm run dev          # Wrangler dev server on :8787
```

### Deploy

```bash
npm run deploy   # Builds frontend + deploys worker to Cloudflare
```

## Project Structure

```
src/
├── worker.js                          # Hono API entry point
├── durable-objects/
│   └── canvas-room.js                 # WebSocket broadcast room
├── lib/
│   ├── constants.js                   # Config, palette, limits (shared)
│   ├── redis-client.js                # Upstash Redis factory
│   ├── canvas-storage.js              # BITFIELD read/write
│   ├── canvas-decoder.js              # 5-bit → RGBA (client-side)
│   ├── rate-limiter.js                # SET NX EX cooldown
│   ├── image-uploader.js              # Browser-side batched uploader
│   └── get-user-id.js                 # IP-based identity
├── client/
│   ├── main.js                        # Svelte mount
│   ├── App.svelte                     # Root + WebSocket
│   ├── app.css                        # Global styles
│   └── components/
│       ├── CanvasRenderer.svelte      # Canvas + zoom/pan + touch
│       ├── ColorPicker.svelte         # 32-color palette grid
│       ├── CanvasControls.svelte      # Zoom buttons + coordinates
│       ├── DrawToolbar.svelte         # Paint / submit / undo / redo
│       └── ImageImporter.svelte       # Image-to-canvas uploader
└── index.html                         # Vite entry
```

## API

### `GET /api/canvas`

Returns the full canvas as raw binary (5-bit packed, ~2.5MB).

### `POST /api/place`

Place pixels on the canvas.

```json
{
  "pixels": [
    { "x": 100, "y": 200, "color": 27 }
  ]
}
```

**Response:** `{ "ok": true }`

**Errors:**
- `400` — invalid pixel data or batch > 2048
- `413` — request body too large
- `429` — rate limited (includes `retryAfter` seconds)

### `WS /api/ws`

WebSocket for real-time pixel updates. Messages are JSON:

```json
{ "type": "pixels", "pixels": [{ "x": 100, "y": 200, "color": 27 }] }
```

## Configuration

Key constants in `src/lib/constants.js`:

| Constant | Default | Description |
|---|---|---|
| `CANVAS_WIDTH` | 2048 | Canvas width in pixels |
| `CANVAS_HEIGHT` | 2048 | Canvas height in pixels |
| `MAX_COLORS` | 32 | Number of colors in palette |
| `MAX_BATCH_SIZE` | 2048 | Max pixels per placement request |
| `REQUEST_COOLDOWN_SEC` | 1 | Minimum seconds between requests per user |

## Credits & References

- [Reddit on Building & Scaling r/place (Fastly)](https://www.fastly.com/blog/reddit-on-building-scaling-rplace)
- [Engineering Behind r/place (Sai Kumar Chintada)](https://saikumarchintada.medium.com/engineering-behind-r-place-a7eb53bcf5f1)
- [Redis Place: Building r/place with 9 Redis Data Structures (Mehdi Amrane)](https://dev.to/mehdi/redis-place-building-rplace-with-9-redis-data-structures-3lj8)
- [Redis Pixel War (Alfredo Salzillo)](https://dev.to/alfredosalzillo/redis-pixel-war-3i7a)
- [Redis BITFIELD Command](https://redis.io/docs/latest/commands/bitfield/)
- [reddit-plugin-place-opensource](https://github.com/reddit-archive/reddit-plugin-place-opensource)
- [rPlace by anthonytedja](https://github.com/anthonytedja/rPlace)
- [redis-place by mehdiamrane](https://github.com/mehdiamrane/redis-place)
- [redis-challenge by alfredosalzillo](https://github.com/alfredosalzillo/redis-challenge)
- [place by dynastic](https://github.com/dynastic/place)
- [rplace.live](https://rplace.live/) — color palette reference

## License

MIT
