<script>
  import { COLORS } from '../../lib/constants.js';

  let { selectedColor, onSelect } = $props();
</script>

<div class="color-picker">
  {#each COLORS as hex, i}
    <button
      class="swatch"
      class:selected={i === selectedColor}
      style="background-color: {hex}"
      onclick={() => onSelect(i)}
      title="Color {i}: {hex}"
      aria-label="Select color {hex}"
    ></button>
  {/each}
</div>

<style>
  .color-picker {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 4px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    z-index: 10;
  }

  .swatch {
    width: 32px;
    height: 32px;
    border: 2px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: transform 0.1s;
  }

  .swatch:hover {
    transform: scale(1.2);
    z-index: 1;
  }

  .swatch.selected {
    border-color: #fff;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.5);
    transform: scale(1.15);
  }
</style>
