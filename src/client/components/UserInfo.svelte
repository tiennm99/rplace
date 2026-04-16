<script>
  import { MAX_CREDITS } from '../../lib/constants.js';

  let { credits } = $props();
</script>

<div class="user-info">
  <div class="credits">
    <span class="label">Pixels</span>
    <span class="value">{credits}</span>
    <span class="max">/ {MAX_CREDITS}</span>
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
  }

  .credits {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 0.9rem;
  }

  .label { color: #888; }

  .value {
    font-weight: bold;
    color: #4ade80;
    font-variant-numeric: tabular-nums;
  }

  .max {
    color: #555;
    font-size: 0.8rem;
  }
</style>
