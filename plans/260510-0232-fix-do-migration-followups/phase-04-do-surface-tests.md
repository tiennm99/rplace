---
phase: 4
title: "Full DO surface test coverage"
status: completed
priority: P2
effort: "6h"
dependencies: [1, 2, 3]
---

# Phase 4: Full DO Surface Test Coverage

## Overview
Close the test gap: today only `test/worker-validation.test.js` exists. The DO surface (chunk-storage, cooldown-store, WS hub, identity resolution) has zero unit tests. Add a vitest harness that runs against `wrangler unstable_dev` so DO state is real, not mocked.

## Context Links
- Reports: `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md` (positive observations re tests; gap implicit)
- Reports: `plans/reports/debugger-260510-0211-rplace-edge-cases.md` (L7 — explicit DO test gap)

## Key Insights
- Mocked DO unit tests (current style) won't catch the bugs Phase 1–3 fix. Need real DO state.
- `wrangler unstable_dev` lets vitest hit a live local Worker + DO via fetch. Heavier but accurate.
- For pure-function modules (`pixel-buffer`, `chunk-storage` math), keep classic vitest unit tests — fast loop.
- The 200-line file rule applies to test files too; split per concern (one test file per source file).

## Requirements

**Functional**
- Tests cover: write atomicity, BLOB-grow, orphan-row read, cooldown refund, cooldown TTL, WS broadcast frame format with `seq`, WS per-identity cap, ping/pong, identity cookie/IP/dev fallback, gap detection.
- All tests pass on `npm test`.

**Non-functional**
- Total test runtime under 30s on a dev machine.
- No hard-coded sleeps > 100ms; use polling helpers where needed.
- Tests are deterministic — no flakes when run 10× consecutively.

## Architecture

```
test/
├── lib/
│   ├── cookie.test.js                 # NEW — parseCookie/formatSetCookie
│   ├── get-user-id.test.js            # EXTEND — cookie/ip/dev fallback paths
│   ├── pixel-buffer.test.js           # EXISTING — keep
│   └── ... (existing image-* tests stay)
├── durable-objects/
│   ├── chunk-storage.test.js          # NEW — pure-function unit tests via mocked sql
│   ├── cooldown-store.test.js         # NEW — TTL math, GC sample, race
│   └── canvas-room.integration.test.js # NEW — wrangler unstable_dev
├── worker-validation.test.js          # EXISTING — keep
└── helpers/
    └── do-harness.js                  # NEW — boot wrangler unstable_dev once per file
```

`do-harness.js` exports `setupDO()` returning `{ worker, fetch, close }`. Suite uses `beforeAll` / `afterAll` to share the harness.

## Related Code Files

**Create**
- `test/helpers/do-harness.js`
- `test/lib/cookie.test.js`
- `test/durable-objects/chunk-storage.test.js`
- `test/durable-objects/cooldown-store.test.js`
- `test/durable-objects/canvas-room.integration.test.js`

**Modify**
- `test/lib/get-user-id.test.js` — extend for new resolution logic
- `vitest.config.js` — add `testTimeout: 30_000`, include `test/durable-objects/**/*`
- `package.json` — no new deps; `wrangler` is already a devDependency

**Delete** — none

## Implementation Steps

### Pure-function tests

1. **`test/lib/cookie.test.js`**
   - `parseCookie('a=1; b=2')` → Map `{a:'1', b:'2'}`
   - `parseCookie('')` → empty Map
   - `parseCookie(undefined)` → empty Map
   - Malformed: `parseCookie('a; b=2')` → Map `{b:'2'}`
   - `formatSetCookie('rplace_id', 'uuid', { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 31536000, path: '/' })` → exact string match.

2. **`test/lib/get-user-id.test.js`** (extend)
   - Cookie present → `cookie:<uuid>`
   - No cookie, IP present → `ip:<hash>`
   - Production env, neither → throws `NoIdentityError`
   - Dev env, neither → `dev:*`
   - Cookie + IP both present → cookie wins
   - Cookie issuance flag set when caller should `Set-Cookie`

3. **`test/durable-objects/chunk-storage.test.js`** (mock sql)
   - Build a fake `sql` with an in-memory `Map<chunkId, Uint8Array>` backing `INSERT OR REPLACE` and `SELECT`.
   - `writePixels` single chunk: write 3 pixels, read back identical bytes.
   - `writePixels` 2-chunk batch: pixels at offset 0 and offset 65535+1, both persist.
   - `writePixels` BLOB-grow: pre-seed last chunk with a short blob (8KB), grow via fake `chunkSize` returning 64KB, write a pixel at byte 30000, read back exactly 64KB blob with byte 30000 set.
   - `readAllChunks` orphan: pre-seed `chunk_id = 999`, `CHUNK_COUNT = 256`, read returns valid `Uint8Array(TOTAL_PIXELS)` without throwing.
   - `chunkSize(255)` for current dims = 65536; `chunkSize(0..254)` = 65536.
   - Test the bound query: orphan row not selected.

