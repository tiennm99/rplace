<script>
  import { onMount } from 'svelte';
  import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA } from '../../lib/constants.js';
  import { decodeCanvas, indicesToRgba } from '../../lib/canvas-decoder.js';

  let { selectedColor, credits, onCreditsChange, zoom, onZoomChange, onCursorMove } = $props();

  let canvasEl;
  let imageData = null;
  let pan = { x: 0, y: 0 };
  let dragging = $state(false);
  let lastMouse = { x: 0, y: 0 };
  let loading = $state(true);

  // Touch state
  let lastTouchDist = 0;
  let touchStartTime = 0;
  let touchMoved = false;

  // Cached offscreen canvas
  const offscreen = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const offCtx = offscreen.getContext('2d');

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

  function updatePixel(x, y, colorIndex) {
    if (!imageData) return;
    const color = COLORS_RGBA[colorIndex];
    const offset = (y * CANVAS_WIDTH + x) * 4;
    imageData.data[offset] = color[0];
    imageData.data[offset + 1] = color[1];
    imageData.data[offset + 2] = color[2];
    imageData.data[offset + 3] = color[3];
  }

  async function placePixel(x, y) {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
    if (credits <= 0) return;

    updatePixel(x, y, selectedColor);
    render();

    try {
      const res = await fetch('/api/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels: [{ x, y, color: selectedColor }] }),
      });
      const data = await res.json();
      if (data.ok) onCreditsChange(data.credits);
    } catch (err) {
      console.error('Failed to place pixel:', err);
    }
  }

  export function applyUpdates(pixels) {
    for (const { x, y, color } of pixels) {
      updatePixel(x, y, color);
    }
    render();
  }

  // --- Mouse handlers ---

  function handleMouseDown(e) {
    if (e.button === 0) {
      dragging = false;
      lastMouse = { x: e.clientX, y: e.clientY };
    }
  }

  function handleMouseMove(e) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    onCursorMove({
      x: Math.max(0, Math.min(pos.x, CANVAS_WIDTH - 1)),
      y: Math.max(0, Math.min(pos.y, CANVAS_HEIGHT - 1)),
    });

    if (e.buttons === 1) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragging = true;
      pan.x += dx;
      pan.y += dy;
      lastMouse = { x: e.clientX, y: e.clientY };
      render();
    }
  }

  function handleMouseUp(e) {
    if (e.button === 0 && !dragging) {
      const pos = screenToCanvas(e.clientX, e.clientY);
      placePixel(pos.x, pos.y);
    }
    dragging = false;
  }

  function handleWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 2 : 0.5;
    const newZoom = Math.max(0.25, Math.min(64, zoom * factor));
    const cx = e.clientX;
    const cy = e.clientY;
    pan.x = cx - (cx - pan.x) * (newZoom / zoom);
    pan.y = cy - (cy - pan.y) * (newZoom / zoom);
    onZoomChange(newZoom);
  }

  // --- Touch handlers (pinch-zoom, drag-pan, long-press to place) ---

  function getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  function handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      touchStartTime = Date.now();
      touchMoved = false;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
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
      pan.x += dx;
      pan.y += dy;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      render();
    } else if (e.touches.length === 2) {
      touchMoved = true;
      const dist = getTouchDist(e.touches);
      const center = getTouchCenter(e.touches);
      const scale = dist / lastTouchDist;
      const newZoom = Math.max(0.25, Math.min(64, zoom * scale));

      // Zoom toward pinch center
      pan.x = center.x - (center.x - pan.x) * (newZoom / zoom);
      pan.y = center.y - (center.y - pan.y) * (newZoom / zoom);

      // Pan with pinch movement
      pan.x += center.x - lastMouse.x;
      pan.y += center.y - lastMouse.y;

      lastTouchDist = dist;
      lastMouse = center;
      onZoomChange(newZoom);
    }
  }

  function handleTouchEnd(e) {
    // Long-press to place pixel (>300ms, no movement, single touch)
    if (!touchMoved && e.changedTouches.length === 1) {
      const elapsed = Date.now() - touchStartTime;
      if (elapsed > 300) {
        const t = e.changedTouches[0];
        const pos = screenToCanvas(t.clientX, t.clientY);
        placePixel(pos.x, pos.y);
      }
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
      const buffer = await res.arrayBuffer();
      const indices = decodeCanvas(buffer);
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
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    style="cursor: {dragging ? 'grabbing' : 'crosshair'}; touch-action: none"
  ></canvas>
</div>

<style>
  .canvas-container {
    width: 100%;
    height: 100%;
  }

  canvas {
    display: block;
  }

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
