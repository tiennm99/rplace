# rplace

A collaborative pixel art canvas inspired by [Reddit's r/place](https://www.reddit.com/r/place/). Place pixels, create art together in real-time.

## Features

- **4096×4096 canvas** with a 256-color palette (16-step grayscale + 240-hue HSL wheel)
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
| Real-time | WebSocket via Cloudflare Durable Objects (Hibernation API) |
| Storage | Durable Object SQLite — chunked BLOB rows for canvas, TTL rows for cooldowns |
| Build | [Vite](https://vite.dev/) |

## Architecture

```
Browser (Svelte SPA + WebSocket)
  |  GET  /api/canvas   → full canvas binary (16 MB, edge-cached 10s)
  |  POST /api/place    → batch pixel placement (validated at edge)
  |  WS   /api/ws       → CanvasRoom Durable Object broadcast
  v
Cloudflare Worker (Hono — thin proxy)
  └─▶ CanvasRoom Durable Object  (single instance, idFromName('main'))
        ├── canvas_chunks   SQLite BLOB rows × 256 (64 KB each = 16 MB)
        ├── cooldowns       SQLite TTL rows (1s rate-limit, lazy GC)
        └── WebSocket hub   Hibernation API broadcasts pixel deltas
```

`CHUNK_COUNT = ceil(CANVAS_WIDTH × CANVAS_HEIGHT / CHUNK_BYTES)` — bumping
canvas dimensions in `src/lib/constants.js` and redeploying lazy-allocates new
chunks on first read. See [`docs/canvas-resize-procedure.md`](docs/canvas-resize-procedure.md).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/) (free tier works — Workers Free + DO SQLite Free)

### Setup

```bash
git clone <repo-url>
cd rplace
npm install
```

No external storage to configure. The canvas and rate-limit state live inside
the Durable Object.

### Development

```bash
# Run worker locally (serves API + static frontend)
npm run dev

# Or split frontend + worker
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
├── worker.js                          # Hono entry — thin proxy + edge validation
├── admin/
│   └── migrate-from-upstash.js        # One-shot Upstash → DO importer (token-gated)
├── durable-objects/
│   ├── canvas-room.js                 # DO: storage + cooldown + WS hub
│   └── lib/
│       ├── schema.js                  # Idempotent CREATE TABLE
│       ├── chunk-storage.js           # BLOB chunk read/write/import
│       └── cooldown-store.js          # Rate-limit acquire + lazy GC
├── lib/
│   ├── constants.js                   # CANVAS_WIDTH/HEIGHT, CHUNK_BYTES, palette
│   ├── canvas-decoder.js              # Raw bytes → RGBA (client-side)
│   ├── canvas-storage.js              # Legacy Upstash reader (used by migration only)
│   ├── redis-client.js                # Legacy Upstash REST helpers (migration only)
│   ├── rate-limiter.js                # Legacy Upstash cooldown (orphaned, awaits removal)
│   ├── image-uploader.js              # Browser-side batched uploader
│   └── get-user-id.js                 # IP-based identity
├── client/
│   ├── main.js                        # Svelte mount
│   ├── App.svelte                     # Root + WebSocket
│   ├── app.css                        # Global styles
│   └── components/
│       ├── CanvasRenderer.svelte      # Canvas + zoom/pan + touch
│       ├── ColorPicker.svelte         # Favorites + 256-color grid + custom picker
│       ├── CanvasControls.svelte      # Zoom buttons + coordinates
│       ├── DrawToolbar.svelte         # Paint / submit / undo / redo
│       └── ImageImporter.svelte       # Image-to-canvas uploader
└── index.html                         # Vite entry
```

## API

### `GET /api/canvas`

Returns the full canvas as raw binary (1 byte per pixel, 16 MB — Cloudflare gzips it on the edge). Cached for 10s at the edge.

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

### `POST /admin/migrate-from-upstash` (transitional)

Token-gated one-shot endpoint that pulls the canvas from a legacy Upstash
Redis instance and imports it into the Durable Object. Slated for removal
after the production migration completes (Phase 4 of
[`plans/260509-2309-canvas-on-do-storage`](plans/260509-2309-canvas-on-do-storage)).

## Configuration

Key constants in `src/lib/constants.js`:

| Constant | Default | Description |
|---|---|---|
| `CANVAS_WIDTH` | 4096 | Canvas width in pixels |
| `CANVAS_HEIGHT` | 4096 | Canvas height in pixels |
| `MAX_COLORS` | 256 | Number of palette entries |
| `MAX_BATCH_SIZE` | 2048 | Max pixels per placement request |
| `REQUEST_COOLDOWN_SEC` | 1 | Minimum seconds between requests per user |
| `CHUNK_BYTES` | 65536 | Bytes per SQLite BLOB chunk (must stay ≤ 2 MB CF DO row cap) |
| `CHUNK_COUNT` | derived | `ceil(TOTAL_PIXELS / CHUNK_BYTES)` — auto-recomputed on resize |

## Credits & References

- [Reddit on Building & Scaling r/place (Fastly)](https://www.fastly.com/blog/reddit-on-building-scaling-rplace)
- [Engineering Behind r/place (Sai Kumar Chintada)](https://saikumarchintada.medium.com/engineering-behind-r-place-a7eb53bcf5f1)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [reddit-plugin-place-opensource](https://github.com/reddit-archive/reddit-plugin-place-opensource)
- [rPlace by anthonytedja](https://github.com/anthonytedja/rPlace)
- [rplace.live](https://rplace.live/) — original 32-color palette reference (since superseded by our 256-color HSL wheel)

## License

MIT
