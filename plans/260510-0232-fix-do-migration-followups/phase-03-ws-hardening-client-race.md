---
phase: 3
title: "WebSocket hardening & client race fix"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 3: WebSocket Hardening & Client Race Fix

## Overview
Fix the WebSocket-during-initial-fetch race that silently drops pixels. Add Origin allowlist + per-identity connection cap on WS upgrade. Add a minimal heartbeat so dead connections fire `onclose` promptly.

## Context Links
- Reports: `plans/reports/code-reviewer-260510-0211-rplace-do-migration.md` (C2 race, H4 conn cap, M3 heartbeat)
- Reports: `plans/reports/debugger-260510-0211-rplace-edge-cases.md` (H5 origin/amplification, L6 conn cap, M3 heartbeat — duplicate)

## Key Insights
- The pre-allocated `committedColors` zero array gets overwritten by the post-fetch `new Uint8Array(indices)` — any WS edits between WS-open and fetch-resolve are lost. Fix: buffer WS edits, replay after replacement.
- CF DO `state.acceptWebSocket(ws, [tag1, tag2])` lets `getWebSockets(tag)` filter — perfect for per-identity caps.
- Hibernation API may auto-ping at TCP level, but app-level heartbeat is cheaper insurance and gives clients a way to detect zombies.

## Requirements

**Functional**
- WS messages received during the initial canvas fetch are applied (not dropped) once the fetch resolves.
- WS upgrade rejected (403) if `Origin` header is present and not in allowlist.
- WS upgrade rejected (429) if the requesting identity already has ≥ N (default 5) live sockets.
- Server accepts `ping` text message and responds `pong`. Client sends ping every 30s; if no pong in 60s, closes WS to trigger reconnect.

**Non-functional**
- Allowlist configurable via `wrangler.json` env vars (`ALLOWED_ORIGINS`, comma-separated).
- Conn cap configurable (`MAX_WS_PER_IDENTITY`, default 5).

## Architecture

```
Worker /api/ws
  ├─ resolve identity (Phase 2 helper)
  ├─ origin check: if Origin present AND not in env.ALLOWED_ORIGINS → 403
  └─ forward to DO with identity in header

CanvasRoom #handleWsUpgrade
  ├─ existing = state.getWebSockets(identity)
  ├─ if existing.length >= MAX_WS_PER_IDENTITY → 429
  ├─ state.acceptWebSocket(server, [identity])
  └─ return 101

CanvasRoom webSocketMessage(ws, msg)
  ├─ if msg === 'ping' → ws.send('pong'); return
  └─ else → ws.close(1003, 'unsupported message')

Client (CanvasRenderer.svelte loadCanvas)
  let pendingWsEdits = [];
  ws.onmessage during fetch → push to pendingWsEdits (don't apply)
  fetch resolves:
    committedColors = new Uint8Array(indices);
    apply pendingWsEdits to committedColors
    pendingWsEdits = null
    flag "live mode" — onmessage now applies directly

Client (App.svelte)
  setInterval(() => ws.send('ping'), 30_000)
  trackPongTimer; if no pong in 60s → ws.close()
```

## Related Code Files

**Modify**
- `src/worker.js` — origin check before WS upgrade forwarding
- `src/durable-objects/canvas-room.js` — per-identity conn cap, ping handling, tag-aware acceptWebSocket
- `src/client/components/CanvasRenderer.svelte` — buffer-and-replay during initial fetch (around lines 465–484)
- `src/client/App.svelte` — ping interval, pong watchdog
- `src/lib/constants.js` — add `MAX_WS_PER_IDENTITY = 5`
- `wrangler.json` — add `vars: { ALLOWED_ORIGINS: "https://rplace.miti99.workers.dev" }`

**Create** — none

## Implementation Steps

1. **Origin allowlist in worker** (debugger H5)
   - Read `env.ALLOWED_ORIGINS` (comma-separated). Parse to Set at module top.
   - In `/api/ws` handler: if `Origin` header present and not in allowlist, return `c.text('forbidden_origin', 403)`. Empty allowlist → allow all (dev default).
   - Document in `wrangler.json` comment.

2. **Per-identity WS cap in DO** (review H4, debugger L6)
   - In `#handleWsUpgrade(request, identity)`: `const existing = this.state.getWebSockets(identity);`
   - If `existing.length >= MAX_WS_PER_IDENTITY` → return `new Response('too_many_sockets', { status: 429 })`.
   - Replace `state.acceptWebSocket(server)` with `state.acceptWebSocket(server, [identity])`.

