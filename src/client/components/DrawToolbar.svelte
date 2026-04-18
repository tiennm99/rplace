<script>
  let { mode, onModeChange, onSubmit, onUndo, onRedo, onClear,
        canUndo, canRedo, pixelCount, submitting, cooldownMs = 0 } = $props();

  const onCooldown = $derived(cooldownMs > 0);
  const cooldownLabel = $derived(`${(cooldownMs / 1000).toFixed(cooldownMs >= 1000 ? 0 : 1)}s`);
</script>

<div class="toolbar">
  <div class="group">
    <button class:active={mode === 'paint'} onclick={() => onModeChange('paint')}
      title="Paint mode: click to place pixel">Paint</button>
    <button class:active={mode === 'draw'} onclick={() => onModeChange('draw')}
      title="Draw mode: drag to draw, right-drag to pan">Draw</button>
  </div>

  <div class="sep"></div>

  <div class="group">
    <button onclick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
    <button onclick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">Redo</button>
    <button class="clear-btn" onclick={onClear} disabled={pixelCount === 0}
      title="Clear all pending pixels">Clear</button>
  </div>

  <div class="sep"></div>

  <button class="submit-btn" onclick={onSubmit}
    disabled={pixelCount === 0 || submitting || onCooldown}
    title={onCooldown ? `Cooldown — ${cooldownLabel} left` : 'Submit pending pixels'}>
    {#if submitting}Sending...
    {:else if onCooldown}Wait {cooldownLabel}
    {:else}Submit{pixelCount > 0 ? ` (${pixelCount})` : ''}{/if}
  </button>
</div>

<style>
  .toolbar {
    position: fixed;
    bottom: 188px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.9);
    border-radius: 12px;
    backdrop-filter: blur(8px);
    z-index: 10;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  }

  .group { display: flex; gap: 4px; }

  .sep {
    width: 1px;
    height: 28px;
    background: #444;
    margin: 0 2px;
  }

  button {
    min-width: 44px;
    min-height: 44px;
    padding: 8px 16px;
    border: 1px solid #555;
    border-radius: 8px;
    background: #333;
    color: #ccc;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
  }

  button:hover:not(:disabled) { background: #4a4a4a; }

  button:active:not(:disabled) {
    background: #555;
    transform: scale(0.97);
  }

  button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  button.active {
    background: #2d7a47;
    border-color: #3a9e5c;
    color: #fff;
  }

  .clear-btn:hover:not(:disabled) {
    background: #8b2222;
    border-color: #a33;
  }

  .submit-btn {
    min-width: 80px;
    background: #2563eb;
    border-color: #3b82f6;
    color: #fff;
    font-weight: 700;
    font-size: 0.95rem;
  }

  .submit-btn:hover:not(:disabled) { background: #1d4ed8; }

  @media (max-width: 600px) {
    .toolbar {
      padding: 6px 8px;
      gap: 4px;
    }
    button {
      min-width: 40px;
      padding: 8px 10px;
      font-size: 0.8rem;
    }
  }
</style>
