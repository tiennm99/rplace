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

  /** Render ImageData onto visible canvas with current zoom/pan */
  function render() {
    if (!canvasEl || !imageData) return;
    const ctx = canvasEl.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

    const offscreen = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    offscreen.getContext('2d').putImageData(imageData, 0, 0);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
  }

  /** Convert screen coords to canvas pixel coords */
  function screenToCanvas(clientX, clientY) {
    return {
      x: Math.floor((clientX - pan.x) / zoom),
      y: Math.floor((clientY - pan.y) / zoom),
    };
  }

  /** Update a single pixel locally */
  function updatePixel(x, y, colorIndex) {
    if (!imageData) return;
    const color = COLORS_RGBA[colorIndex];
    const offset = (y * CANVAS_WIDTH + x) * 4;
    imageData.data[offset] = color[0];
    imageData.data[offset + 1] = color[1];
    imageData.data[offset + 2] = color[2];
    imageData.data[offset + 3] = color[3];
  }

  /** Place a pixel via API */
  async function placePixel(x, y) {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
    if (credits <= 0) return;

    // Optimistic update
    updatePixel(x, y, selectedColor);
    render();

    try {
      const res = await fetch('/api/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels: [{ x, y, color: selectedColor }] }),
      });
      const data = await res.json();
      if (data.ok) {
        onCreditsChange(data.credits);
      }
    } catch (err) {
      console.error('Failed to place pixel:', err);
    }
  }

  /** Apply pixel updates from WebSocket */
  export function applyUpdates(pixels) {
    for (const { x, y, color } of pixels) {
      updatePixel(x, y, color);
    }
    render();
  }

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

  // Re-render when zoom changes
  $effect(() => { zoom; render(); });

  onMount(async () => {
    // Size canvas to viewport
    function resize() {
      canvasEl.width = window.innerWidth;
      canvasEl.height = window.innerHeight;
      render();
    }
    resize();
    window.addEventListener('resize', resize);

    // Load full canvas
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
    style="cursor: {dragging ? 'grabbing' : 'crosshair'}"
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
