---
phase: 7
title: "Polish & Deploy"
status: pending
effort: 2.5h
priority: P2
blocked_by: [6]
---

# Phase 7 — Polish & Deploy

## Overview
Production hardening: Vercel deployment config, Upstash Redis provisioning, environment setup, performance optimization, error handling polish, and documentation.

## Implementation Steps

1. **Vercel Configuration**
   - Create `vercel.json` if needed (usually not required for Next.js)
   - Set Edge Runtime for SSE route
   - Configure function regions (closest to Upstash Redis region)
   - Set environment variables in Vercel dashboard

2. **Upstash Redis Setup**
   - Create Upstash database (choose region matching Vercel)
   - Enable eviction policy: noeviction (canvas data must persist)
   - Set maxmemory appropriately (canvas = ~3MB + credit hashes + update queue)
   - Copy REST URL and token to Vercel env vars

3. **Performance Optimization**
   - Canvas API: verify gzip compression working (check Content-Encoding header)
   - Add `Cache-Control` headers: canvas GET (short TTL), stream (no-cache)
   - Consider canvas snapshot caching at edge (Vercel Edge Config or KV)
   - Lazy load non-critical UI components
   - Optimize binary decoder: use DataView for efficient 5-bit reads

4. **Error Handling Polish**
   - Global error boundary for React components
   - API routes: consistent error response format `{ error: string, code?: string }`
   - SSE: graceful reconnection with exponential backoff (EventSource default)
   - Canvas load failure: retry with backoff, show user-friendly error
   - Redis connection failure: 503 response with retry header

5. **Canvas Initialization**
   - Admin/setup script to initialize empty canvas in Redis
   - Or: auto-initialize on first GET request if key missing
   - Add `GET /api/canvas/info` endpoint: returns canvas dimensions, total pixels placed, etc.

6. **Meta & SEO**
   - Open Graph tags
   - Favicon
   - Page title and description
   - Mobile viewport meta

7. **Documentation**
   - Update README.md with:
     - Project description
     - Setup instructions (local dev + Vercel deploy)
     - Environment variables reference
     - Architecture overview
   - Update docs/ directory per documentation management rules

## Todo List

- [ ] Configure Vercel deployment settings
- [ ] Provision Upstash Redis database
- [ ] Set all environment variables
- [ ] Add error boundaries and consistent error responses
- [ ] Add canvas initialization logic
- [ ] Optimize gzip and caching headers
- [ ] Add meta tags and favicon
- [ ] Update README with setup instructions
- [ ] Update docs/ (architecture, code standards)
- [ ] Deploy to Vercel and smoke test
- [ ] Test full flow: load canvas → place pixels → see real-time updates
- [ ] Test OAuth flows in production

## Success Criteria
- App deployed to Vercel and accessible via URL
- Canvas loads within 3 seconds on broadband
- Pixel placement works end-to-end in production
- SSE updates work in production
- OAuth works with production callback URLs
- No console errors in production build
- Redis memory usage is predictable and bounded

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vercel Edge Runtime SSE timeout | High | Med | Document 30s limit; client reconnects automatically |
| Upstash free tier limits (10K commands/day) | Med | High | Monitor usage; upgrade plan if needed; batch reads |
| Cold start latency | Med | Low | Edge Runtime eliminates cold starts for SSE; serverless routes accept ~200ms |

## Rollback
Vercel supports instant rollback to previous deployment. Redis data persists independently. Rollback = redeploy previous commit.
