# Deployment Guide

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier)
- Upstash Redis database (free tier)
- `wrangler` CLI (installed as dev dependency)

## Step 1: Create Upstash Redis Database

1. Go to [console.upstash.com](https://console.upstash.com/)
2. Create a new Redis database
3. Choose a region close to your users
4. Copy the **REST URL** and **REST Token**

## Step 2: Configure Secrets

```bash
# Set secrets in Cloudflare (not in code)
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

For local development, create `.dev.vars`:

```
UPSTASH_REDIS_REST_URL=https://your-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
```

## Step 3: Deploy

```bash
npm run deploy
```

This runs `vite build` (compiles Svelte → dist/) then `wrangler deploy` (uploads Worker + static assets).

## Step 4: Verify

1. Visit your Worker URL (e.g., `https://rplace.your-subdomain.workers.dev`)
2. Canvas should load (empty/dark on first visit)
3. Select a color, click to place a pixel
4. Open a second browser tab — pixel should appear via WebSocket

## Custom Domain

```bash
# Add a custom domain via Cloudflare dashboard or:
npx wrangler domains add rplace.yourdomain.com
```

## Monitoring

- **Cloudflare dashboard**: Worker analytics, request logs, DO metrics
- **Upstash console**: Redis command count, memory usage, latency

## Cost Estimates (Free Tier)

| Resource | Free Limit | rplace Usage |
|---|---|---|
| CF Workers | 100K requests/day | Canvas reads + pixel placements |
| CF Durable Objects | Free with Workers | WebSocket connections |
| Upstash Redis | 10K commands/day | BITFIELD reads/writes + cooldown SET NX EX |

For hobby traffic (< few hundred users/day), free tiers are sufficient. Upstash pay-as-you-go ($0.2/100K commands) is the first thing to hit limits.

## Troubleshooting

- **Canvas loads empty**: Check Upstash credentials in secrets
- **Pixels don't persist**: Verify BITFIELD support — test with `redis-cli BITFIELD canvas SET u5 #0 1`
- **WebSocket not connecting**: Ensure Durable Object migration ran (check `wrangler.json` migrations)
- **Rate limiting not working**: Verify `SET key value NX EX 1` returns `"OK"` / `null` as expected on your Upstash tier
