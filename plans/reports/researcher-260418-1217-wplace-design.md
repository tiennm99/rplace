# Wplace.live UI/UX Design Research

**Date:** 2026-04-18  
**Analyst:** Researcher  
**Scope:** wplace.live design patterns vs. rplace current implementation

---

## 1. Color Palette Picker

**Wplace.live:** 64-color palette (24 free + 40 premium). Browser extensions provide quick color picker overlays with coordinate display; third-party tools emphasize "easy color identification" via visual feedback. No detailed native UI layout found (grid vs. wheel not specified in accessible sources). Color converter tools support multiple input methods (direct value entry, visual pickers, palette selection) with real-time feedback.

**Your current impl:** 32-color grid, docked bottom, 8-wide × 4-tall layout, 32px swatches, hover scale 1.2, selected state has white border + glow, dark background (rgba 0,0,0 0.85) with blur. **Matches pattern.** You have fewer colors and smaller grid. Wplace's ecosystem relies heavily on *third-party tools* for picker UX (not native), suggesting their built-in picker may be minimal.

**Verdict:** Your picker is more polished than wplace's likely native implementation. Third-party tools suggest the base UI doesn't have an outstanding picker. **No immediate import needed.**

---

## 2. Canvas Controls

**Wplace.live:** 
- Zoom: Mouse wheel, Q/E keyboard shortcuts, "Zoom in to see pixels" button (jumps to level 10; pixels only visible at zoom ≥10)
- Pan: WASD keys + mouse drag
- Coordinates: Real-world location display (latitude/longitude); third-party extensions add coordinate search (format: `123,456` or degrees-minutes-seconds)
- **No minimap found**; third-party tools offer "location manager" to bookmark/jump to spots
- Geographic context: Every pixel maps to real-world locations on OpenStreetMap

**Your current impl:** Zoom buttons (+ / −) at bottom-left, mouse wheel zoom, coordinates display, zoom levels 1–19 (user not specified), pan via drag. **Differs:** No keyboard shortcuts (Q/E), no WASD pan, no goto-coordinates input, no location bookmarks. **Lacks:** No real-world coordinate mapping (your canvas is abstract 2048×2048).

**Verdict:** Wplace's keyboard shortcuts (Q/E zoom, WASD pan) + goto-coordinates input are **quick UX wins**. Minimap is provided by third-party only, not native. **Recommend borrowing:** Keyboard pan/zoom shortcuts + coordinate search input.

---

## 3. User Info / Rate-Limit Display

**Wplace.live:** Cooldown timer displayed somewhere (referenced as "1 pixel every 30 seconds"). Pixel charge system with "Pixel Pool" that starts at 30–64 and expands via purchase or leveling. Leaderboards for players, alliances, countries, regions. **No explicit cooldown countdown timer UI details found** in accessible sources; third-party overlays enhance this.

**Your current impl:** Rate limit is 1 request/second (batch-independent), not per-pixel. No visible cooldown timer, no pixel-pool display, no level/purchase system, no leaderboards. **Lacks:** Visible countdown, gamification (levels, inventory), leaderboards.

**Verdict:** Wplace emphasizes **gamification** (levels, pixel pool, leaderboards) and **cooldown transparency** (visible timer). Your app is simpler (no progression system planned?). **Recommend:** Add visible cooldown countdown on next-available timestamp (e.g., "Next paint in 3s"). Leaderboard / progression left to future scope.

---

## 4. Place / Submit Flow

**Wplace.live:** Click-to-draw; pixel placement mechanics include eraser tool (dedicated button or spacebar + cursor). Charge system: clicks spend from pixel pool. No mention of pending buffer, explicit submit, or undo/redo in core flow. **Single-action placement** (no pending buffer like yours).

**Your current impl:** **Two-stage flow:** paint locally (pending buffer), then click Submit to POST batch. Undo/Redo buttons available. Paint mode toggleable. No eraser tool. **Differs significantly:** You have a *pending buffer* (uncommitted pixels), wplace has *immediate placement* with a charge pool.

**Verdict:** Your buffering approach is **safer for batch optimization** (batches up to 2048 pixels, 1 req/sec). Wplace's single-action model feels more responsive but requires careful rate-limiting on the server side. **No import suggested**—your batch model is architecturally sounder for a small canvas. Eraser tool could be added as a future enhancement.

---

## 5. Image Importer / Converter

**Wplace.live:** External pixel-art converters (Floyd-Steinberg, Ordered, Atkinson dithering), grid overlay, drag-and-drop upload, real-time preview, 64-color palette matching, browser-side processing (no server upload). Multiple converters available; UI is clean and intuitive but not deeply detailed in sources.

**Your current impl:** Full image importer (phase 6 completed). Features: dither methods (none, ordered, floyd-steinberg, ordered-64, atkinson), skip-white + paint-transparent toggles, color correction (brightness, contrast, saturation, gamma), resize with aspect-lock, flip/rotate transforms, on-canvas overlay preview with alpha control, drag-and-drop, live batched upload with progress. **Exceeds** wplace converters in sophistication and integration.

**Verdict:** **Your importer is more feature-rich than wplace's external tools.** You already have a competitive advantage. No imports needed. Your in-app integration + color-correction sliders are differentiators.

---

## 6. General Visual Language

**Wplace.live:** 
- Dark theme (maps are typically dark by default on MapLibre/OSM)
- Web-based overlay on world map (geographic context is the visual centerpiece)
- Collapsible/draggable UI windows (mentioned in search results)
- Light/dark mode support (browser extensions mention toggle)
- No detailed typography or specific accent-color guidance found
- Onboarding / empty-state: Not documented in accessible sources

