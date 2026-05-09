---
phase: 5
title: "Deploy & Documentation"
status: pending
priority: P3
effort: "1h"
dependencies: [4]
---

# Phase 5: Deploy & Documentation

## Overview

Production rollout of the cleaned-up codebase. Update architecture docs to reflect single-DO-with-storage. Document the resize procedure so future canvas growth is one constant change + redeploy.

## Requirements

**Functional:**
- Production deploy of post-Phase-4 code with WS broadcast verified.
- `docs/system-architecture.md` updated.
- New doc: `docs/canvas-resize-procedure.md`.
- README architecture diagram updated.

**Non-functional:**
- Smoke test under realistic load (manual: 2 browsers, 30 placements/min for 5 min).
- 7-day post-deploy observation: zero Upstash refs in logs, $0 bill confirmed.

## Architecture

Documentation updates only — no code change.

### Resize procedure (the headline doc)

```
1. Edit src/lib/constants.js:
     CANVAS_WIDTH  = <new>     // must be multiple of CHUNK_BYTES width factor
     CANVAS_HEIGHT = <new>
2. Verify new TOTAL_PIXELS / CHUNK_BYTES gives integer (or accept partial last chunk).
3. npm run build
4. npm run deploy
5. New chunks lazy-init on first read (zero-fill).
6. Existing pixels remain at original (x,y) coordinates; effective canvas just becomes larger.
```

**Caveat:** shrinking the canvas truncates pixels outside new bounds. They're still in SQLite (orphan rows) — clean up by manually `DELETE FROM canvas_chunks WHERE chunk_id >= NEW_CHUNK_COUNT` via DO admin endpoint if needed (out of scope).

## Related Code Files

**Modify:**
- `docs/system-architecture.md` — replace Upstash mentions with DO SQLite layout
- `README.md` — update Tech Stack table (drop Upstash row), update architecture ASCII diagram, update Setup section (remove Upstash steps)

**Create:**
- `docs/canvas-resize-procedure.md`

**Delete:** None.

## Implementation Steps

1. `npm run deploy` to production.
2. Manual smoke test:
   - Open 2 browser tabs.
   - Place a pixel in tab A → confirm appears in tab B within 1s (WS broadcast).
   - Refresh tab B → canvas reflects placed pixel (DO storage persistence).
   - Spam-place in tab A → confirm 429 after 1st in same second (rate limit).
3. Check Cloudflare dashboard:
   - Workers requests over past 24h within free tier.
   - DO storage size reported.
   - No errors in logs.
4. Update `README.md`:
   - Tech Stack table: replace `Upstash Redis` row with `Cloudflare DO (SQLite)`.
   - Architecture diagram: drop Upstash node, show DO contains canvas + cooldown.
   - Setup section: drop `wrangler secret put UPSTASH_REDIS_*` lines.
5. Update `docs/system-architecture.md` with new component diagram, DO storage schema, request flow.
6. Write `docs/canvas-resize-procedure.md` (~30 lines max, KISS).
7. Tag a release: `v2.0.0-do-storage` (breaking change in deployment requirements).
8. 7-day check: revisit dashboard, confirm $0 bill.

## Success Criteria

- [ ] Production deploy successful, smoke test passes
- [ ] Manual broadcast test green (2-tab placement)
- [ ] CF dashboard shows zero Upstash-related env vars
- [ ] README + system-architecture reflect new architecture
- [ ] `docs/canvas-resize-procedure.md` exists and is testable (someone can follow it)
- [ ] Release tagged `v2.0.0-do-storage`
- [ ] 7-day observation: $0 bill, no error spike

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Production WS regression unnoticed | Manual 2-tab test in smoke; consider scripted Playwright test in future |
| Docs drift from code over time | Resize procedure intentionally short and tied to constants file |
| Free tier breach after deploy under unexpected load | Existing `s-maxage=10` cache absorbs; CF dashboard alarm thresholds optional |
| Breaking change to deployment (no Upstash needed) | Major version bump (v2.0.0) signals it; release notes call it out |
