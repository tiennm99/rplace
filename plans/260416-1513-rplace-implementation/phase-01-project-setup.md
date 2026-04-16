---
phase: 1
title: "Project Setup"
status: pending
effort: 1.5h
priority: P1
---

# Phase 1 — Project Setup

## Context Links
- [Next.js App Router docs](https://nextjs.org/docs/app)
- [Upstash Redis SDK](https://github.com/upstash/upstash-redis)

## Overview
Initialize Next.js project with App Router, install dependencies, configure environment variables, and establish project structure with kebab-case naming.

## Requirements

### Functional
- Next.js App Router project scaffolded
- All dependencies installed
- Environment config for Upstash Redis + NextAuth
- Project directory structure established

### Non-functional
- JavaScript only (no TypeScript)
- Files under 200 lines
- kebab-case file naming

## Dependencies to Install

```
next react react-dom
@upstash/redis        # Redis client (REST-based, Vercel-friendly)
next-auth             # OAuth (Google, GitHub)
```

Dev dependencies:
```
eslint eslint-config-next
```

## Project Structure

```
src/
├── app/
│   ├── layout.js
│   ├── page.js
│   ├── api/
│   │   ├── canvas/
│   │   │   ├── route.js          # GET full canvas
│   │   │   ├── place/
│   │   │   │   └── route.js      # POST batch pixel placement
│   │   │   └── stream/
│   │   │       └── route.js      # GET SSE stream
│   │   └── auth/
│   │       └── [...nextauth]/
│   │           └── route.js      # NextAuth catch-all
│   ├── components/
│   │   ├── canvas-renderer.js    # HTML5 Canvas rendering
│   │   ├── color-picker.js       # 32-color palette UI
│   │   ├── canvas-controls.js    # Zoom/pan controls
│   │   └── user-info.js          # Auth status + cooldown display
│   └── globals.css
├── lib/
│   ├── redis-client.js           # Upstash Redis singleton
│   ├── canvas-storage.js         # BITFIELD read/write helpers
│   ├── rate-limiter.js           # Stackable credit system
│   ├── sse-broadcaster.js        # Pub/Sub → SSE bridge
│   ├── auth-options.js           # NextAuth config
│   └── constants.js              # Canvas size, colors, limits
└── .env.example
```

## Implementation Steps

1. Run `npx create-next-app@latest . --js --app --eslint --no-tailwind --no-src-dir --import-alias "@/*"` (adjust if src dir preferred — using `src/` per structure above, so add `--src-dir`)
2. Install production deps: `npm i @upstash/redis next-auth`
3. Create `.env.example` with required vars:
   ```
   UPSTASH_REDIS_REST_URL=
   UPSTASH_REDIS_REST_TOKEN=
   NEXTAUTH_URL=http://localhost:3000
   NEXTAUTH_SECRET=
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   GITHUB_CLIENT_ID=
   GITHUB_CLIENT_SECRET=
   ```
4. Create `src/lib/constants.js` with canvas config:
   ```js
   export const CANVAS_WIDTH = 2048;
   export const CANVAS_HEIGHT = 2048;
   export const BITS_PER_PIXEL = 5;
   export const MAX_COLORS = 32;
   export const MAX_BATCH_SIZE = 256;
   export const CREDIT_REGEN_RATE = 1; // per second
   export const MAX_CREDITS = 256;
   export const REDIS_CANVAS_KEY = 'canvas';
   export const REDIS_PUBSUB_CHANNEL = 'canvas:updates';
   export const COLORS = [
     '#6d001a','#be0039','#ff4500','#ffa800','#ffd635','#fff8b8',
     '#00a368','#00cc78','#7eed56','#00756f','#009eaa','#00ccc0',
     '#2450a4','#3690ea','#51e9f4','#493ac1','#6a5cff','#94b3ff',
     '#811e9f','#b44ac0','#e4abff','#de107f','#ff3881','#ff99aa',
     '#6d482f','#9c6926','#ffb470','#000000','#515252','#898d90',
     '#d4d7d9','#ffffff',
   ];
   ```
5. Create `src/lib/redis-client.js` — Upstash Redis singleton
6. Create stub files for remaining `lib/` and `api/` routes
7. Verify `npm run dev` starts without errors

## Todo List

- [ ] Scaffold Next.js project
- [ ] Install dependencies
- [ ] Create `.env.example`
- [ ] Create `constants.js` with palette and config
- [ ] Create `redis-client.js` singleton
- [ ] Create directory structure with stub files
- [ ] Verify dev server starts clean

## Success Criteria
- `npm run dev` runs without errors
- Project structure matches spec
- All stub files exist and export empty functions/components
- `.env.example` documents all required vars

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| create-next-app flags change | Low | Low | Check docs, adjust flags |
| Upstash SDK version mismatch | Low | Med | Pin version in package.json |

## Rollback
Delete generated files, re-scaffold. No data at risk.
