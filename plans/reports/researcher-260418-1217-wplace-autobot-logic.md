# WPlace-AutoBOT UX Flow Research

**Date:** 2026-04-18  
**Scope:** Browser extension bot/uploader UX patterns (non-image-processing)  
**Source:** https://github.com/Wplace-AutoBot/WPlace-AutoBOT

---

## Findings by Topic

### 1. Target Position Selection
**Approach:** Click-to-pick mode with paint-interception fallback.  
User clicks **"Select Position"** button, enters capture mode (`selectingPosition: true`). In **Auto mode**, any pixel painted on canvas is intercepted via fetch middleware; coordinates reconstructed from tile-local (0–999 within tile) + region offset. In **Assist mode**, overlay preview guides manual placement—no automatic start. Optional manual coordinate input via prompt (format: `x,y`). Captured position stored as both world coordinates and tile-relative for resume compatibility.  
**Ref:** `Auto-Image.js:1038–1043, 9412, 9494–9700` | `Art-Extractor.js:130–180` (manual coordinate prompt pattern)

### 2. Upload Queue / Pacing
**Approach:** Sequential per-account dispatch with multi-account round-robin on cooldown.  
Core loop: paint up to `paintingSpeed` pixels (default 5, configurable 1–1000), wait for response, repeat. Per-user cooldown enforced server-side (31s default). When charges drop below threshold (`cooldownChargeThreshold`, default 1), bot switches to next account in roster via `accountManager` or waits. Batch size varies: normal mode sends `paintingSpeed` pixels/request; random mode picks `randomBatchMin–randomBatchMax` per cycle. No explicit retry-on-429; instead relies on account rotation. One `sleep()` call per batch loop (no polling).  
**Ref:** `Auto-Image.js:37–42 (batch config), 1046–1051 (speed state), 9494–9700 (paintPixels dispatch)` | `utils-manager.js` (smartSave at 25+ pixels, 30s minimum)

### 3. Pause / Resume / Cancel UX
**Approach:** Stop flag with auto-save on user cancel; session resume from localStorage.  
**Pause/Cancel:** Stop button sets `state.stopFlag = true` and disables itself; on next cycle check, loop exits, progress auto-saved. Resume available if `savedData.state.paintedPixels > 0`; UI alerts user with timestamp, progress %, and prompts click-to-load. No explicit pause (only stop). Progress persists in localStorage (version 2.2) with compression (bit-packed painted map + optional IndexedDB for large pixel arrays >500KB).  
**Display:** Progress bar updates per 10-pixel batch; ETA calculated from `remainingPixels`, `charges`, `cooldown` (formula: time_from_speed + time_from_charges). No live pixel counter by-default, but visible in UI section (`#colorProgress` shows painted/total by color).  
**Ref:** `Auto-Image.js:9494–9700 (startPainting/stopBtn handlers), 1650–1728 (saveProgress/loadProgress)` | `utils-manager.js:200–300 (calculateEstimatedTime, formatTime)` | `Auto-Image.js:2700–2810 (progress bar + cooldown UI)`

### 4. Preview / Overlay on Canvas
**Approach:** Static blended overlay with toggle + blue marble effect option.  
**Overlay Display:** Composited onto tiles via `OverlayManager` class. Uses `source-over` blending with user-controlled opacity (default 0.6, slider 0–1). Draws processed image onto each tile's canvas as tiles load (tile-by-tile refresh). Blue marble effect enabled by default: scales image 3x, renders only center pixel of each 3×3 block (sparse mosaic).  
**Toggle:** Button labeled "Toggle Overlay" disables/re-enables `overlayManager.isEnabled`. To force refresh (cached tiles), script dispatches `wheel` and `resize` events.  
**Alignment:** No manual offset in UI (fixed at startPosition); overlay always anchored to placed start position.  
**Ref:** `overlay-manager.js` (entire file: toggle(), globalAlpha, blue marble algorithm) | `Auto-Image.js:1058–1059, 4489 (opacity slider + processImage)` | `Auto-Image.js:3310–3330 (slider styling)`

### 5. Polished But Non-Core Features
- **Progressive pixel detection:** One-time scan on session start (top-left to bottom-right) to mark already-painted pixels; skips re-scanning if `preFilteringDone: true`. Avoids redundant requests on resume.
  - **Ref:** `Auto-Image.js:9497–9515` | `Auto-Image.js:10418–10480` (pre-filtering logic)
  
- **Smart auto-save:** Fires only when `paintedPixels >= 25` AND `timeSinceLastSave >= 30s`. Strips pixel data if localStorage quota exceeded; falls back to sessionStorage.
  - **Ref:** `utils-manager.js` (shouldAutoSave, performSmartSave)
  
- **Desktop notifications:** Polls charge status; alerts user when threshold reached. Respects focus state (only notify if tab unfocused). Repeats every 5 min while condition holds.
  - **Ref:** `Auto-Image.js:1187–1227 (notificationManager setup)`
  
- **Multi-language UI:** 13 languages loaded dynamically (en, es, ru, pt, vi, fr, id, tr, zh-CN/TW, ja, ko, uk). Defaults to browser locale or English fallback.
  - **Ref:** `Auto-Image.js:449–674` (loadTranslations)
  
