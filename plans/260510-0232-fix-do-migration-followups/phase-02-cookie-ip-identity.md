---
phase: 2
title: "Cookie+IP identity & broadcast sequence numbers"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 2: Cookie+IP Identity & Broadcast Sequence Numbers

## Overview
Replace IP-only rate-limit identity with cookie-preferred / IP-fallback to unblock NAT/CGNAT/mobile users. Add monotonically-increasing sequence numbers to WebSocket broadcast frames so clients can detect missed pixels and refetch.

## Context Links
- Reports: `plans/reports/debugger-260510-0211-rplace-edge-cases.md` (C3 NAT, H2 dev bucket, H3 hibernation gap)
- Reports: `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md` (M4 dev bucket)

## Key Insights
- Cookie identity isn't a security boundary — it's a usability fix to break NAT collisions. Trivially defeated by clearing cookies; that's acceptable scope.
- Broadcast sequence numbers don't require persistence: a per-DO instance counter works because reconnects after hibernation refetch the canvas anyway.
- `cf-connecting-ip` missing in production is an alarm condition, not a fallback path. Fail-closed in prod, soft-fall in dev.

## Requirements

**Functional**
- First request without `rplace_id` cookie: server issues `Set-Cookie: rplace_id=<uuid>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`.
- Subsequent requests with cookie: identity = `cookie:<uuid>`. Without cookie but with valid `cf-connecting-ip`: identity = `ip:<ip>`. Neither in prod: 500 with `{ error: "no_identity" }`. Neither in dev: identity = `dev:<random-per-process>`.
- WS broadcast frames carry monotonic `seq` field (uint32, wraps at 2^32).
- Client tracks last-seen `seq`; on gap (`seq != lastSeq + 1`) triggers `refetchCanvas()`.

**Non-functional**
- Cookie issuance adds zero latency (Set-Cookie on existing 200 response).
- No new dependencies.

## Architecture

```
src/lib/get-user-id.js
  resolveIdentity(request, env):
    if (cookie 'rplace_id' present) → "cookie:" + uuid
    else if (cf-connecting-ip present) → "ip:" + sha256(ip).slice(0,16)
    else if (env is production) → throw NoIdentityError → caller maps to 500
    else → "dev:<isolate-stable-uuid>"

  needsCookieIssue(request) → true if no rplace_id cookie

src/worker.js
  /api/canvas handler:
    if needsCookieIssue → response.headers.append('Set-Cookie', issueCookie(uuid))

src/durable-objects/canvas-room.js
  state #seq = 0  (in-memory, resets on hibernation rehydrate)
  broadcast(edits):
    #seq = (#seq + 1) >>> 0
    payload = { type: 'pixels', seq: #seq, edits }

src/client/App.svelte
  ws.onmessage:
    if (msg.seq != null) {
      if (lastSeq != null && msg.seq !== ((lastSeq + 1) >>> 0)) {
        refetchCanvas()  // gap detected
      }
      lastSeq = msg.seq
    }
```

## Related Code Files

**Modify**
- `src/lib/get-user-id.js` — cookie-first resolution + production fail-closed
- `src/worker.js` — issue cookie on `/api/canvas` when missing; pass identity into DO
- `src/durable-objects/canvas-room.js` — instance `#seq` counter; include in broadcast frames
- `src/client/App.svelte` — track `lastSeq`, refetch on gap
- `src/client/components/CanvasRenderer.svelte` — accept `seq`-aware events if needed (likely not)

**Create**
- `src/lib/cookie.js` — minimal helpers: `parseCookie(header)`, `formatSetCookie(name, value, opts)`. ~30 lines, kebab-case per code standards.

## Implementation Steps

1. **Cookie helpers** (`src/lib/cookie.js`)
   - `parseCookie(header) → Map<name, value>` — handle missing header, malformed pairs.
   - `formatSetCookie(name, value, { httpOnly, secure, sameSite, path, maxAge })` → string.
   - Export both as named exports.
   - Add tests in `test/lib/cookie.test.js` (Phase 4).

2. **Identity resolution rewrite** (`get-user-id.js`)
   - Import `parseCookie`.
   - `resolveIdentity(request, env)` returns `{ id, issueCookie?: { name, value } }`.
   - Production path: if no cookie AND no `cf-connecting-ip` → throw `NoIdentityError`.
   - Dev path: stable `dev:<uuid>` per-isolate (cache module-level).
   - When identity comes from `ip:`, mark `issueCookie = { name: 'rplace_id', value: crypto.randomUUID() }` so the worker can attach Set-Cookie even before the user has one.

