<script>
  import { MAX_BATCH_SIZE, REQUEST_COOLDOWN_SEC } from '../lib/constants.js';
  import CanvasRenderer from './components/CanvasRenderer.svelte';
  import ColorPicker from './components/ColorPicker.svelte';
  import CanvasControls from './components/CanvasControls.svelte';
  import DrawToolbar from './components/DrawToolbar.svelte';
  import ImageImporter from './components/ImageImporter.svelte';

  let selectedColor = $state(27); // black
  let cursorPos = $state({ x: 0, y: 0 });
  let zoom = $state(1);
  let mode = $state('paint');
  let submitting = $state(false);
  let bufferState = $state({ canUndo: false, canRedo: false, pixelCount: 0 });
  let toast = $state(null); // { kind: 'error'|'info', text: string }
  let toastTimer = null;
  let importerOpen = $state(false);

  // Pick-target handoff — ImageImporter calls requestPick() to register handlers;
  // a click on the canvas fires .pick(pos); Esc fires .cancel().
  /** @type {{pick: (pos: {x: number, y: number}) => void, cancel: () => void}|null} */
  let activePick = $state(null);

  // Submit cooldown — blocks Submit + shows countdown. Driven by successful
  // requests (forward-guess REQUEST_COOLDOWN_SEC) and 429 retryAfter responses.
  let cooldownUntil = $state(0);
  let nowTick = $state(Date.now());
  $effect(() => {
    if (cooldownUntil <= nowTick) return;
    const id = setInterval(() => { nowTick = Date.now(); }, 100);
    return () => clearInterval(id);
  });
  const cooldownMs = $derived(Math.max(0, cooldownUntil - nowTick));

  /** @type {CanvasRenderer} */
  let canvasRenderer;

  function showToast(kind, text, ttlMs = 4000) {
    toast = { kind, text };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, ttlMs);
  }

  function requestPick(handlers) {
    // Replace any in-flight pick (cancel it first so its owner resets UI).
    // handlers === null means "cancel current pick, no replacement".
    if (activePick) activePick.cancel();
    activePick = handlers ?? null;
  }

  function handleCanvasPick(pos) {
    const p = activePick;
    activePick = null;
    p?.pick(pos);
  }

  function cancelActivePick() {
    const p = activePick;
    activePick = null;
    p?.cancel();
  }

  // WebSocket connection with auto-reconnect + exponential backoff
  let wsRetryDelay = 1000;
  let isReconnect = false;

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

    ws.onopen = () => {
      // Refetch canvas after a reconnect to recover any pixels missed while disconnected.
      if (isReconnect && canvasRenderer) {
        canvasRenderer.refetchCanvas();
      }
      wsRetryDelay = 1000;
      isReconnect = true;
    };
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
  const PAN_STEP = 40;
  function handleKeyDown(e) {
    // Don't intercept when user is typing in an input
    if (e.target?.matches?.('input, textarea, [contenteditable]')) return;

    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      canvasRenderer?.undo();
      return;
    }
    if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      canvasRenderer?.redo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'Escape':
        if (activePick) { e.preventDefault(); cancelActivePick(); }
        else canvasRenderer?.cancelStrokeIfAny?.();
        return;
      case 'q': case 'Q':
        e.preventDefault();
        zoom = Math.min(zoom * 2, 64);
        return;
      case 'e': case 'E':
        e.preventDefault();
        zoom = Math.max(zoom / 2, 0.25);
        return;
      case 'w': case 'W':
        e.preventDefault(); canvasRenderer?.panBy(0, PAN_STEP); return;
      case 's': case 'S':
        e.preventDefault(); canvasRenderer?.panBy(0, -PAN_STEP); return;
      case 'a': case 'A':
        e.preventDefault(); canvasRenderer?.panBy(PAN_STEP, 0); return;
      case 'd': case 'D':
        e.preventDefault(); canvasRenderer?.panBy(-PAN_STEP, 0); return;
    }
  }

  // Submit all pending pixels to server
  async function handleSubmit() {
    const pixels = canvasRenderer?.getPendingPixels();
    if (!pixels?.length) return;
    if (pixels.length > MAX_BATCH_SIZE) {
      showToast('error', `Batch too large (${pixels.length} > ${MAX_BATCH_SIZE}). Submit fewer pixels.`);
      return;
    }

    submitting = true;
    try {
      const res = await fetch('/api/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels }),
      });

      let data = null;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { /* non-JSON body */ }

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = data?.retryAfter ?? REQUEST_COOLDOWN_SEC;
          cooldownUntil = Date.now() + retryAfter * 1000;
          nowTick = Date.now();
          showToast('error', `Rate limited — try again in ${retryAfter}s.`, 6000);
        } else if (res.status === 413) {
          showToast('error', 'Request too large. Reduce batch size.');
        } else if (res.status === 400) {
          showToast('error', `Rejected: ${data?.error || 'invalid request'}`);
        } else {
          showToast('error', `Server error (${res.status}): ${data?.error || text || 'unknown'}`);
        }
        return;
      }

      if (data?.ok) {
        canvasRenderer.commitPending();
        cooldownUntil = Date.now() + REQUEST_COOLDOWN_SEC * 1000;
        nowTick = Date.now();
        showToast('info', 'Submitted', 1500);
      } else {
        showToast('error', `Unexpected response: ${data?.error || 'no data'}`);
      }
    } catch (err) {
      showToast('error', `Network error: ${err.message || err}`, 6000);
    } finally {
      submitting = false;
    }
  }

  function handleBufferFull() {
    showToast('info', `Buffer at max (${MAX_BATCH_SIZE} pixels) — submit or undo to draw more.`, 3000);
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<main>
  <CanvasRenderer
    bind:this={canvasRenderer}
    {selectedColor}
    {zoom}
    {mode}
    pickActive={!!activePick}
    onPick={handleCanvasPick}
    onZoomChange={(z) => zoom = z}
    onCursorMove={(pos) => cursorPos = pos}
    onBufferChange={(s) => bufferState = s}
    onBufferFull={handleBufferFull}
  />
  <CanvasControls
    {zoom}
    onZoomIn={() => zoom = Math.min(zoom * 2, 64)}
    onZoomOut={() => zoom = Math.max(zoom / 2, 0.25)}
    onResetZoom={() => zoom = 1}
    onGoto={(x, y) => canvasRenderer?.gotoPoint(x, y)}
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
    {cooldownMs}
  />
  <ColorPicker {selectedColor} onSelect={(i) => selectedColor = i} />

  {#if !importerOpen}
    <button class="import-btn" onclick={() => importerOpen = true}
      title="Upload an image and place it on the canvas">
      Import Image
    </button>
  {/if}

  <ImageImporter
    open={importerOpen}
    getCommittedColor={(x, y) => canvasRenderer?.getCommittedColor(x, y) ?? -1}
    setOverlay={(o) => canvasRenderer?.setOverlay(o)}
    onRequestPick={requestPick}
    onClose={() => importerOpen = false}
  />

  {#if activePick}
    <div class="pick-banner" role="status" aria-live="polite">
      Click on the canvas to pick a position — Esc to cancel.
    </div>
  {/if}

  {#if toast}
    <div class="toast {toast.kind}" role="status" aria-live="polite">{toast.text}</div>
  {/if}
</main>

<style>
  main {
    width: 100%;
    height: 100%;
    position: relative;
  }
  .toast {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 0.95rem;
    z-index: 30;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    max-width: 90vw;
    text-align: center;
  }
  .toast.error { background: #8b2222; color: #fff; border: 1px solid #a33; }
  .toast.info { background: #1d3a8a; color: #fff; border: 1px solid #3b5cb8; }

  .pick-banner {
    position: fixed;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 14px;
    background: rgba(37, 99, 235, 0.92);
    color: #fff;
    border: 1px solid #3b82f6;
    border-radius: 8px;
    font-size: 0.9rem;
    z-index: 25;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .import-btn {
    position: fixed;
    top: 68px;
    right: 16px;
    padding: 8px 14px;
    background: rgba(37, 99, 235, 0.9);
    border: 1px solid #3b82f6;
    color: #fff;
    font-weight: 600;
    font-size: 0.9rem;
    border-radius: 8px;
    cursor: pointer;
    z-index: 15;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .import-btn:hover { background: #1d4ed8; }
</style>
