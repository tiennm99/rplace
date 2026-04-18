/**
 * Browser-side RPC wrapper around the pipeline web worker.
 *
 * Responsibilities:
 *   - Own the Worker's lifetime (`dispose()` terminates it).
 *   - Copy the source buffer before transferring, so the caller's
 *     reference to `srcRgba` stays alive for save/restore flows.
 *   - Stamp every request with a monotonic id and drop responses
 *     whose id is older than the latest one seen (stale-coalescing).
 *   - Surface results via `onResult` / errors via `onError`.
 *
 * The worker maintains stage-level caches internally, so a slider drag
 * that only moves one input reuses upstream stages automatically.
 */
export function createPipelineClient() {
  const worker = new Worker(
    new URL('./image-pipeline-worker.js', import.meta.url),
    { type: 'module' },
  );

  let nextId = 0;
  let lastResultId = -1;
  let resultHandler = null;
  let errorHandler = null;

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'result') {
      if (m.id <= lastResultId) return; // stale
      lastResultId = m.id;
      resultHandler?.(m);
    } else if (m.type === 'error') {
      errorHandler?.(m);
    }
  };

  return {
    /** Register a callback invoked with the newest `result` message. */
    onResult(fn) { resultHandler = fn; },
    /** Register a callback invoked with `error` messages. */
    onError(fn) { errorHandler = fn; },

    /**
     * Push a new source image to the worker. The buffer is cloned so the
     * caller retains ownership of the original.
     * @param {Uint8Array|Uint8ClampedArray} rgba
     * @param {number} width
     * @param {number} height
     */
    setSource(rgba, width, height) {
      const copy = new Uint8ClampedArray(rgba);
      worker.postMessage({
        type: 'set-source',
        id: ++nextId,
        width, height,
        buffer: copy.buffer,
      }, [copy.buffer]);
    },

    /**
     * Queue a pipeline run. `quick` is a free-form tag the worker echoes
     * back in the result so the caller can tell preview tiers apart.
     */
    run(params, { quick = false } = {}) {
      const id = ++nextId;
      worker.postMessage({ type: 'run', id, params, quick });
      return id;
    },

    dispose() { worker.terminate(); },
  };
}