3. **Worker integration** (`worker.js`)
   - On `/api/canvas` and `/api/place`: call `resolveIdentity(c.req.raw, c.env)`. If it throws `NoIdentityError`, return 500 `{ error: "no_identity" }`.
   - Pass `id` into the DO body / header.
   - On `/api/canvas` only: if `issueCookie` is set, append `Set-Cookie` header to the response.
   - On `/api/place`: don't issue cookies (POST shouldn't mutate cookies in this design).

4. **DO sequence counter** (`canvas-room.js`)
   - Add `#seq = 0` private field.
   - In `#broadcastPixels(edits)`: `this.#seq = (this.#seq + 1) >>> 0; const message = JSON.stringify({ type: 'pixels', seq: this.#seq, edits });`
   - Note: counter resets on DO hibernation rehydrate; that's fine — clients refetch on reconnect.

5. **Client gap detection** (`App.svelte`)
   - Track `let lastSeq = null;`.
   - In WS message handler: if `msg.seq != null && lastSeq != null && msg.seq !== ((lastSeq + 1) >>> 0)` → call `canvasRenderer.refetchCanvas()`. Always update `lastSeq = msg.seq`.
   - On reconnect: reset `lastSeq = null` (it's already a fresh canvas fetch).

6. **Compile + smoke**
   - `npm run build` passes.
   - Cookie issuance: open `wrangler dev`, GET `/api/canvas`, confirm `Set-Cookie` present. Subsequent request shows cookie.
   - Identity: 2 tabs, 1 cookie each → independent rate limits even on same IP.
   - Sequence gap: temporarily log `seq` on client; place pixel, confirm seq increments.

## Todo List

- [ ] Create `src/lib/cookie.js` (parseCookie + formatSetCookie)
- [ ] Refactor `src/lib/get-user-id.js` to cookie-first / IP-fallback / fail-closed
- [ ] Worker issues `Set-Cookie` on `/api/canvas` when missing
- [ ] Worker forwards resolved identity to DO
- [ ] DO maintains `#seq` counter; broadcast includes `seq`
- [ ] Client tracks `lastSeq`, refetches on gap
- [ ] Client resets `lastSeq` on reconnect
- [ ] `npm run build` passes
- [ ] Manual smoke: cookie issued, identity changes per cookie
- [ ] Manual smoke: seq gap → client refetches

## Success Criteria

- [ ] Two browsers on the same IP can place pixels independently within their own 1Hz cooldown.
- [ ] In production env (`env.ENVIRONMENT === 'production'`), missing both cookie and `cf-connecting-ip` returns 500 with `no_identity`.
- [ ] Forced WS gap (drop a frame in dev console) triggers `refetchCanvas`.
- [ ] No regression in existing tests.

## Risk Assessment

- **Risk:** Browser cookie blocking (private mode, strict tracker prevention) → falls back to IP, NAT users still collide.
  **Mitigation:** Acceptable per Q&A scope; document. Future plan can add HMAC-signed token for stricter envs.
- **Risk:** Cookie collision if two users share a stolen cookie value (e.g., copy-paste curl).
  **Mitigation:** Cookies are HttpOnly — not exfiltrable from JS. The opaque UUID is high-entropy.
- **Risk:** Seq counter wraparound after 2^32 broadcasts.
  **Mitigation:** ~136 years at 1 broadcast/sec. Wrap is deliberately handled via `>>> 0` so wrap doesn't trigger false gap.
- **Risk:** Production fail-closed behind a misconfigured proxy denies all traffic.
  **Mitigation:** Add a `wrangler tail` check before deploy; if 500s spike, hotfix to fall back to a synthetic identity.

## Security Considerations

- Cookie is `HttpOnly`, `Secure`, `SameSite=Lax` — standard hygiene.
- Cookie is opaque (UUID v4) — no PII, no prediction.
- Identity is used only for rate-limiting; no privilege gating, so cookie theft doesn't escalate.
- No CSRF concern — POST `/api/place` doesn't depend on cookie identity for authorization, only for rate-limit bucketing. (Worth confirming in PR review.)
