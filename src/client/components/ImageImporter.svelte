<script>
  import { CANVAS_WIDTH, CANVAS_HEIGHT, MAX_BATCH_SIZE, REQUEST_COOLDOWN_SEC } from '../../lib/constants.js';
  import { DITHER_METHODS } from '../../lib/image-to-palette.js';
  import { createImageUploader } from '../../lib/image-uploader.js';
  import { createPipelineClient } from '../../lib/image-pipeline-client.js';
  import { onMount } from 'svelte';
  import {
    rgbaToDataUrl, dataUrlToRgba,
    saveJob, loadJob, updateJobProgress, clearJob,
  } from '../../lib/image-job-storage.js';

  let { open, getCommittedColor, setOverlay, onClose, onRequestPick } = $props();

  // True while THIS panel requested a pick and is still waiting for the result.
  let picking = $state(false);

  // Source image (decoded, held on main thread for save/restore only)
  let fileName = $state(null);
  let srcWidth = $state(0);
  let srcHeight = $state(0);
  /** @type {Uint8ClampedArray|null} */
  let srcRgba = $state(null);

  // Latest full-resolution quantized result. Used by overlay, buildPixels,
  // save-job, and validation. Quick-tier results do NOT overwrite this.
  /** @type {null | {indices: Int16Array, width: number, height: number, preview: ArrayBuffer}} */
  let paletteResult = $state(null);
  let opaqueCount = $state(0);

  // Latest preview buffer (from quick *or* full) for the 120×120 panel only.
  /** @type {null | {buffer: ArrayBuffer, width: number, height: number}} */
  let previewBuffer = $state(null);

  // Preview canvas
  let previewEl = $state();

  // Target position + options
  let originX = $state(0);
  let originY = $state(0);
  let skipMatching = $state(true);
  let ditherMethod = $state('none'); // see DITHER_METHODS
  let skipWhite = $state(false);
  let whiteThreshold = $state(230);
  let paintTransparent = $state(false);

  // Resize controls — init to source dims on file load
  let resizeW = $state(0);
  let resizeH = $state(0);
  let lockAspect = $state(true);
  let resampleMethod = $state('nearest'); // 'nearest' | 'bilinear' | 'box'

  // On-canvas overlay preview
  let showOverlay = $state(true);
  let overlayAlpha = $state(0.6);

  // Transforms
  let flipH = $state(false);
  let flipV = $state(false);
  let rotation = $state(0); // 0 | 90 | 180 | 270

  // Color correction
  let brightness = $state(0);    // -100..+100
  let contrast = $state(0);      // -100..+100
  let saturation = $state(0);    // -100..+100
  let gamma = $state(1);          // 0.1..3.0
  let correctionOpen = $state(false); // collapsible

  // Run state
  let status = $state('idle'); // 'idle' | 'running' | 'paused' | 'done' | 'error'
  let placed = $state(0);
  let total = $state(0);
  let statusText = $state('');
  let errorText = $state(null);
  /** @type {ReturnType<typeof createImageUploader>|null} */
  let uploader = null;

  // Resume banner for a prior unfinished job.
  /** @type {null | {placed: number, total: number, fileName: string, startedAt: number}} */
  let resumable = $state(null);

  // Current job's starting index into the built pixel list, used by the uploader
  // to skip pixels that were already placed before a refresh.
  let jobStartPlaced = 0;

  // Worker-backed pipeline. Lives for the component's lifetime.
  /** @type {ReturnType<typeof createPipelineClient>|null} */
  let client = null;

  // Drag-tier timers:
  //   quick: throttled (max one in-flight per QUICK_INTERVAL) while inputs churn,
  //          runs the pipeline at <= QUICK_MAX_DIM to feed the 120×120 preview panel.
  //   full:  debounced; fires once after inputs settle, updates the overlay + paletteResult.
  const QUICK_INTERVAL = 60;
  const FULL_DEBOUNCE = 180;
  const QUICK_MAX_DIM = 384;
  let quickScheduled = false;
  let lastQuickAt = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let fullTimer = null;

  onMount(() => {
    client = createPipelineClient();
    client.onResult(handleWorkerResult);
    client.onError((m) => { errorText = m.error || 'Pipeline error.'; });

    const j = loadJob();
    if (j && j.total > 0 && j.placed < j.total) {
      resumable = {
        placed: j.placed, total: j.total,
        fileName: j.fileName || '(image)',
        startedAt: j.startedAt || 0,
      };
    }

    return () => {
      client?.dispose();
      client = null;
      if (fullTimer) clearTimeout(fullTimer);
    };
  });

  function handleWorkerResult(m) {
    const indices = new Int16Array(m.indices);
    if (m.quick) {
      // Panel only — do not disturb overlay/buildPixels state.
      previewBuffer = { buffer: m.preview, width: m.width, height: m.height };
      return;
    }
    // Full tier: update everything.
    let count = 0;
    for (let i = 0; i < indices.length; i++) if (indices[i] >= 0) count++;
    opaqueCount = count;
    paletteResult = { indices, width: m.width, height: m.height, preview: m.preview };
    previewBuffer = { buffer: m.preview, width: m.width, height: m.height };
  }

  function quickDims(w, h) {
    const m = Math.max(w, h);
    if (m <= QUICK_MAX_DIM) return { w, h };
    const r = QUICK_MAX_DIM / m;
    return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
  }

  function buildParams(resizeW_, resizeH_) {
    return {
      flipH, flipV, rotation,
      resizeW: resizeW_, resizeH: resizeH_, resampleMethod,
      brightness, contrast, saturation, gamma,
      ditherMethod, skipWhite, whiteThreshold, paintTransparent,
    };
  }

  function scheduleQuick() {
    if (!client || !srcRgba || resizeW <= 0 || resizeH <= 0) return;
    if (quickScheduled) return;
    const now = Date.now();
    const delay = Math.max(0, QUICK_INTERVAL - (now - lastQuickAt));
    quickScheduled = true;
    setTimeout(() => {
      quickScheduled = false;
      lastQuickAt = Date.now();
      if (!client || !srcRgba || resizeW <= 0 || resizeH <= 0) return;
      const { w, h } = quickDims(resizeW, resizeH);
      // If already ≤ quick cap, skip — the full tier will cover it without aliasing.
      if (w === resizeW && h === resizeH) return;
      client.run(buildParams(w, h), { quick: true });
    }, delay);
  }

  function scheduleFull() {
    if (!client || !srcRgba || resizeW <= 0 || resizeH <= 0) return;
    if (fullTimer) clearTimeout(fullTimer);
    fullTimer = setTimeout(() => {
      fullTimer = null;
      if (!client || !srcRgba || resizeW <= 0 || resizeH <= 0) return;
      client.run(buildParams(resizeW, resizeH), { quick: false });
    }, FULL_DEBOUNCE);
  }

  /** Snapshot the current pipeline inputs into a job record (minus placed/total which are added later). */
  function buildJobRecord() {
    return {
      fileName,
      originX, originY,
      resizeW, resizeH, resampleMethod,
      ditherMethod, skipWhite, whiteThreshold, paintTransparent,
      flipH, flipV, rotation,
      brightness, contrast, saturation, gamma,
      skipMatching,
    };
  }

  async function saveJobStart(totalCount) {
    if (!srcRgba) return;
    const srcDataUrl = await rgbaToDataUrl(srcRgba, srcWidth, srcHeight);
    if (!srcDataUrl) return;
    const record = {
      ...buildJobRecord(),
      srcDataUrl, srcWidth, srcHeight,
      placed: jobStartPlaced,
      total: totalCount,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveJob(record);
  }

  function saveJobProgress(p) {
    updateJobProgress(p);
  }

  function clearSavedJob() {
    clearJob();
    resumable = null;
  }

  async function resumeJob() {
    const j = loadJob();
    if (!j || !j.srcDataUrl) { resumable = null; return; }

    errorText = null;
    const decoded = await dataUrlToRgba(j.srcDataUrl);
    if (!decoded) {
      errorText = 'Failed to decode saved image.';
      return;
    }

    // Restore source + config — the reactive pipeline will regenerate paletteResult.
    fileName = j.fileName ?? null;
    srcRgba = decoded.rgba;
    srcWidth = decoded.width;
    srcHeight = decoded.height;
    client?.setSource(decoded.rgba, decoded.width, decoded.height);
    originX = j.originX ?? 0;
    originY = j.originY ?? 0;
    resizeW = j.resizeW ?? decoded.width;
    resizeH = j.resizeH ?? decoded.height;
    resampleMethod = j.resampleMethod ?? 'nearest';
    ditherMethod = j.ditherMethod ?? 'none';
    skipWhite = !!j.skipWhite;
    whiteThreshold = j.whiteThreshold ?? 230;
    paintTransparent = !!j.paintTransparent;
    flipH = !!j.flipH;
    flipV = !!j.flipV;
    rotation = j.rotation ?? 0;
    brightness = j.brightness ?? 0;
    contrast = j.contrast ?? 0;
    saturation = j.saturation ?? 0;
    gamma = j.gamma ?? 1;
    skipMatching = j.skipMatching ?? true;

    jobStartPlaced = j.placed ?? 0;
    total = j.total ?? 0;
    placed = jobStartPlaced;
    resumable = null;
    statusText = `Resumed — ${placed}/${total} already placed.`;
    status = 'idle'; // user hits Start to continue
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    fileName = file.name;
    errorText = null;

    try {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      URL.revokeObjectURL(img.src);

      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w === 0 || h === 0) throw new Error('Empty image');

      const oc = new OffscreenCanvas(w, h);
      const octx = oc.getContext('2d');
      octx.drawImage(img, 0, 0);
      const { data } = octx.getImageData(0, 0, w, h);

      srcRgba = data;
      srcWidth = w;
      srcHeight = h;
      // Cap initial output to canvas bounds. A full-res photo (e.g. 6000×4000)
      // running through the palette pipeline on load would otherwise freeze
      // the main thread. User can still scale up via the W/H inputs.
      const maxW = Math.max(1, CANVAS_WIDTH - originX);
      const maxH = Math.max(1, CANVAS_HEIGHT - originY);
      const ratio = Math.min(maxW / w, maxH / h, 1);
      resizeW = Math.max(1, Math.floor(w * ratio));
      resizeH = Math.max(1, Math.floor(h * ratio));
      client?.setSource(data, w, h);
      // paletteResult recomputed reactively via $effect below.
    } catch (err) {
      errorText = `Failed to load image: ${err.message || err}`;
      srcRgba = null;
      paletteResult = null;
      previewBuffer = null;
      srcWidth = srcHeight = 0;
    }
  }

  // Trigger the worker pipeline whenever any relevant input changes.
  // The worker holds per-stage caches, so a single-slider drag only
  // recomputes the stages downstream of the change.
  $effect(() => {
    if (!srcRgba || resizeW <= 0 || resizeH <= 0) {
      paletteResult = null; previewBuffer = null; opaqueCount = 0;
      if (fullTimer) { clearTimeout(fullTimer); fullTimer = null; }
      return;
    }
    // Register reactive deps explicitly.
    void flipH; void flipV; void rotation;
    void resizeW; void resizeH; void resampleMethod;
    void brightness; void contrast; void saturation; void gamma;
    void ditherMethod; void skipWhite; void whiteThreshold; void paintTransparent;
    scheduleQuick();
    scheduleFull();
  });

  // Paint the latest preview buffer (quick or full) into the panel canvas.
  $effect(() => {
    if (!open || !previewEl || !previewBuffer) return;
    const { buffer, width, height } = previewBuffer;
    previewEl.width = width;
    previewEl.height = height;
    const ctx = previewEl.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
  });

  function onResizeWInput(e) {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1) return;
    resizeW = Math.min(CANVAS_WIDTH, v);
    if (lockAspect && srcWidth > 0) {
      resizeH = Math.max(1, Math.min(CANVAS_HEIGHT, Math.round(srcHeight * resizeW / srcWidth)));
    }
  }
  function onResizeHInput(e) {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1) return;
    resizeH = Math.min(CANVAS_HEIGHT, v);
    if (lockAspect && srcHeight > 0) {
      resizeW = Math.max(1, Math.min(CANVAS_WIDTH, Math.round(srcWidth * resizeH / srcHeight)));
    }
  }
  function fitToCanvas() {
    if (!srcWidth || !srcHeight) return;
    const maxW = Math.max(1, CANVAS_WIDTH - originX);
    const maxH = Math.max(1, CANVAS_HEIGHT - originY);
    const ratio = Math.min(maxW / srcWidth, maxH / srcHeight, 1);
    resizeW = Math.max(1, Math.floor(srcWidth * ratio));
    resizeH = Math.max(1, Math.floor(srcHeight * ratio));
  }
  function resetSize() {
    // Reset to post-transform source dims so resize stays consistent with the preview.
    const swap = rotation === 90 || rotation === 270;
    resizeW = swap ? srcHeight : srcWidth;
    resizeH = swap ? srcWidth : srcHeight;
  }

  function rotateBy(deltaCW) {
    rotation = ((rotation + deltaCW) % 360 + 360) % 360;
    // Swap resize dims so the output aspect tracks the rotation.
    const tmp = resizeW; resizeW = resizeH; resizeH = tmp;
  }
  function resetTransforms() {
    flipH = false;
    flipV = false;
    if (rotation !== 0) {
      const swap = rotation === 90 || rotation === 270;
      if (swap) { const tmp = resizeW; resizeW = resizeH; resizeH = tmp; }
      rotation = 0;
    }
  }

  function resetCorrection() {
    brightness = 0;
    contrast = 0;
    saturation = 0;
    gamma = 1;
  }

  // Push overlay state to the canvas renderer whenever its inputs change.
  // The overlay always uses the latest *full-tier* result (paletteResult),
  // so quick-tier previews never flash the canvas with low-res pixels.
  $effect(() => {
    if (!setOverlay) return;
    if (open && showOverlay && paletteResult) {
      setOverlay({
        x: originX, y: originY,
        width: paletteResult.width, height: paletteResult.height,
        indices: paletteResult.indices,
        alpha: overlayAlpha,
      });
    } else {
      setOverlay(null);
    }
    // On unmount, clear.
    return () => setOverlay?.(null);
  });

  function startPickOrigin() {
    if (picking) {
      // Second press = cancel the in-flight pick.
      onRequestPick?.(null);
      return;
    }
    picking = true;
    onRequestPick?.({
      pick: ({ x, y }) => { originX = x; originY = y; picking = false; },
      cancel: () => { picking = false; },
    });
  }

  function validatePlacement() {
    if (!paletteResult) return 'No image loaded, or still processing…';
    const { width, height } = paletteResult;
    if (!Number.isInteger(originX) || !Number.isInteger(originY)) return 'X and Y must be integers.';
    if (originX < 0 || originY < 0) return 'X and Y must be ≥ 0.';
    if (originX + width > CANVAS_WIDTH || originY + height > CANVAS_HEIGHT) {
      return `Image would overflow canvas (${CANVAS_WIDTH}x${CANVAS_HEIGHT}).`;
    }
    return null;
  }

  function buildPixels() {
    const pixels = [];
    if (!paletteResult) return pixels;
    const { indices, width } = paletteResult;
    for (let i = 0; i < indices.length; i++) {
      const color = indices[i];
      if (color < 0) continue;
      const lx = i % width;
      const ly = (i / width) | 0;
      const x = originX + lx;
      const y = originY + ly;
      if (skipMatching && getCommittedColor?.(x, y) === color) continue;
      pixels.push({ x, y, color });
    }
    return pixels;
  }

  async function start() {
    const err = validatePlacement();
    if (err) { errorText = err; return; }
    errorText = null;

    const pixels = buildPixels();
    if (pixels.length === 0) {
      statusText = 'Nothing to place (all pixels already match).';
      status = 'done';
      placed = 0; total = 0;
      clearSavedJob();
      return;
    }

    // If resuming, `jobStartPlaced` was set by resumeJob(); otherwise start fresh.
    total = pixels.length;
    placed = Math.min(jobStartPlaced, total);
    status = 'running';
    statusText = 'Starting…';

    uploader = createImageUploader({
      onProgress: (p) => { placed = p; },
      onStatus: (s) => { statusText = s; },
      onError: (e) => { errorText = e.message || String(e); },
      shouldSkip: skipMatching
        ? (p) => getCommittedColor?.(p.x, p.y) === p.color
        : undefined,
      onCheckpoint: (p) => { saveJobProgress(p); },
    });

    await saveJobStart(pixels.length);
    const result = await uploader.run(pixels, { startPlaced: placed });
    uploader = null;
    placed = result.placed;
    jobStartPlaced = 0;

    if (result.error) {
      status = 'error';
      statusText = `Stopped: ${result.error.message}`;
    } else if (result.aborted) {
      status = 'idle';
      statusText = `Cancelled after ${result.placed}/${result.total}.`;
    } else {
      status = 'done';
      statusText = `Done. Placed ${result.placed} pixels.`;
      clearSavedJob();
    }
  }

  function pause() { uploader?.pause(); status = 'paused'; statusText = 'Paused.'; }
  function resume() { uploader?.resume(); status = 'running'; statusText = 'Resuming…'; }
  function cancel() { uploader?.abort(); }

  function reset() {
    if (status === 'running' || status === 'paused') return;
    placed = 0; total = 0; status = 'idle'; statusText = ''; errorText = null;
  }

  const pct = $derived(total > 0 ? (placed / total) * 100 : 0);
  const etaSec = $derived(
    status === 'running' && total > placed
      ? Math.ceil((total - placed) / MAX_BATCH_SIZE) * REQUEST_COOLDOWN_SEC
      : null,
  );
