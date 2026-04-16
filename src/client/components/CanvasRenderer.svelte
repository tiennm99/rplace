<script>
  import { onMount } from 'svelte';
  import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA } from '../../lib/constants.js';
  import { decodeCanvas, indicesToRgba } from '../../lib/canvas-decoder.js';
  import { createPixelBuffer } from '../../lib/pixel-buffer.js';

  let { selectedColor, zoom, onZoomChange, onCursorMove, mode, onBufferChange } = $props();

  let canvasEl;
  let imageData = null;
  /** Committed color index per pixel (server-confirmed state) */
  let committedColors = null;
  let pan = { x: 0, y: 0 };
  let dragging = $state(false);
  let lastMouse = { x: 0, y: 0 };
  let loading = $state(true);

  // Active stroke being drawn (not yet in buffer)
  let currentStroke = [];
  let currentStrokeKeys = new Set();

  const buffer = createPixelBuffer();
  const offscreen = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const offCtx = offscreen.getContext('2d');

  // Touch state
  let lastTouchDist = 0;
  let touchStartTime = 0;
  let touchMoved = false;

  function render() {
    if (!canvasEl || !imageData) return;
    const ctx = canvasEl.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    offCtx.putImageData(imageData, 0, 0);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
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
  }

  function notifyBuffer() {
    onBufferChange({
      canUndo: buffer.canUndo, canRedo: buffer.canRedo, pixelCount: buffer.pixelCount,
    });
  }

  /** Restore pixel to committed color, or re-apply pending if another stroke covers it */
  function restorePixel(x, y) {
    const pending = buffer.getColorAt(x, y);
    setPixelRgba(x, y, pending >= 0 ? pending : committedColors[y * CANVAS_WIDTH + x]);
  }

  function addToStroke(x, y) {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
    const key = y * 65536 + x;
    if (currentStrokeKeys.has(key)) return;
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

  export function commitPending() {
    for (const { x, y, color } of buffer.getAllPixels()) {
      committedColors[y * CANVAS_WIDTH + x] = color;
    }
    buffer.clear();
    notifyBuffer();
  }

  // --- Mouse handlers ---

  function handleMouseDown(e) {
    if (e.button === 0) {
      dragging = false;
      lastMouse = { x: e.clientX, y: e.clientY };
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
      if (mode === 'draw') {
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
      if (mode === 'draw') {
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
    const newZoom = Math.max(0.25, Math.min(64, zoom * factor));
    pan.x = e.clientX - (e.clientX - pan.x) * (newZoom / zoom);
    pan.y = e.clientY - (e.clientY - pan.y) * (newZoom / zoom);
    onZoomChange(newZoom);
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
      if (mode === 'draw') {
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

      if (mode === 'draw') {
        const pos = screenToCanvas(e.touches[0].clientX, e.touches[0].clientY);
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
      const newZoom = Math.max(0.25, Math.min(64, zoom * scale));
      pan.x = center.x - (center.x - pan.x) * (newZoom / zoom);
      pan.y = center.y - (center.y - pan.y) * (newZoom / zoom);
      pan.x += center.x - lastMouse.x;
      pan.y += center.y - lastMouse.y;
      lastTouchDist = dist;
      lastMouse = center;
      onZoomChange(newZoom);
    }
  }

  function handleTouchEnd(e) {
    if (mode === 'draw') {
      finishStroke();
    } else if (!touchMoved && e.changedTouches.length === 1 && Date.now() - touchStartTime > 300) {
      const t = e.changedTouches[0];
      const pos = screenToCanvas(t.clientX, t.clientY);
      addToStroke(pos.x, pos.y);
      finishStroke();
    }
  }

  // Re-render when zoom changes
  $effect(() => { zoom; render(); });

  onMount(async () => {
    function resize() {
      canvasEl.width = window.innerWidth;
      canvasEl.height = window.innerHeight;
      render();
    }
    resize();
    window.addEventListener('resize', resize);

    try {
      const res = await fetch('/api/canvas');
      const buf = await res.arrayBuffer();
      const indices = decodeCanvas(buf);
      committedColors = new Uint8Array(indices);
      const rgba = indicesToRgba(indices);
      imageData = new ImageData(rgba, CANVAS_WIDTH, CANVAS_HEIGHT);
      render();
    } catch (err) {
      console.error('Failed to load canvas:', err);
    } finally {
      loading = false;
    }

    return () => window.removeEventListener('resize', resize);
  });
</script>

<div class="canvas-container">
  {#if loading}
    <div class="loading">Loading canvas...</div>
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
    style="cursor: {mode === 'draw' ? 'crosshair' : dragging ? 'grabbing' : 'crosshair'}; touch-action: none"
  ></canvas>
</div>

<style>
  .canvas-container { width: 100%; height: 100%; }
  canvas { display: block; }
  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 1.5rem;
    color: #888;
    z-index: 5;
  }
</style>
