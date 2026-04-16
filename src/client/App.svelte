<script>
  import { MAX_CREDITS, CREDIT_REGEN_RATE } from '../lib/constants.js';
  import CanvasRenderer from './components/CanvasRenderer.svelte';
  import ColorPicker from './components/ColorPicker.svelte';
  import CanvasControls from './components/CanvasControls.svelte';
  import DrawToolbar from './components/DrawToolbar.svelte';
  import UserInfo from './components/UserInfo.svelte';

  let selectedColor = $state(27); // black
  let credits = $state(MAX_CREDITS);
  let cursorPos = $state({ x: 0, y: 0 });
  let zoom = $state(1);
  let mode = $state('paint');
  let submitting = $state(false);
  let bufferState = $state({ canUndo: false, canRedo: false, pixelCount: 0 });

  /** @type {CanvasRenderer} */
  let canvasRenderer;

  // Client-side credit regeneration (server corrects on submit)
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

  // Keyboard shortcuts
  function handleKeyDown(e) {
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      canvasRenderer?.undo();
    } else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      canvasRenderer?.redo();
    }
  }

  // Submit all pending pixels to server
  async function handleSubmit() {
    const pixels = canvasRenderer?.getPendingPixels();
    if (!pixels?.length) return;

    submitting = true;
    try {
      const res = await fetch('/api/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels }),
      });
      const data = await res.json();
      if (data.ok) {
        credits = data.credits;
        canvasRenderer.commitPending();
      } else {
        console.warn('Submit rejected:', data.error, data);
      }
    } catch (err) {
      console.error('Submit failed:', err);
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<main>
  <CanvasRenderer
    bind:this={canvasRenderer}
    {selectedColor}
    {zoom}
    {mode}
    onZoomChange={(z) => zoom = z}
    onCursorMove={(pos) => cursorPos = pos}
    onBufferChange={(s) => bufferState = s}
  />
  <CanvasControls
    {zoom}
    onZoomIn={() => zoom = Math.min(zoom * 2, 64)}
    onZoomOut={() => zoom = Math.max(zoom / 2, 0.25)}
    onResetZoom={() => zoom = 1}
    {cursorPos}
  />
  <DrawToolbar
    {mode}
    onModeChange={(m) => mode = m}
    onSubmit={handleSubmit}
    onUndo={() => canvasRenderer?.undo()}
    onRedo={() => canvasRenderer?.redo()}
    onClear={() => canvasRenderer?.clearPending()}
    canUndo={bufferState.canUndo}
    canRedo={bufferState.canRedo}
    pixelCount={bufferState.pixelCount}
    {submitting}
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