**Your current impl:** 
- Dark theme only
- Abstract 2048×2048 canvas (no geographic context)
- Fixed layout: toolbar top-right, color picker bottom-center, controls bottom-left, importer panel top-right
- Rgba panels with blur, white accent on selected items
- No onboarding, no empty-state visual
- Mobile: pinch-zoom + touch-drag supported (no specific mobile UI layout)

**Verdict:** Wplace's **draggable/collapsible UI** is a nice flexibility feature but not critical. Your fixed layout is simpler and clearer. **Recommend:** Add a simple onboarding tooltip (first-time visit) explaining paint → submit flow, color picker, and zoom controls. Mobile layout could benefit from a mobile-specific toolbar (e.g., stacked buttons instead of side-by-side).

---

## Candidate Imports for Our Site

### 1. **Keyboard Shortcuts for Pan & Zoom** (small effort)
   - **What:** Add Q/E for zoom in/out and WASD for pan (wplace pattern)
   - **Why:** Power-user friendly, faster workflow, matches common game/design tool patterns
   - **Effort:** Small (2–3 lines per command, keyboard handler already exists)

### 2. **Goto-Coordinates Input** (small effort)
   - **What:** Add a text input in canvas-controls to jump directly to x,y (e.g., "256,512" → center canvas there)
   - **Why:** QoL improvement for large canvases; wplace's search feature is a third-party add-on, suggesting native feature gap
   - **Effort:** Small (input field + canvas center/zoom logic)

### 3. **Visible Cooldown Countdown** (small effort)
   - **What:** Display "Next paint in Xs" on the submit button when rate-limited
   - **Why:** Reduces user confusion; wplace players expect cooldown visibility
   - **Effort:** Small (store next-available timestamp, update UI every 100ms)

### 4. **Simple Onboarding Tooltip** (medium effort)
   - **What:** First-time visitor banner explaining: select color → paint → submit, with mouse/touch hints
   - **Why:** Wplace relies on external guides; your app should be self-documenting
   - **Effort:** Medium (modal/banner component, localStorage to hide after first interaction)

### 5. **Mobile-Optimized Toolbar** (medium effort)
   - **What:** Stack or simplify draw toolbar buttons for small screens; ensure color picker is touch-friendly
   - **Why:** Wplace is discussed as "viral on TikTok"—heavy mobile use; your importer is on-brand for desktop first
   - **Effort:** Medium (responsive breakpoint, grid-to-column layout swap, touch target sizes ≥48px)

### 6. **Eraser Tool (Optional)** (medium effort)
   - **What:** Toggle eraser mode (paints transparent or placeholder color) or spacebar + click to erase
   - **Why:** Wplace offers this; useful for corrections without undo overhead
   - **Effort:** Medium (add mode toggle, update paint logic to handle erase color)

---

## Key Findings

| Aspect | Wplace Pattern | Your Implementation | Gap | Priority |
|--------|---|---|---|---|
| Color picker | 64-color palette (external tools provide UI) | 32-color grid, polished | None—yours is better | — |
| Canvas controls | Q/E zoom, WASD pan, goto-coords | Buttons, mouse-wheel, no keyboard | Keyboard shortcuts missing | Small |
| Cooldown display | Visible countdown (implicit from pooling) | None shown | Transparency gap | Small |
| Place flow | Immediate (charge-based) | Buffered + submit | Architectural difference; yours is safer | — |
| Image importer | External dither converters | In-app, 6 dither methods + color correction | Yours exceeds | — |
| Visual language | Dark, map-centric, collapsible UI | Dark, fixed layout, polished panels | Layout flexibility gap (non-critical) | Large (low ROI) |
| Onboarding | Not found (likely minimal) | None | User confusion risk | Medium |

---

## Sources

- [Wplace.live Guide](https://wplace.life/)
- [Place Live vs. Wplace Live: From Reddit's r/Place to a Global Pixel World](https://wplace.style/blog/reddit-place-vs-wplace)
- [Ultimate Wplace.live Guide — Cooldown, Tools & Hot Regions](https://wplaceartconverter.com/wplace-guide)
- [Complete Wplace.live Location Search Guide](https://wplacepixelconverter.org/blog/complete-wplace-live-location-search-guide/)
- [Wplace.live Extension & Tools](https://wplacetool.com/wplace-extension)
- [Wplace Pixel Art Converter — Free Online Tool](https://wplaceconverter.net/)
- [GitHub - Wplace Tools & Overlays](https://github.com/ethansunray/wplace-tool)
- [Wplace Color Palette Reference](https://wplacepixel.com/wplace-color-palette)

---

## Unresolved Questions

1. **Wplace native UI details:** Direct access to wplace.live blocked (403). Details on built-in color picker layout (grid width, swatches per row) inferred from third-party tools, not official UI. If critical, may need user account or GitHub repo inspection.
2. **Cooldown timer implementation:** Wplace sources mention cooldown system but don't specify countdown display details—inferred as "expected" from community tool discussions.
3. **Mobile layout:** Wplace's viral TikTok popularity suggests strong mobile use, but no mobile-specific UI layout details found in sources.
4. **Onboarding flow:** Neither wplace nor your current app have documented onboarding; gap identified from *absence*, not competitor feature.

---

**Report Status:** Ready for design review. Highest-ROI imports are keyboard shortcuts (#1), goto-coordinates (#2), and cooldown countdown (#3). All are small-effort QoL wins.
