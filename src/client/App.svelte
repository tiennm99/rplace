<script>
  import { MAX_CREDITS } from '../lib/constants.js';
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

  // WebSocket connection with auto-reconnect
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

    ws.onclose = () => setTimeout(connectWebSocket, 1000);
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