</script>

{#if open}
  <div class="panel" role="dialog" aria-label="Image importer">
    <div class="head">
      <strong>Import Image</strong>
      <button class="x" onclick={onClose} aria-label="Close">✕</button>
    </div>

    {#if resumable}
      <div class="resume">
        <div class="resume-text">
          Unfinished job: <strong>{resumable.fileName}</strong>
          — {resumable.placed}/{resumable.total} placed.
        </div>
        <div class="resume-btns">
          <button class="primary" onclick={resumeJob}>Resume</button>
          <button onclick={clearSavedJob}>Discard</button>
        </div>
      </div>
    {/if}

    <div class="row">
      <label class="file-btn">
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleFile} />
        {fileName ? 'Change image…' : 'Choose image…'}
      </label>
      {#if fileName}<span class="file-name" title={fileName}>{fileName}</span>{/if}
    </div>

    {#if srcRgba}
      <div class="preview-row">
        <div class="preview-wrap">
          <canvas bind:this={previewEl} class="preview"></canvas>
        </div>
        <div class="meta">
          <div>source: {srcWidth} × {srcHeight}</div>
          <div>output: {resizeW} × {resizeH}</div>
          <div>{opaqueCount} / {resizeW * resizeH} opaque</div>
        </div>
      </div>

      <div class="row">
        <label>W <input type="number" min="1" max={CANVAS_WIDTH} value={resizeW} oninput={onResizeWInput} /></label>
        <label>H <input type="number" min="1" max={CANVAS_HEIGHT} value={resizeH} oninput={onResizeHInput} /></label>
        <label class="chk" title="Lock aspect ratio to source"><input type="checkbox" bind:checked={lockAspect} /> lock</label>
      </div>
      <div class="row">
        <label>Method
          <select bind:value={resampleMethod}>
            <option value="nearest">nearest</option>
            <option value="bilinear">bilinear</option>
            <option value="box">box</option>
          </select>
        </label>
        <button onclick={fitToCanvas} title="Fit within canvas at current origin">Fit</button>
        <button onclick={resetSize} title="Reset to post-transform source dimensions">1:1</button>
      </div>

      <div class="row">
        <span class="lbl">transform</span>
        <button onclick={() => flipH = !flipH} class:active={flipH} title="Flip horizontally">⇆</button>
        <button onclick={() => flipV = !flipV} class:active={flipV} title="Flip vertically">⇅</button>
        <button onclick={() => rotateBy(-90)} title="Rotate 90° counter-clockwise">⟲</button>
        <button onclick={() => rotateBy(90)} title="Rotate 90° clockwise">⟳</button>
        <span class="rot-label">{rotation}°</span>
        <button onclick={resetTransforms} title="Reset transforms" disabled={!flipH && !flipV && rotation === 0}>reset</button>
      </div>

      <div class="row">
        <label>X <input type="number" min="0" max={CANVAS_WIDTH - 1} bind:value={originX} /></label>
        <label>Y <input type="number" min="0" max={CANVAS_HEIGHT - 1} bind:value={originY} /></label>
        <button class:active={picking} onclick={startPickOrigin}
          title="Click on the canvas to set X/Y (Esc to cancel)">
          {picking ? 'Cancel pick…' : 'Pick on canvas'}
        </button>
      </div>

      <div class="row">
        <label class="checkbox" title="Show the palette-matched image on the main canvas at the target position.">
          <input type="checkbox" bind:checked={showOverlay} />
          Overlay
        </label>
        <label class="row" style="flex: 1; gap: 6px;">
          <span style="font-size: 0.8rem; color: #aaa;">opacity</span>
          <input type="range" min="0.1" max="1" step="0.05" bind:value={overlayAlpha} disabled={!showOverlay} />
          <span style="font-size: 0.8rem; color: #aaa; width: 28px;">{Math.round(overlayAlpha * 100)}%</span>
        </label>
      </div>

      <label class="row checkbox">
        <input type="checkbox" bind:checked={skipMatching} />
        Skip pixels that already match
      </label>

      <div class="row">
        <label class="checkbox">
          <input type="checkbox" bind:checked={skipWhite} />
          Skip white
        </label>
        {#if skipWhite}
          <label style="flex: 1;">
            threshold
            <input type="range" min="128" max="255" step="1" bind:value={whiteThreshold} />
            <span class="val" style="min-width: 28px;">{whiteThreshold}</span>
          </label>
        {/if}
      </div>

      <label class="row checkbox" title="Treat fully-transparent source pixels as opaque white before quantizing.">
        <input type="checkbox" bind:checked={paintTransparent} />
        Paint transparent as white
      </label>
      <div class="row">
        <label>Dither
          <select bind:value={ditherMethod} title="error-diffusion (floyd/atkinson/…) or ordered (bayer-*)">
            {#each DITHER_METHODS as m}
              <option value={m}>{m}</option>
            {/each}
          </select>
        </label>
      </div>

      <div class="section">
        <button class="section-head" onclick={() => correctionOpen = !correctionOpen}>
          {correctionOpen ? '▾' : '▸'} Color correction
          {#if brightness || contrast || saturation || gamma !== 1}<span class="badge">on</span>{/if}
        </button>
        {#if correctionOpen}
          <div class="slider-row">
            <span class="lbl">brightness</span>
            <input type="range" min="-100" max="100" step="1" bind:value={brightness} />
            <span class="val">{brightness}</span>
          </div>
          <div class="slider-row">
            <span class="lbl">contrast</span>
            <input type="range" min="-100" max="100" step="1" bind:value={contrast} />
            <span class="val">{contrast}</span>
          </div>
          <div class="slider-row">
            <span class="lbl">saturation</span>
            <input type="range" min="-100" max="100" step="1" bind:value={saturation} />
            <span class="val">{saturation}</span>
          </div>
          <div class="slider-row">
            <span class="lbl">gamma</span>
            <input type="range" min="0.1" max="3" step="0.05" bind:value={gamma} />
            <span class="val">{gamma.toFixed(2)}</span>
          </div>
          <div class="row">
            <button onclick={resetCorrection}
              disabled={!brightness && !contrast && !saturation && gamma === 1}>Reset</button>
          </div>
        {/if}
      </div>

      {#if total > 0}
        <div class="progress">
          <div class="bar"><div class="fill" style="width: {pct}%"></div></div>
          <div class="prog-text">
            {placed} / {total} ({pct.toFixed(1)}%){etaSec != null ? ` — ~${etaSec}s left` : ''}
          </div>
        </div>
      {/if}

      {#if statusText}<div class="status">{statusText}</div>{/if}
      {#if errorText}<div class="error">{errorText}</div>{/if}

      <div class="controls">
        {#if status === 'idle' || status === 'done' || status === 'error'}
          <button class="primary" onclick={start} disabled={!paletteResult}>Start</button>
          {#if status !== 'idle'}<button onclick={reset}>Reset</button>{/if}
        {:else if status === 'running'}
          <button onclick={pause}>Pause</button>
          <button class="danger" onclick={cancel}>Cancel</button>
        {:else if status === 'paused'}
          <button class="primary" onclick={resume}>Resume</button>
          <button class="danger" onclick={cancel}>Cancel</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .panel {
    position: fixed;
    top: 64px;
    right: 12px;
    width: 320px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    background: rgba(10, 10, 10, 0.95);
    border: 1px solid #3a3a3a;
    border-radius: 12px;
    padding: 12px;
    color: #ddd;
    font-size: 0.9rem;
    z-index: 20;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .head { display: flex; justify-content: space-between; align-items: center; }
  .x {
    background: transparent; border: 0; color: #aaa; font-size: 1.2rem;
    cursor: pointer; padding: 4px 8px;
  }
  .x:hover { color: #fff; }

  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row.checkbox { gap: 6px; cursor: pointer; }

  .resume {
    display: flex; flex-direction: column; gap: 8px;
    padding: 8px 10px;
    background: rgba(59, 130, 246, 0.15);
    border: 1px solid #3b82f6;
    border-radius: 8px;
    font-size: 0.82rem;
  }
  .resume-text { color: #cde; }
  .resume-btns { display: flex; gap: 6px; }
  .resume-btns button {
    padding: 4px 12px; background: #262626; color: #ddd;
    border: 1px solid #444; border-radius: 4px; cursor: pointer;
    font-size: 0.85rem;
  }
  .resume-btns button:hover { background: #333; }
  .resume-btns button.primary { background: #2563eb; border-color: #3b82f6; color: #fff; }
  .resume-btns button.primary:hover { background: #1d4ed8; }

  label { display: flex; align-items: center; gap: 6px; }
  input[type="number"] { width: 70px; padding: 4px 6px; background: #1a1a1a; border: 1px solid #444; color: #eee; border-radius: 4px; }
  select { padding: 4px 6px; background: #1a1a1a; border: 1px solid #444; color: #eee; border-radius: 4px; }
  .chk { font-size: 0.8rem; color: #aaa; cursor: pointer; }
  .lbl { font-size: 0.8rem; color: #888; min-width: 56px; }
  .rot-label { font-size: 0.8rem; color: #aaa; min-width: 32px; text-align: center; }

  .row button {
    padding: 4px 10px; background: #262626; color: #ddd;
    border: 1px solid #444; border-radius: 4px; cursor: pointer;
    font-size: 0.85rem;
  }
  .row button:hover:not(:disabled) { background: #333; }
  .row button:disabled { opacity: 0.35; cursor: default; }
  .row button.active { background: #2d4d78; border-color: #3b6ba8; color: #fff; }

  .section { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #2a2a2a; padding-top: 8px; }
  .section-head {
    display: flex; align-items: center; gap: 6px; padding: 2px 0;
    background: transparent; border: 0; color: #ddd; cursor: pointer;
    font-size: 0.9rem; text-align: left;
  }
  .section-head:hover { color: #fff; }
  .badge { background: #2d4d78; color: #fff; font-size: 0.7rem; padding: 1px 6px; border-radius: 8px; }

  .slider-row { display: flex; align-items: center; gap: 8px; }
  .slider-row input[type="range"] { flex: 1; }
  .slider-row .val { font-size: 0.8rem; color: #aaa; min-width: 34px; text-align: right; }

  .file-btn {
    display: inline-block; padding: 6px 12px; background: #2563eb; border-radius: 6px;
    cursor: pointer; color: #fff; font-weight: 500;
  }
  .file-btn:hover { background: #1d4ed8; }
  .file-btn input { display: none; }
  .file-name { color: #aaa; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; max-width: 180px; white-space: nowrap; }

  .preview-row { display: flex; gap: 10px; align-items: flex-start; }
  .preview-wrap {
    width: 120px; height: 120px; background: #0a0a0a; border: 1px solid #333;
    border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .preview { image-rendering: pixelated; max-width: 100%; max-height: 100%; }
  .meta { font-size: 0.8rem; color: #aaa; display: flex; flex-direction: column; gap: 4px; }

  .progress { display: flex; flex-direction: column; gap: 4px; }
  .bar { height: 8px; background: #222; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: #2563eb; transition: width 0.2s; }
  .prog-text { font-size: 0.8rem; color: #bbb; }

  .status { font-size: 0.85rem; color: #9cf; }
  .error { font-size: 0.85rem; color: #f88; background: rgba(139, 34, 34, 0.3); padding: 6px 8px; border-radius: 4px; }

  .controls { display: flex; gap: 6px; flex-wrap: wrap; }
  .controls button {
    padding: 6px 14px; background: #333; color: #ddd;
    border: 1px solid #555; border-radius: 6px; cursor: pointer;
  }
  .controls button:hover { background: #444; }
  .controls button.primary { background: #2563eb; border-color: #3b82f6; color: #fff; }
  .controls button.primary:hover { background: #1d4ed8; }
  .controls button.danger { background: #8b2222; border-color: #a33; color: #fff; }
  .controls button.danger:hover { background: #a33; }
  .controls button:disabled { opacity: 0.4; cursor: default; }
</style>