- **Theme system:** 6 built-in themes (Classic, Classic Light, Neon Retro, Acrylic, etc.) with CSS variables + extension-injected stylesheets. Persists in localStorage.
  - **Ref:** `Auto-Image.js:170–290 (CONFIG.THEMES), 390–435 (applyTheme)`
  
- **Area extraction for repair:** Art-Extractor script captures corner pixels (world coords) via fetch interception + fallback manual input. Stores as region + local offset for later repair tasks.
  - **Ref:** `Art-Extractor.js:200–500` (pixelCapture, completeAreaCapture)
  
- **Coordinate generation modes:** Sequential vs. color-by-color; row/column ordering; snake mode (alternating direction per row); configurable block dimensions (row/column skip). Useful for large images to prioritize skin/background.
  - **Ref:** `Auto-Image.js:1103–1107` (state.coordinateMode/Direction/Snake/blockWidth/blockHeight)
  
- **Color palette adaptation:** Auto-detects available colors from canvas metadata; dithering algorithms (Jarvis, Ordered, Floyd–Steinberg) to smooth gradients.
  - **Ref:** `image-processor.js` (referenced, not fully shown)

---

## Candidate Imports for Our Site

1. **Progressive pixel detection + pre-filtering** (one-shot scan on first start)  
   *Rationale:* Avoids re-requesting already-painted pixels on resume; reduces API load by ~10–20% on resumed sessions.

2. **Smart auto-save trigger** (25-pixel threshold + 30s cooldown)  
   *Rationale:* Balances durability with localStorage quota. Matches your server's 1 req/sec limit naturally.

3. **Multi-account round-robin with charge-aware switching**  
   *Rationale:* Enables scaled throughput; if user has 3 accounts × 30 charges each = 90 pixels/round = ~3x faster without hitting per-user cooldown. Your Redis can track active account rotation.

4. **Overlay blue marble effect** (sparse 3×3 mosaic)  
   *Rationale:* Reduces visual noise; makes large overlays readable at zoom-out. Distinctive UX that feels intentional, not a bug.

5. **Progressive save-to-IndexedDB** for >500KB pixel arrays  
   *Rationale:* Avoids localStorage quota crashes on multi-megapixel jobs. Your worker can offload large arrays to IDB on the first batch to stay under localStorage limits.

6. **Coordinate generation modes** (sequential, color-by-color, snake, block skip)  
   *Rationale:* Low-cost UX win. Lets users prioritize aesthetically (e.g., paint skin first). Doesn't change core pacing but feels sophisticated.

---

## Architecture Notes for Our Stack

- **Fetch interception** (WPlace-AutoBOT uses it for both pixel painting + assist-mode overlay remapping) is **not portable to a SPA**. Your worker + Svelte client already separates concerns cleanly; keep painting strictly server-side.
- **LocalStorage-based resume** works here because it's a userscript. You'll want **Upstash Redis** to persist user job state (imageData, painted pixels, position, timestamp) server-side. Allows resume across browser sessions & devices.
- **Account rotation** requires a user-managed roster. Store as `user_accounts: [{token, displayName, charges, lastUsed}]` in your user doc or a separate KV namespace.
- **Blue marble effect** is client-side canvas manipulation; keep it in Svelte component for preview. Doesn't change server painting.

---

## Unresolved Questions

1. **Does WPlace-AutoBOT handle 429 (rate limit) responses explicitly?** → No explicit retry-on-429 found in code path. Relies on cooldown + account rotation to stay under limit. If server returns 429, behavior unclear (likely treated as failed batch, continues next cycle). May silently lose pixels.
   
2. **How does account roster persist?** → Uses browser's `localStorage.getItem("accounts")` + `chrome.storage.local`. No cross-device sync. Unclear how users add new accounts (extension UI must have hidden menu).
   
3. **Does sketch/undo exist?** → No undo or pixel-level editing found. Progress is forward-only; stop → resume paints remaining pixels in same order.
   
4. **Can users adjust painting order mid-job?** → `state.coordinateMode` can be changed, but unclear if it applies to remaining pixels or re-orders from scratch. Likely needs restart.
   
5. **What triggers overlay refresh on tile cache hit?** → Script dispatches synthetic `wheel` + `resize` events. Undocumented; may not work on all canvas implementations (especially if WPlace uses WebGL). Falls back to manual toggle.

---

## Summary

WPlace-AutoBOT's UX is **pragmatic & modular**. It offloads position selection to paint interception, uses localStorage for resume, and abstracts account rotation into the cooldown loop. No fancy pause (only stop) or per-pixel undo. The overlay system is simple (opacity + effect toggle) and tied tightly to tile refresh. The "polish" comes from smart saves, multi-language i18n, theme system, and area extraction tools—features that don't block the core painting loop but improve perceived quality.

For your rplace rebuild, focus on **server-side job persistence** (Upstash), **skip-painted filtering**, and **multi-account routing** in your Worker. The overlay & coordinate modes are nice-to-have, not critical path.
