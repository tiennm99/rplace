# Hosting Platform Comparison: Vercel vs Netlify vs Cloudflare for r/place Clone

**Date:** 2026-04-16  
**Scope:** Real-time collaborative pixel canvas (r/place clone) with Next.js, Upstash Redis, SSE, and potential viral traffic spikes.

---

## Comparison Matrix

| Criterion | Vercel Hobby | Netlify Free | Cloudflare Workers Free |
|-----------|--------------|--------------|-------------------------|
| **Free Tier Invocations/Month** | 1M | 125k | 3M (100k/day) |
| **Function Timeout** | 10s (60s with config) | 10s (26s on Pro) | 10ms CPU per request |
| **SSE/Streaming Support** | ✅ 60s (serverless) / 300s (edge) | ✅ 20 MB payload | ✅ 30s per WebSocket msg |
| **WebSocket Support** | ❌ No | ❌ No | ✅ Yes (Durable Objects) |
| **Cold Start Latency** | ~1s | 3+ seconds | <5ms (V8 isolates) |
| **Bandwidth Included** | 100GB | 100GB | Unlimited |
| **SSE Max Duration** | 60s base, 300s with Edge | 10s (26s Pro) | No limit (WebSocket) |
| **Concurrent Connections** | Framework-limited | High | 6 simultaneous fetches |
| **Upstash Redis** | ✅ REST API | ✅ REST API | ✅ REST API + native SDK |
| **Edge Runtime** | ✅ (300s) | ❌ Via Edge Functions | ✅ (V8 isolate, default) |
| **Durable Objects / Stateful** | ❌ | ❌ | ✅ (SQLite-backed on free) |
| **Cost at 10M Req/Month** | ~$6 (1M free) | $2/100k invocations | $0.30/M (sub-$5) |

---

## Free Tier Breakdown

### Vercel Hobby
- **Invocations:** 1M/month, 100 deployments/day
- **Bandwidth:** 100GB included
- **SSE Support:** Serverless (10s default, 60s configurable) or Edge Functions (25s to first byte, then 300s total)
- **Pain Point:** Timeout too short for long-lived SSE without upgrade. WebSocket not supported.
- **Recommendation:** Viable only with aggressive client-side batching or Edge Functions.

