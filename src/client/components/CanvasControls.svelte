<script>
  import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../../lib/constants.js';

  let { zoom, onZoomIn, onZoomOut, onResetZoom, onGoto, cursorPos,
        wsState = 'connecting', onHelp } = $props();

  const wsLabel = $derived({
    open: 'Live',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    closed: 'Offline',
  }[wsState] ?? wsState);

  let zoomLabel = $derived(
    zoom >= 1 ? `${zoom}x` : `1/${1 / zoom}x`
  );

  let gotoValue = $state('');

  function handleGoto() {
    // Accept "x,y", "x, y", "x y" — tolerant of common separators.
    const parts = gotoValue.split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) return;
    const [x, y] = parts;
    if (x < 0 || y < 0 || x >= CANVAS_WIDTH || y >= CANVAS_HEIGHT) return;
    onGoto?.(x, y);
  }

  function handleGotoKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); handleGoto(); }
  }
</script>

<div class="controls">
  <span class="ws {wsState}" title={wsLabel} aria-label="Connection: {wsLabel}"></span>
  <div class="zoom">
    <button onclick={onZoomOut} title="Zoom out (E)">−</button>
    <span class="level">{zoomLabel}</span>
    <button onclick={onZoomIn} title="Zoom in (Q)">+</button>
    <button onclick={onResetZoom} title="Reset zoom">⟲</button>
  </div>
  <div class="coords">({cursorPos.x}, {cursorPos.y})</div>
  <form class="goto" onsubmit={(e) => { e.preventDefault(); handleGoto(); }}>
    <input
      type="text"
      placeholder="x,y"
      value={gotoValue}
      oninput={(e) => gotoValue = e.currentTarget.value}
      onkeydown={handleGotoKey}
      title="Go to canvas coordinate (e.g. 1024,1024)"
      aria-label="Go to coordinates"
    />
    <button type="submit" title="Jump to coordinates (Enter)">go</button>
  </form>
  <button class="help" onclick={onHelp} title="Keyboard shortcuts (?)" aria-label="Show keyboard shortcuts">?</button>
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

  .goto {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .goto input {
    width: 84px;
    padding: 4px 6px;
    background: #1a1a1a;
    border: 1px solid #444;
    color: #eee;
    border-radius: 4px;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .goto input::placeholder { color: #666; }
  .goto button {
    padding: 4px 10px;
    background: #333;
    color: #ddd;
    border: 1px solid #555;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .goto button:hover { background: #555; }

  .ws {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #666;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
    flex-shrink: 0;
  }
  .ws.open { background: #22c55e; }
  .ws.connecting, .ws.reconnecting { background: #eab308; animation: pulse 1.2s infinite; }
  .ws.closed { background: #ef4444; }
  @keyframes pulse { 50% { opacity: 0.45; } }

  .help {
    width: 28px; height: 28px;
    border: 1px solid #555;
    border-radius: 50%;
    background: #333;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .help:hover { background: #555; }
</style>
