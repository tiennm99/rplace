---
phase: 4
title: "Cleanup & Dependency Removal"
status: pending
priority: P2
effort: "2h"
dependencies: [3]
---

# Phase 4: Cleanup & Dependency Removal

## Overview

After successful migration, delete all Upstash code paths, drop the `@upstash/redis` and `ioredis` dependencies, remove the migration endpoint, and rewrite the test suite to target DO storage.

## Requirements

**Functional:**
- Zero Upstash references in `src/`.
- `package.json` no longer depends on `@upstash/redis` or `ioredis`.
- `wrangler.json` and `.env` no longer reference Upstash secrets.
- `MIGRATION_TOKEN` secret deleted.
- All tests pass against DO storage (no testcontainers Redis).

**Non-functional:**
- No dead code left behind.
- `npm run dev` works without `UPSTASH_REDIS_*` env vars set.

## Architecture

### Files going away

```
src/lib/canvas-storage.js              ← already orphaned by Phase 2
src/lib/legacy-upstash-storage.js      ← created in Phase 3, now removed
src/lib/redis-client.js
src/lib/rate-limiter.js
src/admin/migrate.js
src/durable-objects/lib/migration-import.js
test/...                                ← any testcontainers Redis tests
vitest.integration.config.js           ← if it only existed for Redis
```

### Test rewrite

Replace `testcontainers` Redis fixtures with Wrangler `unstable_dev` or Vitest `@cloudflare/vitest-pool-workers`.

```js
// test/integration/canvas-do.test.js
import { unstable_dev } from 'wrangler';

let worker;
beforeAll(async () => {
  worker = await unstable_dev('src/worker.js', { local: true, persist: false });
});
afterAll(() => worker?.stop());

test('place pixel persists across reads', async () => {
  await worker.fetch('/api/place', { method:'POST', body: JSON.stringify({pixels:[{x:10,y:20,color:5}]}) });
  const res = await worker.fetch('/api/canvas');
  const buf = new Uint8Array(await res.arrayBuffer());
  expect(buf[20 * CANVAS_WIDTH + 10]).toBe(5);
});
```

## Related Code Files

**Delete:**
- `src/lib/canvas-storage.js`
- `src/lib/legacy-upstash-storage.js`
- `src/lib/redis-client.js`
- `src/lib/rate-limiter.js`
- `src/admin/migrate.js`
- `src/durable-objects/lib/migration-import.js`
- Any test file that imports from above

**Modify:**
- `package.json` — remove `@upstash/redis`, `ioredis`, `testcontainers` (if only used for Redis)
- `package-lock.json` — regenerate via `npm install`
- `wrangler.json` — remove any Upstash env var references
- `vitest.config.js` / `vitest.integration.config.js` — drop Redis-specific setup
- `src/worker.js` — remove `/admin/*` mount

**Create:**
- `test/integration/canvas-do.test.js` — replaces `testcontainers` Redis tests
- `test/integration/cooldown-do.test.js` — rate-limit semantics against DO

## Implementation Steps

1. Verify Phase 3 production migration successful and ≥7 days have passed (rollback window).
2. Delete the file list above.
3. `npm uninstall @upstash/redis ioredis testcontainers`.
4. Search-and-destroy: `grep -r -i "upstash\|redis\|cooldown:.*ttl" src/ test/` — must return zero hits.
5. Rewrite tests:
   - `test/integration/canvas-do.test.js` — pixel placement, batch, validation, full canvas read.
   - `test/integration/cooldown-do.test.js` — rate-limit window, retry-after value.
   - Delete `vitest.integration.config.js` if no longer needed (or simplify).
6. Run `npm run test:all` — all green.
7. Run `npm run dev` — verify no Upstash env-var errors at startup.
8. `wrangler secret delete UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` and `MIGRATION_TOKEN` in production.
9. Update `.env.example` — remove Upstash entries, leave only `MIGRATION_TOKEN` placeholder commented as historical (or delete entirely).

## Success Criteria

- [ ] `grep -r -i "upstash" src/ test/` returns no matches
- [ ] `grep -r "redis" src/ test/` returns no matches (case-insensitive)
- [ ] `package.json` has no `@upstash/redis`, `ioredis`
- [ ] `npm run test:all` green
- [ ] `npm run dev` starts without Upstash env vars set
- [ ] Production secrets deleted
- [ ] `.env.example` clean

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Premature deletion before migration verified | Wait 7 days post-Phase-3 deploy before this phase |
| Test rewrite drops coverage | Match test cases 1:1 with deleted Upstash tests; review diff |
| Forgotten Upstash reference somewhere | Final grep across full repo, not just src/ |
| Wrangler `unstable_dev` API changes | Pin wrangler version in `devDependencies`; document in README |
