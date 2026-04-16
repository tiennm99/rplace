<script>
  let { zoom, onZoomIn, onZoomOut, onResetZoom, cursorPos } = $props();

  let zoomLabel = $derived(
    zoom >= 1 ? `${zoom}x` : `1/${1 / zoom}x`
  );
</script>

<div class="controls">
  <div class="zoom">
    <button onclick={onZoomOut} title="Zoom out">−</button>
    <span class="level">{zoomLabel}</span>
    <button onclick={onZoomIn} title="Zoom in">+</button>
    <button onclick={onResetZoom} title="Reset zoom">⟲</button>
  </div>
  <div class="coords">({cursorPos.x}, {cursorPos.y})</div>
</div>

<style>
  .controls {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    z-index: 10;
  }

  .zoom {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .zoom button {
    width: 28px;
    height: 28px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #fff;
    cursor: pointer;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .zoom button:hover {
    background: #555;
  }

  .level {
    min-width: 40px;
    text-align: center;
    font-size: 0.85rem;
    color: #ccc;
  }

  .coords {
    font-size: 0.85rem;
    color: #aaa;
    font-variant-numeric: tabular-nums;
  }
</style>
