<script>
  import { COLORS, nearestPaletteIndex } from '../../lib/constants.js';

  let { selectedColor, onSelect } = $props();

  // Favorites strip — first 16 palette entries (the grayscale ramp) plus 8
  // saturated accents from the wheel for quick access.
  const FAVORITE_INDICES = [
    // 8 grays (from the 16-gray ramp at 0..15, spaced every 2 steps).
    0, 2, 5, 8, 11, 13, 14, 15,
    // 8 vivid accents (wheel indices 16..255, picked to span the hue circle).
    // 16 + (hue * 60) at lightness 65% (second ring), 7.5° hue steps.
    // We just pull 8 evenly spaced entries from the vivid ring.
    76, 84, 91, 99, 106, 114, 121, 128,
  ];

  let expanded = $state(false);
  let customInput = $state();
  let customHex = $state('#ffffff');

  function selectAndClose(i) {
    onSelect(i);
  }

  function openCustom() {
    customInput?.click();
  }

  function onCustomChange(e) {
    const hex = e.currentTarget.value;
    customHex = hex;
    const n = parseInt(hex.slice(1), 16);
    const idx = nearestPaletteIndex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    onSelect(idx);
    expanded = true; // so user can see which palette swatch got picked
  }
</script>

<div class="color-picker">
  <div class="strip">
    {#each FAVORITE_INDICES as i (i)}
      <button
        class="swatch"
        class:selected={i === selectedColor}
        style="background-color: {COLORS[i]}"
        onclick={() => selectAndClose(i)}
        title="Color {i}: {COLORS[i]}"
        aria-label="Select color {COLORS[i]}"
      ></button>
    {/each}
    <div class="divider"></div>
    <button class="current" style="background-color: {COLORS[selectedColor]}"
      title="Current: {COLORS[selectedColor]} (index {selectedColor})" aria-label="Current color"></button>
    <button class="toggle" onclick={() => expanded = !expanded}
      title={expanded ? 'Hide full palette' : 'Show full palette'}
      aria-expanded={expanded}>
      {expanded ? '▾' : '▸'}
    </button>
    <button class="custom" onclick={openCustom} title="Pick any RGB — snapped to nearest palette color">
      Custom
    </button>
    <input
      bind:this={customInput}
      type="color"
      value={customHex}
      onchange={onCustomChange}
      aria-hidden="true"
      tabindex="-1"
      style="position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;"
    />
  </div>

  {#if expanded}
    <div class="grid" role="listbox" aria-label="Full 256-color palette">
      {#each COLORS as hex, i (i)}
        <button
          class="cell"
          class:selected={i === selectedColor}
          style="background-color: {hex}"
          onclick={() => selectAndClose(i)}
          title="Color {i}: {hex}"
          aria-label="Select color {hex}"
          aria-selected={i === selectedColor}
          role="option"
        ></button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .color-picker {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 10px;
    backdrop-filter: blur(8px);
    z-index: 10;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  }

  .strip { display: flex; align-items: center; gap: 4px; }

  .swatch {
    width: 28px;
    height: 28px;
    border: 2px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: transform 0.1s;
    padding: 0;
  }
  .swatch:hover { transform: scale(1.2); z-index: 1; }
  .swatch.selected {
    border-color: #fff;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.5);
    transform: scale(1.1);
  }

  .divider { width: 1px; height: 20px; background: #444; margin: 0 4px; }

  .current {
    width: 32px; height: 32px;
    border: 2px solid #888;
    border-radius: 6px;
    cursor: default;
    padding: 0;
  }

  .toggle, .custom {
    padding: 4px 10px;
    background: #262626;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .toggle { min-width: 30px; }
  .toggle:hover, .custom:hover { background: #333; }

  .grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 2px;
    max-width: calc(16 * 22px + 15 * 2px);
  }
  .cell {
    width: 22px;
    height: 22px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
    transition: transform 0.08s;
  }
  .cell:hover {
    transform: scale(1.3);
    z-index: 2;
    border-color: rgba(255, 255, 255, 0.6);
  }
  .cell.selected {
    border-color: #fff;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6);
    transform: scale(1.15);
    z-index: 1;
  }
</style>
