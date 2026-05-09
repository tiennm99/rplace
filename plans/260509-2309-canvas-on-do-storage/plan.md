---
title: "Migrate canvas storage from Upstash to Durable Object SQLite"
status: in-progress
priority: P2
created: 2026-05-09
phases: 5
source: brainstorm
brainstorm: ../reports/brainstorm-260509-2309-canvas-on-do-storage.md
researchReports:
  - ../reports/researcher-260509-2255-forever-free-hosting.md
  - ../reports/researcher-260509-2246-vercel-migration-feasibility.md
---

# Plan: Migrate canvas storage from Upstash → Durable Object SQLite

## Goal

Eliminate Upstash Redis dependency. Move canvas (16 MB) and per-user cooldown state into the existing `CanvasRoom` Durable Object via its SQLite-backed storage. Keep $0/month forever, hobby-scale (50 concurrent / <1 placement/sec). Resize must be config-change-only.

## Context

- Brainstorm: `plans/reports/brainstorm-260509-2309-canvas-on-do-storage.md` (approved)
- Storage research: `plans/reports/researcher-260509-2255-forever-free-hosting.md`
- Migration feasibility: `plans/reports/researcher-260509-2246-vercel-migration-feasibility.md`

## Architecture (locked)

```
Browser ──HTTP/WS──▶ Worker (Hono, thin proxy)
                          │
                          └─▶ CanvasRoom DO (idFromName('main'))
                                ├── canvas_chunks (SQLite BLOB rows × CHUNK_COUNT)
                                ├── cooldowns      (user_id → expires_at, lazy GC)
                                └── WebSocket hibernation hub (broadcast)
```

Constants drive resize: `CHUNK_COUNT = ceil(CANVAS_WIDTH * CANVAS_HEIGHT / CHUNK_BYTES)`. Bump width/height → redeploy → DO lazy-inits missing chunks.

## Phases

| # | Phase | Status | Effort |
|---|---|---|---|
| 1 | [Storage Foundation](phase-01-storage-foundation.md) | completed | ~3h |
| 2 | [DO Integration & Worker Proxy](phase-02-do-integration-worker-proxy.md) | completed | ~4h |
| 3 | [One-Shot Upstash Migration](phase-03-one-shot-upstash-migration.md) | code-complete (awaits production run) | ~2h |
| 4 | [Cleanup & Dependency Removal](phase-04-cleanup-dependency-removal.md) | blocked (waits for Phase 3 prod migration + 7d) | ~2h |
| 5 | [Deploy & Documentation](phase-05-deploy-documentation.md) | partial (resize doc done; deploy + README await Phase 4) | ~1h |

**Total estimate:** ~12h (1.5 working days)
**Status:** Phases 1, 2, 3 (code) and 5 (resize doc) complete. Phase 3 prod run + Phase 4 cleanup are user-gated.

## Dependencies

Phase order is strict: 1 → 2 → 3 → 4 → 5. Each phase blocks the next.

## Success Criteria

- [ ] Zero `@upstash/redis` references in `src/`
- [ ] `package.json` no longer depends on `@upstash/redis` or `ioredis`
- [ ] `wrangler dev` runs locally without `UPSTASH_REDIS_*` env vars
- [ ] Existing pixels preserved through migration (verify a known coordinate)
- [ ] WS broadcast still functional end-to-end
- [ ] All tests pass (`npm run test:all`)
- [ ] Resize procedure documented in `docs/`
- [ ] Production deploy verified with smoke test
- [ ] $0 monthly bill confirmed after 7 days

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Workers req/day at 87% of cap on peak day | Med | Keep `s-maxage=10` cache on `/api/canvas`; monitor via CF dashboard |
| Test rewrite scope creep | Low | Time-box testcontainers→DO test rewrite to 4h; cut e2e if needed |
| Migration corrupts canvas | High | Keep Upstash data 7 days post-migration as rollback |
| DO single-region latency regression | Low | Same as today's Upstash (single region) — no change |
| Storage billing exposure if canvas grows | Med | Monitor; current 16 MB << 1 GB threshold |

## Rollback Plan

Phases 1–4 are reversible until Phase 5 deploy. Keep Upstash creds and old code paths in git history for 30 days. If post-deploy issues, `git revert` + redeploy.