### Netlify Free
- **Invocations:** 125k/month
- **Bandwidth:** 100GB included
- **SSE Support:** 10s timeout by default, extendable to 26s on Pro
- **Edge Functions:** 50ms CPU time (idle time doesn't count, better for SSE)
- **Pain Point:** Lowest free invocation quota; shared 50MB memory default
- **Recommendation:** Weakest choice for real-time pixel canvas due to invocation limits and timeout constraints.

### Cloudflare Workers Free
- **Requests:** 100k/day (3M/month), unlimited after paid
- **CPU Time:** 10ms per request (idle time excluded for WebSocket)
- **WebSocket Support:** Native via Durable Objects; 32 MiB message size
- **Durable Objects:** 5 GB free storage (SQLite-backed)
- **Cold Starts:** <5ms globally
- **Pain Point:** 6 concurrent fetch limit; eventually-consistent KV; 1 write/sec/key limit
- **Recommendation:** Best architectural fit for real-time apps; native WebSocket preferred over SSE.

---

## SSE vs WebSocket: Technical Tradeoffs

**SSE (Vercel, Netlify):**
- Simpler to implement (HTTP-based)
- Max duration: 60–300s depending on platform
- Client reconnection logic required on timeout
- ~3–5KB overhead per connection
- Scaling: 2.5MB canvas = ~833 concurrent viewers at 3KB/sec

**WebSocket (Cloudflare):**
- Bi-directional communication (publish-subscribe patterns)
- No timeout; runs until connection closed
- Lower per-message overhead (~200 bytes)
- Durable Objects provide room-scoped state (excellent for isolated pixel groups)
- Scaling: Single Durable Object handles ~50–100 WebSocket connections

**Recommendation for r/place:** WebSocket + Durable Objects (Cloudflare) is architecturally superior. Eliminates timeout pain, enables efficient room-based scaling, and handles viral traffic spikes better.

---

## Redis vs Alternatives

### Upstash Redis (BITFIELD)
- **All platforms:** Compatible via REST API
- **Performance:** Handles BITFIELD operations (critical for pixel state as bitmaps)
- **Latency:** ~50–100ms globally
- **r/place fit:** Essential for efficient canvas storage (1M pixels = 125KB bitfield)
- **Cost:** Free tier (10k commands), then $0.0001/command

### Cloudflare Workers KV (Alternative)
- **Write Limit:** 1 write/sec/key (dealbreaker for high-frequency updates)
- **No BITFIELD:** Cannot efficiently store pixel bitmaps
- **Eventual Consistency:** Unacceptable for pixel canvas state
- **Verdict:** Not suitable; stick with Upstash Redis

---

## Adoption Risk & Maturity

**Vercel (Lowest Risk)**
- De facto Next.js standard
- Excellent DX, tight framework integration
- Proven at scale (millions of sites)
- **Risk:** SSE timeout constraints; may need Edge Functions workaround for long streams

**Netlify (Medium Risk)**
- Mature platform but slower cold starts
- Free tier invocation quota is limiting for real-time workloads
- **Risk:** Function timeout + low quota = poor scaling for spikes

**Cloudflare Workers (Low Risk, High Reward)**
- Production-ready; powers millions of requests
- OpenNext adapter (1.0-beta) adds Next.js 14/15/16 support
- **Risk:** OpenNext is newer than @vercel/next; Node.js runtime adds ~50ms overhead vs V8 isolates. Adoption of Durable Objects is lower than serverless.

---

## Scaling to Viral Traffic

**Scenario:** r/place unexpectedly spikes from 100 users to 100k users in 1 hour.

| Platform | Behavior | Cost Impact |
|----------|----------|------------|
| **Vercel** | Scales function invocations; may hit free tier quota ($6 overage) | Moderate |
| **Netlify** | Hits 125k invocation cap within minutes; service degradation | Severe (quota suspension) |
| **Cloudflare** | Handles surge gracefully at $0.30/M cost | Minimal ($30 for 100M req) |

**Winner:** Cloudflare. Auto-scaling, low marginal cost, no quota walls.

---

## Next.js App Router on Cloudflare

**OpenNext Cloudflare Adapter (1.0-beta)**
- ✅ Supports Next.js 14, 15, 16
- ✅ App Router fully supported
- ✅ Incremental Static Regeneration (ISR) works
- ❌ Node.js runtime (slower than V8 isolates by ~50ms)
- ⚠️ Beta status; breaking changes possible

**Setup:** `npm install -D @opennextjs/cloudflare` + `wrangler.toml` configuration.

**Gotcha:** SSE doesn't natively work in serverless. Use **Durable Objects WebSocket** instead for real-time updates.

---

## Deployment DX

| Platform | Preview Deploys | Git Integration | Local Dev | CI/CD |
|----------|-----------------|-----------------|-----------|-------|
| **Vercel** | Instant per PR | Native; auto-deploy | `vercel dev` | First-class |
| **Netlify** | Instant per PR | Native; auto-deploy | `netlify dev` | Good |
| **Cloudflare** | Via `wrangler publish` | Requires setup | `wrangler dev` | Requires scripts |

**DX Winner:** Vercel (tightest Next.js integration), but Cloudflare's `wrangler` is improving rapidly.

---

## Recommendation

### For Hobby/MVP (Simplicity First)
**Vercel Hobby** — Start here. Easy Next.js deployment, sufficient free tier for initial testing. **Accept:** SSE timeout constraints; use client-side reconnection logic or split long streams.

### For Scale-Ready Production (Real-Time First)
**Cloudflare Workers + Durable Objects** — Best architecture for r/place:
- ✅ Native WebSocket support (no timeout)
- ✅ Durable Objects for room-based pixel groups
- ✅ Sub-5ms cold starts
- ✅ Scales to viral traffic at <$30/month
- ✅ Upstash Redis compatibility (REST API)
- ⚠️ Requires OpenNext adapter (beta); monitor releases

**Hybrid Approach (Safe):**  
Deploy on **Vercel** initially. When traffic patterns stabilize and WebSocket needs are confirmed, migrate API layer to **Cloudflare Workers** while keeping Next.js frontend on Vercel (edge functions for canvas downloads, Workers for real-time WebSocket).

---

## Unresolved Questions

1. **Durable Objects namespace limits:** How many rooms (pixel groups) can a single namespace handle before rate-limiting?
2. **OpenNext adapter stability:** Expected timeline for 1.0 release; any known breaking changes between beta and GA?
3. **Upstash Redis + Durable Objects:** Can Durable Objects efficiently call Upstash REST API, or should canvas state be mirrored in both KV and Redis?
4. **Client payload size:** 2.5MB canvas download on initial load—confirmed acceptable on mobile?

---

## Sources

- [Vercel Limits Documentation](https://vercel.com/docs/limits)
- [Vercel Functions Limitations](https://vercel.com/docs/functions/limitations)
- [Vercel Edge Functions Streaming](https://vercel.com/blog/streaming-for-serverless-node-js-and-edge-runtimes-with-vercel-functions)
- [Netlify Pricing](https://www.netlify.com/pricing/)
- [Netlify Functions Overview](https://docs.netlify.com/build/functions/overview/)
- [Netlify SSE Support](https://edge-functions-examples.netlify.app/example/server-sent-events)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [OpenNext Cloudflare Adapter](https://opennext.js.org/cloudflare)
- [Deploying Next.js with OpenNext on Cloudflare](https://blog.cloudflare.com/deploying-nextjs-apps-to-cloudflare-workers-with-the-opennext-adapter/)
- [Upstash Redis Compatibility](https://upstash.com/docs/redis/sdks/ts/deployment)
- [Upstash + Cloudflare Workers Integration](https://upstash.com/blog/cloudflare-upstash-integration)
- [Cloudflare KV vs Redis Benchmark](https://upstash.com/blog/edgecaching-benchmark)
- [Cloudflare Workers vs Vercel Cold Start Comparison](https://dev.to/dataformathub/cloudflare-vs-vercel-vs-netlify-the-truth-about-edge-performance-2026-50h0)
- [Cloudflare Workers WebSocket Documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
