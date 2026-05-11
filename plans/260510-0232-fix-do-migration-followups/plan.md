---
title: "Fix critical bugs and security gaps from DO migration code review"
status: completed
priority: P1
created: 2026-05-10
completed: 2026-05-11
phases: 5
source: skill
sourceReports:
  - ../reports/code-reviewer-260510-0211-rplace-do-migration.md
  - ../reports/debugger-260510-0211-rplace-edge-cases.md
  - ../reports/docs-manager-260510-0211-rplace-docs-drift.md
blockedBy: []
blocks: []
---

# Plan: Fix DO Migration Code-Review Follow-ups

## Goal

Close the 3 Critical + 5 High findings from the post-migration triple-review (code-reviewer, debugger, docs-manager). Add full DO surface test coverage. Scrub stale Upstash references from `README.md` and `.env.example`.

## Decisions Locked (from validation Q&A)

- **Identity:** Cookie + IP fallback. Issue opaque per-browser cookie on first `/api/canvas`; rate-limit by cookie when present, fall back to IP otherwise.
- **Daily pixel cap:** Deferred to a follow-up plan (product input needed).
- **Test scope:** Full DO surface coverage (chunk-storage, cooldown-store, WS hub, get-user-id, integration).

## Phases

| # | File | Title | Status | Priority | Blocks |
|---|---|---|---|---|---|
| 1 | [phase-01-do-storage-atomicity.md](phase-01-do-storage-atomicity.md) | DO storage atomicity & correctness | completed | P1 | 4 |
| 2 | [phase-02-cookie-ip-identity.md](phase-02-cookie-ip-identity.md) | Cookie+IP identity & broadcast sequence | completed | P1 | 4 |
| 3 | [phase-03-ws-hardening-client-race.md](phase-03-ws-hardening-client-race.md) | WebSocket hardening & client race fix | completed | P1 | 4 |
| 4 | [phase-04-do-surface-tests.md](phase-04-do-surface-tests.md) | Full DO surface test coverage | completed | P2 | — |
| 5 | [phase-05-docs-cleanup.md](phase-05-docs-cleanup.md) | Docs cleanup & legacy plan archival | completed | P2 | — |

Phases 1, 2, 3 are independent and can ship in any order or in parallel. Phase 4 depends on the API surfaces stabilized in 1–3. Phase 5 is independent — can land first.

## Findings Coverage Map

| Phase | Critical | High | Medium |
|---|---|---|---|
| 1 | C2 (review C3 BLOB-grow), C2 (debugger atomicity), C1 (debugger cooldown burn) | review-H1, H2, H3, H5 | review-M1 |
| 2 | C3 (debugger NAT) | debugger-H2, H3 | review-M4 |
| 3 | C2 (review WS race) | review-H4, debugger-H5 | review-M2, M3, M7 |
| 4 | — | L7 test gap | — |
| 5 | C1 (review stale docs) | — | — |

## Out of Scope

- Per-IP daily pixel quota (deferred per Q&A).
- Edge-cache strategy change (`s-maxage` tuning) — needs product call on live-fresh vs cheap.
- Multi-room sharding (`idFromName('main')` stays single-DO).
- Signed cookie / HMAC identity — opaque cookie is sufficient for this round.

## Success Criteria

- All listed Critical + High findings resolved with file:line citations in PR description.
- `npm test` passes; new DO tests cover write atomicity, BLOB-grow, cooldown refund, WS hub, identity.
- README + `.env.example` purged of Upstash refs; docs/ verified accurate.
- Production deploy + 24h soak shows no new error class in CF logs.
- Migration plan `260509-2309-canvas-on-do-storage/plan.md` marked `status: completed`.

## Related Reports

- `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md`
- `plans/reports/debugger-260510-0211-rplace-edge-cases.md`
- `plans/reports/docs-manager-260510-0211-rplace-docs-drift.md`
