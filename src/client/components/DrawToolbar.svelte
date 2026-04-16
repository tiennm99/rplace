<script>
  let { mode, onModeChange, onSubmit, onUndo, onRedo, onClear,
        canUndo, canRedo, pixelCount, submitting } = $props();
</script>

<div class="toolbar">
  <div class="group">
    <button class:active={mode === 'paint'} onclick={() => onModeChange('paint')}
      title="Paint mode: click to place pixel">Paint</button>
    <button class:active={mode === 'draw'} onclick={() => onModeChange('draw')}
      title="Draw mode: drag to draw, right-drag to pan">Draw</button>
  </div>

  <div class="group">
    <button onclick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
    <button onclick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">Redo</button>
    <button class="clear-btn" onclick={onClear} disabled={pixelCount === 0}
      title="Clear all pending pixels">Clear</button>
  </div>

  <button class="submit-btn" onclick={onSubmit} disabled={pixelCount === 0 || submitting}>
    {submitting ? 'Sending...' : `Submit${pixelCount > 0 ? ` (${pixelCount})` : ''}`}
  </button>
</div>

<style>
  .toolbar {
    position: fixed;
    bottom: 70px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    z-index: 10;
  }

  .group {
    display: flex;
    gap: 4px;
  }

  button {
    padding: 6px 12px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #ccc;
    cursor: pointer;
    font-size: 0.85rem;
    white-space: nowrap;
  }

  button:hover:not(:disabled) { background: #555; }
  button:disabled { opacity: 0.4; cursor: default; }

  button.active {
    background: #4a6;
    border-color: #4a6;
    color: #fff;
  }

  .clear-btn:hover:not(:disabled) {
    background: #a33;
    border-color: #a33;
  }

  .submit-btn {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
    font-weight: bold;
  }

  .submit-btn:hover:not(:disabled) { background: #1d4ed8; }
</style>