3. **Server-side heartbeat** (review M3, debugger M3)
   - In `webSocketMessage(ws, message)`: if `message === 'ping'` → `ws.send('pong'); return;`. Else keep current close behavior.
   - Note: this works under hibernation because messages auto-rehydrate the DO.

4. **Client buffer-and-replay** (review C2)
   - In `loadCanvas` (`CanvasRenderer.svelte:465-484`):
     - Add `let pendingWsEdits = [];` and `let isLive = false;` at top of `loadCanvas`.
     - Expose `pushWsEdit(edit)` from the component: if `!isLive` → `pendingWsEdits.push(edit)`; else apply directly.
     - After fetch resolves and `committedColors = new Uint8Array(indices)`, replay: for each `edit` in `pendingWsEdits`, write to `committedColors[edit.idx] = edit.color` AND update `imageData`. Then `isLive = true; pendingWsEdits = null;`.
   - In parent (`App.svelte`), route ws.onmessage pixel events to `canvasRenderer.pushWsEdit(...)` instead of applying directly when first connect.

5. **Client heartbeat** (review M3)
   - In `App.svelte` WS open handler: start `setInterval(() => ws.readyState === 1 && ws.send('ping'), 30_000)`. Track `lastPongAt = Date.now()`.
   - On message `'pong'`: `lastPongAt = Date.now()`.
   - Watchdog: if `Date.now() - lastPongAt > 60_000` → `ws.close()` to trigger reconnect logic.
   - Clear interval/watchdog on `onclose`.

6. **Compile + smoke**
   - `npm run build` passes.
   - Open dev console, throttle network to "Slow 3G", reload, place pixel from a second tab during fetch, confirm pixel appears in tab 1 once fetch completes.
   - Try opening 6 WS connections from same browser → 6th gets 429.
   - Try opening WS from a different origin (curl with `Origin: https://evil.example`) → 403.
   - Confirm `ping`/`pong` round-trips in dev console.

## Todo List

- [ ] Origin allowlist parsing + worker check
- [ ] Per-identity WS cap (`MAX_WS_PER_IDENTITY`) with `acceptWebSocket(server, [identity])`
- [ ] Server `ping` handler returns `pong`
- [ ] `wrangler.json` `vars.ALLOWED_ORIGINS`
- [ ] Client buffer-and-replay for WS during initial fetch
- [ ] Client 30s ping / 60s pong watchdog
- [ ] `npm run build` passes
- [ ] Manual smoke: race-fix verified by slow network reload + remote pixel placement
- [ ] Manual smoke: 6th WS rejected with 429
- [ ] Manual smoke: foreign-origin WS rejected with 403
- [ ] Manual smoke: ping/pong visible in dev tools

## Success Criteria

- [ ] No pixel placed during the initial-fetch window is dropped (verified via instrumented log).
- [ ] WS upgrade from disallowed origin returns 403 in production.
- [ ] Per-identity cap enforced; logs show `too_many_sockets` when triggered.
- [ ] `onclose` fires within ~60s of network drop (verified via airplane-mode toggle).
- [ ] No regression in 94-test suite.

## Risk Assessment

- **Risk:** Origin allowlist set too tight → legitimate clients (preview deployments, custom domains) get 403.
  **Mitigation:** Empty `ALLOWED_ORIGINS` allows all — start with empty in dev/preview, populate before production deploy.
- **Risk:** Cap on identity blocks tab-power-users (5 tabs is normal for some folks).
  **Mitigation:** Cap is configurable; bump to 10 if support tickets appear.
- **Risk:** Heartbeat interval too aggressive → battery drain on mobile.
  **Mitigation:** 30s ping is well below the typical mobile-radio-wakeup penalty; keeping interval >= 25s avoids extra wakes.
- **Risk:** Buffer-and-replay logic interacts oddly with the existing `imageData` invalidation in CanvasRenderer.
  **Mitigation:** Replay loop must call the same path the live message handler does (write to both `committedColors` AND `imageData`); add a unit test in Phase 4.

## Security Considerations

- Origin check is a usability/cost barrier, not a security one — WS protocol allows non-browser clients to spoof Origin. Real defense is the per-identity cap + Worker request budget.
- Per-identity cap prevents broadcast amplification (debugger H5, L6).
- Heartbeat surface is a single text-equality check; no parser exposure.
