# Deployment Guide

## Prerequisites

- Node.js 18+
- Cloudflare account (Free plan is sufficient)
- `wrangler` CLI (installed as dev dependency)

No external storage to provision. Canvas pixels and rate-limit cooldowns
live inside the `CanvasRoom` Durable Object's SQLite-backed storage.

## Step 1: Deploy

```bash
npm install
npm run deploy
```

This runs `vite build` (compiles Svelte → `dist/`) then `wrangler deploy`
(uploads the Worker, static assets, and Durable Object class).

The first deploy applies the `wrangler.json` migration that registers
`CanvasRoom` as a SQLite-backed DO class.

## Step 2: Verify

1. Visit your Worker URL (e.g., `https://rplace.your-subdomain.workers.dev`).
2. Canvas should load (empty / black on first visit — palette index 0).
3. Select a color, click to place a pixel.
4. Open a second browser tab — pixel should appear via WebSocket.
5. `curl -I https://your-url/api/canvas` should report
   `cf-cache-status: HIT` after a couple of warm requests (10 s edge cache).

## (Optional) One-Shot Migration from Upstash

Only if you have an existing Upstash-backed deployment to import.

```bash
# 1. Set credentials for the legacy Upstash instance
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN

# 2. Generate and set a migration token
npx wrangler secret put MIGRATION_TOKEN
# Paste a random 32-byte hex value

# 3. Deploy
npm run deploy

# 4. Run the import once
curl -X POST -H "Authorization: Bearer $TOKEN" \
     https://your-worker.workers.dev/admin/migrate-from-upstash
# Expect: {"ok":true,"bytes_imported":16777216,"samples_checked":N,"mismatches":[]}

# 5. Verify in browser; wait 7 days as rollback safety
# 6. Run Phase 4 cleanup (see plans/260509-2309-canvas-on-do-storage)
```

After Phase 4 cleanup deletes the migration code, also delete the
secrets:
```bash
npx wrangler secret delete UPSTASH_REDIS_REST_URL
npx wrangler secret delete UPSTASH_REDIS_REST_TOKEN
npx wrangler secret delete MIGRATION_TOKEN
```

## Custom Domain

```bash
# Add a custom domain via Cloudflare dashboard or:
npx wrangler domains add rplace.yourdomain.com
```

## Monitoring

- **Cloudflare dashboard**:
  - Workers analytics — requests/day, errors, CPU time
  - Durable Object metrics — storage size, request rate
  - Cache analytics — `cf-cache-status` HIT ratio on `/api/canvas`

## Free-tier Footprint

| Resource | Free Cap (May 2026) | rplace at hobby scale |
|---|---|---|
| Workers requests | 100,000 / day | ~100 / day @ 50 users |
| DO storage / object | 10 GB | 16 MB canvas |
| DO storage / account | 5 GB | 16 MB total |
| BLOB row size | 2 MB | 64 KB chunks (32× under) |
| Per-DO request rate | 1,000 / s soft | ~1 / s |

Bandwidth is unlimited on Workers. With the 10 s edge cache on
`/api/canvas`, the dominant request driver is `/api/place` (1 per
placement). At 1-req-per-second-per-user rate-limit, 50 concurrent
users × 24h × 3600s = 4.3 M theoretical max — but realistic hobby
sessions stay well under 100K/day.

## Troubleshooting

- **Canvas loads empty**: expected on first deploy — DO `canvas_chunks`
  table is empty until pixels are placed (or migration runs).
- **WebSocket not connecting**: verify the wrangler migration applied
  via `wrangler tail` — should see no errors on DO instantiation.
- **`cf-cache-status` shows MISS**: edge caching may need an extra
  `caches.default.put` wrap if `Cache-Control` headers aren't honored
  through the worker → DO → response chain. Verify with two consecutive
  `curl -I` requests; second should HIT.
- **Migration import fails with `size_mismatch`**: the legacy Upstash
  data isn't 16 MB. Resize CHUNK constants or delete the partial Upstash
  data and start fresh.
- **`already_populated` from migration endpoint**: pass `?force=1` to
  overwrite. Use only when you're certain.
- **Storage billing meter ticking up**: per-account 5 GB free cap. A
  16 MB canvas is harmless; the worry only appears if you stand up many
  rooms or hit a runaway insert.
