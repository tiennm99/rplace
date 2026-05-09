---
phase: 5
title: "Docs cleanup & legacy plan archival"
status: pending
priority: P2
effort: "30m"
dependencies: []
---

# Phase 5: Docs Cleanup & Legacy Plan Archival

## Overview
Strike stale Upstash references from `README.md` and `.env.example`. Verify the `docs/` directory matches current code (the docs-manager and code-reviewer reports disagree — verify file by file). Mark the migration plan as `completed` after the 7-day rollback observation window.

## Context Links
- Reports: `plans/reports/docs-manager-260510-0211-rplace-docs-drift.md` (primary)
- Reports: `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md` (C1 — claims docs/*.md still mention Upstash; conflicts with docs-manager finding)

## Key Insights
- Docs-manager said `docs/system-architecture.md`, `deployment-guide.md`, `code-standards.md` are accurate. Code-reviewer C1 said they still reference Upstash. Verify directly before deciding.
- Migration endpoint already removed from worker; documenting it as "transitional" misleads onboarding.
- `.env.example` placeholders for deleted services cause new-developer confusion.

## Requirements

**Functional**
- README's Project Structure block lists only files that exist in `src/`.
- README does not advertise `/admin/migrate-from-upstash` as transitional.
- `.env.example` either deleted or replaced with a comment explaining no external secrets.
- All `docs/*.md` files verified accurate; any Upstash references that describe current state (not history) removed.
- `plans/260509-2309-canvas-on-do-storage/plan.md` frontmatter `status: completed` (after 2026-05-17, the rollback window cutoff).

**Non-functional**
- Edits target only the lines in question; no unrelated reformatting.
- Git history preserves clear "docs:" commit type per `.claude` convention (drop `docs:` from `.claude/` paths only — not relevant here).

## Architecture
N/A — text edits.

## Related Code Files

**Modify**
- `README.md` — Project Structure tree (lines 79–111), API section (lines 146–151)
- `.env.example` — content
- `docs/system-architecture.md` — only if verification finds Upstash-as-current text
- `docs/deployment-guide.md` — only if verification finds Upstash-as-current text
- `docs/code-standards.md` — only if verification finds Upstash-as-current text
- `plans/260509-2309-canvas-on-do-storage/plan.md` — frontmatter `status` field (after rollback window)

**Create** — none

**Delete** — possibly `.env.example` (Option A in docs-manager report)

## Implementation Steps

1. **Verify docs/ accuracy**
   - `grep -ni 'upstash\|redis\|@upstash' docs/*.md`
   - For each match: read context, classify as (a) historical mention OK, (b) presented as current — needs edit.
   - Decide whether to keep migration narrative as historical or scrub entirely.

2. **README.md Project Structure** (docs-manager STALE finding 1)
   - Replace lines 79–111 with the corrected tree from docs-manager report (no `src/admin/`, no legacy lib files; include image pipeline files).
   - Use the actual `find src -type f` output as ground truth.

3. **README.md API Section** (docs-manager MISLEADING finding 2)
   - Delete the `### POST /admin/migrate-from-upstash (transitional)` block (lines 146–151).
   - Verify no other doc references this section.

4. **.env.example** (docs-manager STALE finding 3)
   - Choose Option B (keep as documentation): replace contents with a single comment block:
     ```
     # No external secrets required.
     # Canvas + cooldown state live inside CanvasRoom Durable Object (SQLite).
     # All configuration is in src/lib/constants.js.
     ```
   - Rationale: discoverability. New devs find `.env.example` and learn there's nothing to set.

5. **docs/ targeted edits** (only if step 1 found drift)
   - Edit each flagged section. Keep migration mentioned in `deployment-guide.md` "Optional One-Shot Migration from Upstash" as historical — do not delete the narrative if it's already framed as past.

6. **Migration plan archival** (docs-manager finding 4)
   - Today is 2026-05-10; rollback window per migration-plan ends ~2026-05-17.
   - Add a TODO note in this phase saying "after 2026-05-17, change `plans/260509-2309-canvas-on-do-storage/plan.md` frontmatter `status` to `completed`".
   - For now (before 2026-05-17), leave `status: in-progress` BUT add `deployment.cleanupAt: 2026-05-10` (already present per existing frontmatter) and verify it's accurate.

7. **Sanity sweep**
   - `grep -rni 'upstash\|@upstash\|redis-client\|rate-limiter\.js\|migrate-from-upstash' README.md docs/ .env.example src/` — should return only intentional historical refs.
   - `npm run build` — must still pass (sanity check that a doc edit didn't break a `<script src>` reference or similar).

## Todo List

- [ ] Run grep sweep on `docs/` for upstash/redis terms
- [ ] Classify each match (historical vs current-as-of-today)
- [ ] Edit README.md Project Structure tree
- [ ] Delete README.md `/admin/migrate-from-upstash` API section
- [ ] Rewrite `.env.example` with documentation comment
- [ ] Apply targeted edits in `docs/*.md` if step 1 found current-as-of-today refs
- [ ] Add reminder note (this phase) to flip migration plan status to `completed` after 2026-05-17
- [ ] Final grep sweep — no stale refs remain
- [ ] `npm run build` passes

## Success Criteria

- [ ] `find src -type f` matches the README Project Structure tree
- [ ] No `/admin/migrate-from-upstash` reference in `README.md`
- [ ] `.env.example` is documentation-only or absent
- [ ] `docs/*.md` accurately describes current code (no current-tense Upstash refs)
- [ ] Final grep sweep shows only intentional historical mentions

## Risk Assessment

- **Risk:** Editing docs accidentally drops useful historical context for future operators.
  **Mitigation:** Keep "Optional One-Shot Migration from Upstash" sections as past-tense narrative; only scrub anything that says "use this NOW".
- **Risk:** Premature archival of migration plan loses rollback information.
  **Mitigation:** Wait until 2026-05-17 (7-day window). Frontmatter already records `migratedAt` and `postCleanupVersionId` — those stay regardless of `status`.

## Security Considerations
N/A — docs only.

## Next Steps
None — this is the cleanup tail.