4. **`test/durable-objects/cooldown-store.test.js`** (mock sql)
   - `tryAcquire(userId, now)` first call returns `{ ok: true }`.
   - Second call within 1s returns `{ ok: false, retryAfter: <ms remaining> }`.
   - Second call after 1s returns `{ ok: true }`.
   - GC sample with deterministic RNG: pre-seed expired rows, run `tryAcquire` with mocked `Math.random()` returning 0 (always GC) → expired rows deleted.
   - INSERT cursor symmetry: ensure both branches drain (after fix in Phase 1's M1).

### Integration tests (real DO)

5. **`test/helpers/do-harness.js`**
   - `import { unstable_dev } from 'wrangler'`
   - `export async function setupDO() { const worker = await unstable_dev('src/worker.js', { config: 'wrangler.json', experimental: { disableExperimentalWarning: true } }); return { worker, fetch: worker.fetch.bind(worker), close: () => worker.stop() }; }`
   - Add helper `placePixel(worker, { x, y, color, cookie? })` returning `{ status, body, setCookie }`.

6. **`test/durable-objects/canvas-room.integration.test.js`**
   - **Cookie issuance:** GET `/api/canvas` without cookie → response has `Set-Cookie: rplace_id=...`. Subsequent GET with cookie → no new Set-Cookie.
   - **Cooldown isolation:** two cookies, same simulated IP → both place pixels in the same second.
   - **Cooldown refund on error:** force a write error path (test-only env flag throws inside `writePixels`) → cooldown row deleted, second attempt succeeds immediately.
   - **Multi-chunk atomicity:** force-error mid-batch on second chunk → `GET /api/canvas` shows none of the batch applied, broadcast not fired.
   - **Orphan row:** seed orphan via DO debug endpoint (test-only) → `GET /api/canvas` returns 200.
   - **content-length=0 rejected:** POST `/api/place` with `Content-Length: 0` → 411 or 413.
   - **WS broadcast carries seq:** open WS, place a pixel, receive frame with `{ type:'pixels', seq:1, edits:[...] }`. Place another → `seq:2`.
   - **WS per-identity cap:** open 5 WS with same cookie → all accepted. 6th → 429 / connection-close.
   - **WS ping/pong:** send `'ping'`, receive `'pong'`.
   - **WS gap → client refetch:** simulate dropped frame by manually skipping a `seq`; client-side gap detection is a unit-test concern (covered in `test/lib/seq-gap.test.js` if extracted; otherwise verify protocol shape only).
   - **Origin allowlist:** WS upgrade with `Origin: https://evil.example` → 403; with no Origin → allowed.

## Todo List

- [ ] Decide test-only env flag mechanism (e.g., `env.TEST_FORCE_WRITE_ERROR === '1'`) and add gated branches
- [ ] Write `test/helpers/do-harness.js`
- [ ] Write `test/lib/cookie.test.js`
- [ ] Extend `test/lib/get-user-id.test.js`
- [ ] Write `test/durable-objects/chunk-storage.test.js`
- [ ] Write `test/durable-objects/cooldown-store.test.js`
- [ ] Write `test/durable-objects/canvas-room.integration.test.js`
- [ ] Update `vitest.config.js` (timeout + include patterns)
- [ ] `npm test` — all green
- [ ] Run 10× back-to-back; no flakes

## Success Criteria

- [ ] All Phase 1–3 fixes have at least one test that fails on the pre-fix code and passes after.
- [ ] Coverage report shows DO source files at ≥ 80% line coverage.
- [ ] Total test runtime under 30s on dev hardware.
- [ ] CI (if configured) passes; otherwise local 10× green.

## Risk Assessment

- **Risk:** `wrangler unstable_dev` is not stable across versions; tests may break on upgrade.
  **Mitigation:** Pin `wrangler` version in `package.json` (already pinned to `^4.14.1`); update tests when intentionally bumping.
- **Risk:** Test-only env flags leak into production.
  **Mitigation:** Gate behind `env.NODE_ENV === 'test'` AND require an explicit `env.TEST_HOOKS === 'enabled'` second flag. Document; reject in deploy script.
- **Risk:** Integration tests slow down dev loop, devs skip them.
  **Mitigation:** Add `npm run test:unit` (excludes `**/integration.*`) for fast inner loop.
- **Risk:** WS testing in vitest is awkward (`unstable_dev` returns Worker, not Server).
  **Mitigation:** Use `worker.fetch` for upgrade and treat the returned `WebSocket` directly. If tooling doesn't allow that, fall back to spawning `wrangler dev` in a child process.

## Security Considerations

- Test-only hooks must never ship to production. Add a build-time assertion (e.g., a fail-fast check at worker startup if `TEST_HOOKS` is enabled in production env).
- Tests must not commit any secrets — use `crypto.randomUUID()` for ephemeral test cookies.
