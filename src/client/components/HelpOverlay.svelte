<script>
  let { open, onClose } = $props();

  // Close on backdrop click or Esc. Esc is already intercepted at the
  // app level (to cancel picks/strokes), so we additionally match '?'
  // and '/' there. Here we just need click-outside to work.
  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose?.();
  }

  const ROWS = [
    { keys: ['click'], label: 'Place a pixel (paint mode)' },
    { keys: ['drag'], label: 'Draw a stroke (draw mode)' },
    { keys: ['right-drag', 'wheel-drag'], label: 'Pan the canvas' },
    { keys: ['scroll'], label: 'Zoom at cursor' },
    { keys: ['Q', 'E'], label: 'Zoom in / out' },
    { keys: ['W', 'A', 'S', 'D'], label: 'Pan' },
    { keys: ['I'], label: 'Toggle eyedropper' },
    { keys: ['Alt', '+', 'click'], label: 'Sample color (any mode)' },
    { keys: ['Ctrl', '+', 'Z'], label: 'Undo' },
    { keys: ['Ctrl', '+', 'Y'], label: 'Redo' },
    { keys: ['Esc'], label: 'Cancel pick / stroke / close dialogs' },
    { keys: ['?'], label: 'Toggle this help' },
  ];
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
    tabindex="-1" onclick={handleBackdrop}>
    <div class="sheet">
      <div class="head">
        <strong>Shortcuts</strong>
        <button class="x" onclick={onClose} aria-label="Close">✕</button>
      </div>
      <table>
        <tbody>
          {#each ROWS as row}
            <tr>
              <td class="keys">
                {#each row.keys as k, idx}
                  {#if idx > 0 && k !== '+'}<span class="plus">·</span>{/if}
                  {#if k === '+'}<span class="plus">+</span>
                  {:else}<kbd>{k}</kbd>{/if}
                {/each}
              </td>
              <td class="label">{row.label}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="foot">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
    backdrop-filter: blur(4px);
  }
  .sheet {
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    background: rgba(18, 18, 18, 0.98);
    border: 1px solid #3a3a3a;
    border-radius: 12px;
    padding: 14px 16px;
    color: #ddd;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .head strong { font-size: 1rem; }
  .x {
    background: transparent; border: 0; color: #aaa;
    font-size: 1.1rem; cursor: pointer; padding: 4px 8px;
  }
  .x:hover { color: #fff; }

  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  td { padding: 6px 4px; vertical-align: middle; }
  td.keys { white-space: nowrap; width: 1%; }
  td.label { color: #bbb; padding-left: 14px; }
  tr + tr td { border-top: 1px solid #222; }

  kbd {
    display: inline-block;
    padding: 2px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    color: #eee;
    background: #2a2a2a;
    border: 1px solid #444;
    border-bottom-width: 2px;
    border-radius: 4px;
    line-height: 1.2;
  }
  .plus { color: #666; padding: 0 3px; font-size: 0.8rem; }

  .foot {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #222;
    font-size: 0.78rem;
    color: #888;
    text-align: center;
  }
</style>
