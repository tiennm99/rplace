---
title: "rplace — Reddit r/place Clone"
description: "Full implementation plan for a 2048x2048 collaborative pixel canvas with real-time updates"
status: pending
priority: P1
effort: 20h
branch: main
tags: [nextjs, redis, sse, canvas, real-time]
created: 2026-04-16
---

# rplace Implementation Plan

## Architecture

```
Browser (HTML5 Canvas + SSE client)
  |  GET /api/canvas         → full canvas binary (gzip)
  |  POST /api/canvas/place  → batch pixel placement (up to 256px)
  |  GET /api/canvas/stream  → SSE delta updates
  |  GET/POST /api/auth/*    → NextAuth.js routes
  v
Next.js App Router (Vercel serverless)
  |
  v
Upstash Redis
  ├── BITFIELD "canvas" (5-bit per pixel, 2048x2048 = 2.62MB)
  ├── HASH "credits:{id}" → {lastUpdate, credits}
  └── Pub/Sub channel "canvas:updates"
```

## Phases

| # | Phase | Status | Effort | File |
|---|-------|--------|--------|------|
| 1 | Project Setup | Pending | 1.5h | [phase-01](./phase-01-project-setup.md) |
| 2 | Canvas Backend | Pending | 3h | [phase-02](./phase-02-canvas-backend.md) |
| 3 | Rate Limiting | Pending | 2h | [phase-03](./phase-03-rate-limiting.md) |
| 4 | Real-time Updates | Pending | 3h | [phase-04](./phase-04-real-time-updates.md) |
| 5 | Frontend Canvas | Pending | 5h | [phase-05](./phase-05-frontend-canvas.md) |
| 6 | Authentication | Pending | 3h | [phase-06](./phase-06-authentication.md) |
| 7 | Polish & Deploy | Pending | 2.5h | [phase-07](./phase-07-polish-and-deploy.md) |

## Dependencies

```
Phase 1 (Setup)
  └─> Phase 2 (Canvas Backend)
        ├─> Phase 3 (Rate Limiting)
        └─> Phase 4 (Real-time)
              └─> Phase 5 (Frontend) ← also depends on Phase 2, 3
                    └─> Phase 6 (Auth)
                          └─> Phase 7 (Polish & Deploy)
```

## Key Decisions

- **JavaScript only** — no TypeScript (user preference)
- **SSE over WebSocket** — free on Vercel serverless, simpler
- **Redis BITFIELD** — 5-bit color encoding, single key for entire canvas
- **Stackable credits** — not fixed cooldown timer; allows batch placement
- **Anonymous-first** — IP-based identity, OAuth optional
