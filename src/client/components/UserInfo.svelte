<script>
  import { MAX_CREDITS } from '../../lib/constants.js';

  let { credits } = $props();

  let fillPercent = $derived(Math.round((credits / MAX_CREDITS) * 100));
  let isFull = $derived(credits >= MAX_CREDITS);
</script>

<div class="user-info">
  <div class="credits">
    <span class="label">Pixels</span>
    <span class="value" class:full={isFull}>{credits}</span>
    <span class="max">/ {MAX_CREDITS}</span>
  </div>
  <div class="bar-track">
    <div
      class="bar-fill"
      class:full={isFull}
      style="width: {fillPercent}%"
    ></div>
  </div>
</div>

<style>
  .user-info {
    position: fixed;
    top: 16px;
    left: 16px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    z-index: 10;
    min-width: 120px;
  }

  .credits {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 0.9rem;
    margin-bottom: 6px;
  }

  .label { color: #888; }

  .value {
    font-weight: bold;
    color: #fbbf24;
    font-variant-numeric: tabular-nums;
    transition: color 0.3s;
  }

  .value.full { color: #4ade80; }

  .max {
    color: #555;
    font-size: 0.8rem;
  }

  .bar-track {
    width: 100%;
    height: 4px;
    background: #333;
    border-radius: 2px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: #fbbf24;
    border-radius: 2px;
    transition: width 0.3s ease, background-color 0.3s;
  }

  .bar-fill.full {
    background: #4ade80;
  }
</style>
