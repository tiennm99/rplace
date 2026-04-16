<script>
  import { MAX_CREDITS, CREDIT_REGEN_RATE } from '../lib/constants.js';
  import CanvasRenderer from './components/CanvasRenderer.svelte';
  import ColorPicker from './components/ColorPicker.svelte';
  import CanvasControls from './components/CanvasControls.svelte';
  import UserInfo from './components/UserInfo.svelte';

  let selectedColor = $state(27); // black
  let credits = $state(MAX_CREDITS);
  let cursorPos = $state({ x: 0, y: 0 });
  let zoom = $state(1);

  /** @type {CanvasRenderer} */
  let canvasRenderer;

  // Client-side credit regeneration (server corrects on placement)
  $effect(() => {
    const interval = setInterval(() => {
      if (credits < MAX_CREDITS) {
        credits = Math.min(credits + CREDIT_REGEN_RATE, MAX_CREDITS);
      }
    }, 1000);
    return () => clearInterval(interval);
  });

  // WebSocket connection with auto-reconnect + exponential backoff
  let wsRetryDelay = 1000;

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/ws`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pixels' && canvasRenderer) {
          canvasRenderer.applyUpdates(data.pixels);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onopen = () => { wsRetryDelay = 1000; };
    ws.onclose = () => {
      setTimeout(connectWebSocket, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 30000);
    };
    ws.onerror = () => ws.close();

    return ws;
  }

  $effect(() => {
    const ws = connectWebSocket();
    return () => ws.close();
  });
</script>

<main>
  <CanvasRenderer
    bind:this={canvasRenderer}
    {selectedColor}
    {credits}
    onCreditsChange={(c) => credits = c}
    {zoom}
    onZoomChange={(z) => zoom = z}
    onCursorMove={(pos) => cursorPos = pos}
  />
  <CanvasControls
    {zoom}
    onZoomIn={() => zoom = Math.min(zoom * 2, 64)}
    onZoomOut={() => zoom = Math.max(zoom / 2, 0.25)}
    onResetZoom={() => zoom = 1}
    {cursorPos}
  />
  <ColorPicker {selectedColor} onSelect={(i) => selectedColor = i} />
  <UserInfo {credits} />
</main>

<style>
  main {
    width: 100%;
    height: 100%;
    position: relative;
  }
</style>
