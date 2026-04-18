<script>
  import { onMount } from 'svelte';
  import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA, MAX_BATCH_SIZE } from '../../lib/constants.js';
  import { decodeCanvas, indicesToRgba } from '../../lib/canvas-decoder.js';
  import { createPixelBuffer } from '../../lib/pixel-buffer.js';
  import { paletteToRgba } from '../../lib/image-to-palette.js';

  let { selectedColor, zoom, onZoomChange, onCursorMove, mode, onBufferChange, onBufferFull,
        pickActive = false, onPick, onEyedrop, minZoom = 0.25 } = $props();

  let canvasEl;
  let imageData = null;
  /** Committed color index per pixel (server-confirmed state). Allocated upfront so WS
   *  updates that arrive during the initial canvas fetch don't null-deref. */
  let committedColors = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
  let pan = { x: 0, y: 0 };
  let dragging = $state(false);
  let lastMouse = { x: 0, y: 0 };
  let loading = $state(true);
  let loadError = $state(null);

  // Active stroke being drawn (not yet in buffer)
  let currentStroke = [];
  let currentStrokeKeys = new Set();

  const buffer = createPixelBuffer();
  const offscreen = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const offCtx = offscreen.getContext('2d');

  /** Overlay state: image-importer preview rendered on top of committed+pending.
   *  { x, y, canvas: OffscreenCanvas, alpha } or null. */
  let overlayState = null;

  // Touch state
  let lastTouchDist = 0;
  let touchStartTime = 0;
  let touchMoved = false;

  // --- Render coalescing ---
  // Any state change calls render(). Multiple calls within a frame collapse
  // to one actual paint via requestAnimationFrame. imageDataDirty gates the
  // expensive putImageData (16 MB copy): only re-upload when pixels changed.
  let rafPending = false;
  let imageDataDirty = true;
  let pendingEffZoom = null;

  function render(effZoom = zoom) {
    pendingEffZoom = effZoom;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const z = pendingEffZoom;
      pendingEffZoom = null;
      doRender(z);
    });
  }

  function clampPan(effZoom = zoom) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dispW = CANVAS_WIDTH * effZoom;
    const dispH = CANVAS_HEIGHT * effZoom;
    // If canvas >= viewport on an axis, pan range is [vw - dispW, 0] — canvas
    // always covers viewport. If canvas < viewport, range is [0, vw - dispW] —
    // canvas always stays inside (centered at midpoint).
    const minX = Math.min(0, vw - dispW);
    const maxX = Math.max(0, vw - dispW);
    const minY = Math.min(0, vh - dispH);
    const maxY = Math.max(0, vh - dispH);
    pan.x = Math.max(minX, Math.min(maxX, pan.x));
    pan.y = Math.max(minY, Math.min(maxY, pan.y));
  }

  function doRender(effZoom) {
    if (!canvasEl || !imageData) return;
    clampPan(effZoom);
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvasEl.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset before clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    if (imageDataDirty) {
      offCtx.putImageData(imageData, 0, 0);
      imageDataDirty = false;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // CSS pixels → device pixels
    ctx.translate(pan.x, pan.y);
    ctx.scale(effZoom, effZoom);
    ctx.drawImage(offscreen, 0, 0);
    if (overlayState) {
      ctx.globalAlpha = overlayState.alpha;
      ctx.drawImage(overlayState.canvas, overlayState.x, overlayState.y);
      ctx.globalAlpha = 1;
    }
  }

  function screenToCanvas(clientX, clientY) {
    return {
      x: Math.floor((clientX - pan.x) / zoom),
      y: Math.floor((clientY - pan.y) / zoom),
    };
  }

  function setPixelRgba(x, y, colorIndex) {
    if (!imageData) return;
    const rgba = COLORS_RGBA[colorIndex];
    const off = (y * CANVAS_WIDTH + x) * 4;
    imageData.data[off] = rgba[0];
    imageData.data[off + 1] = rgba[1];
    imageData.data[off + 2] = rgba[2];
    imageData.data[off + 3] = rgba[3];
    imageDataDirty = true;
  }

  function notifyBuffer() {
    onBufferChange?.({
      canUndo: buffer.canUndo, canRedo: buffer.canRedo, pixelCount: buffer.pixelCount,
    });
  }

  /** Restore pixel to committed color, or re-apply pending if another stroke covers it */
  function restorePixel(x, y) {
    const pending = buffer.getColorAt(x, y);
    setPixelRgba(x, y, pending >= 0 ? pending : committedColors[y * CANVAS_WIDTH + x]);
  }

  function totalPendingPixels() {
    return buffer.pixelCount + currentStrokeKeys.size;
  }

  function addToStroke(x, y) {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
    const key = y * 65536 + x;
    if (currentStrokeKeys.has(key)) return;
    // Cap unique pending pixels at MAX_BATCH_SIZE — prevents OOM on long draws and matches server limit.
    // Don't block if this coord is already in buffer (overwrite doesn't grow total).
    if (totalPendingPixels() >= MAX_BATCH_SIZE && buffer.getColorAt(x, y) < 0) {
      onBufferFull?.();
      return;
    }
    currentStrokeKeys.add(key);
    currentStroke.push({ x, y, color: selectedColor });
    setPixelRgba(x, y, selectedColor);
    render();
  }

  function finishStroke() {
    if (!currentStroke.length) return;
    buffer.addStroke(currentStroke);
    currentStroke = [];
    currentStrokeKeys = new Set();
    notifyBuffer();
  }

  function cancelStroke() {
    if (!currentStroke.length) return;
    for (const { x, y } of currentStroke) restorePixel(x, y);
    currentStroke = [];
    currentStrokeKeys = new Set();
    render();
  }

  // --- Public API (called by App.svelte) ---

  export function applyUpdates(pixels) {
    for (const { x, y, color } of pixels) {
      committedColors[y * CANVAS_WIDTH + x] = color;
      // Only update display if no pending or active stroke covers this pixel
      if (buffer.getColorAt(x, y) < 0 && !currentStrokeKeys.has(y * 65536 + x)) {
        setPixelRgba(x, y, color);
      }
    }
    render();
  }

  export function undo() {
    const stroke = buffer.undo();
    if (!stroke) return;
    for (const { x, y } of stroke) restorePixel(x, y);
    render();
    notifyBuffer();
  }

  export function redo() {
    const stroke = buffer.redo();
    if (!stroke) return;
    for (const { x, y, color } of stroke) setPixelRgba(x, y, color);
    render();
    notifyBuffer();
  }

  export function clearPending() {
    const keys = buffer.getAffectedKeys();
    buffer.clear();
    for (const key of keys) {
      const x = key % 65536;
      const y = Math.floor(key / 65536);
      setPixelRgba(x, y, committedColors[y * CANVAS_WIDTH + x]);
    }
    render();
    notifyBuffer();
  }

  export function getPendingPixels() { return buffer.getAllPixels(); }

  export function getCommittedColor(x, y) {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return -1;
    return committedColors[y * CANVAS_WIDTH + x];
  }

  /** Set or clear the preview overlay drawn on top of the canvas.
   *  @param {{x: number, y: number, width: number, height: number, indices: Int16Array|number[], alpha?: number}|null} overlay */
  export function setOverlay(overlay) {
    if (!overlay || !overlay.indices || overlay.width <= 0 || overlay.height <= 0) {
      overlayState = null;
      render();
      return;
    }
    const { x, y, width, height, indices, alpha = 0.6 } = overlay;
    const rgba = paletteToRgba(indices, width, height);
    const oc = new OffscreenCanvas(width, height);
    const octx = oc.getContext('2d');
    octx.putImageData(new ImageData(rgba, width, height), 0, 0);
    overlayState = { x, y, canvas: oc, alpha };
    render();
  }

  /** Offset the pan by (dx, dy) CSS pixels. Used by keyboard pan shortcuts. */
  export function panBy(dx, dy) {
    pan.x += dx;
    pan.y += dy;
    render();
  }

  /** Center the viewport on canvas coordinate (x, y). Clamps to canvas bounds. */
  export function gotoPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const cx = Math.max(0, Math.min(x, CANVAS_WIDTH - 1));
    const cy = Math.max(0, Math.min(y, CANVAS_HEIGHT - 1));
    pan.x = window.innerWidth / 2 - cx * zoom;
    pan.y = window.innerHeight / 2 - cy * zoom;
    render();
  }

  /** Cancel any in-progress draw stroke (exposed for Esc shortcut). */
  export function cancelStrokeIfAny() {
    cancelStroke();
  }

  export function commitPending() {
    for (const { x, y, color } of buffer.getAllPixels()) {
      committedColors[y * CANVAS_WIDTH + x] = color;
    }
    buffer.clear();
    notifyBuffer();
  }

  export async function refetchCanvas() {
    await loadCanvas();
  }

  // --- Mouse handlers ---

  function handleMouseDown(e) {
    if (e.button === 0) {
      dragging = false;
      lastMouse = { x: e.clientX, y: e.clientY };
      // In pick mode a left-click-without-drag picks a target; we skip stroking
      // here and defer to mouseUp (so the user can still left-drag to pan).
      if (pickActive) return;
      // Alt+click always samples the committed color, regardless of mode.
      // In 'eyedrop' mode, plain click does the same — sampling happens on
      // mouseUp-without-drag so the user can still left-drag to pan.
      if (e.altKey || mode === 'eyedrop') return;
      if (mode === 'draw') {
        const pos = screenToCanvas(e.clientX, e.clientY);
        addToStroke(pos.x, pos.y);
      }
    } else if (e.button === 2) {
      lastMouse = { x: e.clientX, y: e.clientY };
    }
  }

  function handleMouseMove(e) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    onCursorMove({
      x: Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1)),
      y: Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1)),
    });

    if (e.buttons & 1) {
      if (!pickActive && !e.altKey && mode === 'draw') {
        addToStroke(pos.x, pos.y);
      } else {
        const dx = e.clientX - lastMouse.x;
        const dy = e.clientY - lastMouse.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragging = true;
        pan.x += dx;
        pan.y += dy;
        lastMouse = { x: e.clientX, y: e.clientY };
        render();
      }
    }
    // Right button — pan in any mode
    if (e.buttons & 2) {
      pan.x += e.clientX - lastMouse.x;
      pan.y += e.clientY - lastMouse.y;
      lastMouse = { x: e.clientX, y: e.clientY };
      render();
    }
  }

  function handleMouseUp(e) {
    if (e.button === 0) {
      if (pickActive) {
        if (!dragging) {
          const pos = screenToCanvas(e.clientX, e.clientY);
          const cx = Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1));
          const cy = Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1));
          onPick?.({ x: cx, y: cy });
        }
      } else if (!dragging && (e.altKey || mode === 'eyedrop')) {
        const pos = screenToCanvas(e.clientX, e.clientY);
        const cx = Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1));
        const cy = Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1));
        const idx = getCommittedColor(cx, cy);
        if (idx >= 0) onEyedrop?.(idx);
      } else if (mode === 'draw') {
        finishStroke();
      } else if (!dragging) {
        const pos = screenToCanvas(e.clientX, e.clientY);
        addToStroke(pos.x, pos.y);
        finishStroke();
      }
    }
    dragging = false;
  }

  function handleContextMenu(e) { e.preventDefault(); }

  function handleWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 2 : 0.5;
    const newZoom = Math.max(minZoom, Math.min(64, zoom * factor));
    pan.x = e.clientX - (e.clientX - pan.x) * (newZoom / zoom);
    pan.y = e.clientY - (e.clientY - pan.y) * (newZoom / zoom);
    if (newZoom !== zoom) onZoomChange(newZoom);
    render(newZoom); // explicit — covers the case where zoom was clamped
  }

  // --- Touch handlers ---

  function getTouchDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
  }

  function handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      touchStartTime = Date.now();
      touchMoved = false;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (!pickActive && mode === 'draw') {
        const pos = screenToCanvas(e.touches[0].clientX, e.touches[0].clientY);
        addToStroke(pos.x, pos.y);
      }
    } else if (e.touches.length === 2) {
      if (currentStroke.length) finishStroke();
      lastTouchDist = getTouchDist(e.touches);
      lastMouse = getTouchCenter(e.touches);
    }
  }

  function handleTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - lastMouse.x;
      const dy = e.touches[0].clientY - lastMouse.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMoved = true;

      const pos = screenToCanvas(e.touches[0].clientX, e.touches[0].clientY);
      onCursorMove({
        x: Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1)),
        y: Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1)),
      });

      if (!pickActive && mode === 'draw') {
        addToStroke(pos.x, pos.y);
        lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else {
        pan.x += dx;
        pan.y += dy;
        lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        render();
      }
    } else if (e.touches.length === 2) {
      touchMoved = true;
      const dist = getTouchDist(e.touches);
      const center = getTouchCenter(e.touches);
      const scale = dist / lastTouchDist;
      const newZoom = Math.max(minZoom, Math.min(64, zoom * scale));
      pan.x = center.x - (center.x - pan.x) * (newZoom / zoom);
      pan.y = center.y - (center.y - pan.y) * (newZoom / zoom);
      pan.x += center.x - lastMouse.x;
      pan.y += center.y - lastMouse.y;
      lastTouchDist = dist;
      lastMouse = center;
      if (newZoom !== zoom) onZoomChange(newZoom);
      render(newZoom);
    }
  }

  function handleTouchEnd(e) {
    if (pickActive) {
      if (!touchMoved && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const pos = screenToCanvas(t.clientX, t.clientY);
        const cx = Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1));
        const cy = Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1));
        onPick?.({ x: cx, y: cy });
      }
      return;
    }
    if (mode === 'draw') {
      finishStroke();
    } else if (!touchMoved && e.changedTouches.length === 1 && Date.now() - touchStartTime > 300) {
      const t = e.changedTouches[0];
      const pos = screenToCanvas(t.clientX, t.clientY);
      addToStroke(pos.x, pos.y);
      finishStroke();
    }
  }

  // Cancel any in-progress stroke on mode change to avoid merging across modes.
  $effect(() => {
    mode;
    if (currentStroke.length) cancelStroke();
  });

  // Re-render when zoom changes (effect runs after parent prop update)
  $effect(() => { zoom; render(); });

  async function loadCanvas() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/canvas');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const indices = decodeCanvas(buf);
      committedColors = new Uint8Array(indices); // replace pre-allocated zero array
      const rgba = indicesToRgba(indices);
      imageData = new ImageData(rgba, CANVAS_WIDTH, CANVAS_HEIGHT);
      imageDataDirty = true;
      render();
    } catch (err) {
      console.error('Failed to load canvas:', err);
      loadError = err.message || String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvasEl.width = window.innerWidth * dpr;
      canvasEl.height = window.innerHeight * dpr;
      canvasEl.style.width = `${window.innerWidth}px`;
      canvasEl.style.height = `${window.innerHeight}px`;
      render();
    }
    resize();
    window.addEventListener('resize', resize);

    // Async load runs in background — onMount cleanup must be sync to avoid leaking listener.
    loadCanvas();

    return () => window.removeEventListener('resize', resize);
  });
</script>

<div class="canvas-container">
  {#if loading}
    <div class="loading">Loading canvas...</div>
  {/if}
  {#if loadError}
    <div class="error">
      <div>Failed to load canvas: {loadError}</div>
      <button onclick={loadCanvas}>Retry</button>
    </div>
  {/if}
  <canvas
    bind:this={canvasEl}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onwheel={handleWheel}
    oncontextmenu={handleContextMenu}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    style="cursor: {dragging ? 'grabbing' : mode === 'eyedrop' ? 'copy' : 'crosshair'}; touch-action: none"
  ></canvas>
</div>

<style>
  .canvas-container { width: 100%; height: 100%; }
  canvas { display: block; }
  .loading, .error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 1.2rem;
    color: #ccc;
    z-index: 5;
    text-align: center;
  }
  .error {
    background: rgba(40, 0, 0, 0.92);
    border: 1px solid #a33;
    padding: 16px 24px;
    border-radius: 8px;
  }
  .error button {
    margin-top: 10px;
    padding: 6px 14px;
    background: #a33;
    color: #fff;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }
</style>
