import { MAX_BATCH_SIZE, REQUEST_COOLDOWN_SEC } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COOLDOWN_MS = REQUEST_COOLDOWN_SEC * 1000;
// Re-filter the remaining pixel list every N batches. Cheap vs. a full scan
// per batch, and catches other users painting over the same region mid-upload.
const PROGRESSIVE_SKIP_EVERY = 8;

/**
 * Browser-side uploader for batches of pixels.
 * Server enforces 1 request per second per user (batch-size independent),
 * so we send batches up to MAX_BATCH_SIZE spaced by COOLDOWN_MS. On 429 we
 * back off using retryAfter. Pause/abort are cooperative.
 *
 * Lifecycle: create → await run(pixels, opts) → resolves when finished or aborted.
 *
 * @param {Object} hooks
 * @param {(placed: number, total: number) => void} [hooks.onProgress]
 * @param {(message: string) => void} [hooks.onStatus] - human-readable status line
 * @param {(error: Error) => void} [hooks.onError] - recoverable errors (uploader retries)
 * @param {(pixel: {x:number,y:number,color:number}) => boolean} [hooks.shouldSkip]
 *   Optional. Every PROGRESSIVE_SKIP_EVERY batches we re-run this predicate over
 *   the remaining pixels and drop those that return true. Used to skip pixels the
 *   canvas already matches after concurrent edits.
 * @param {(placed: number) => void} [hooks.onCheckpoint]
 *   Fired after every completed batch with the running `placed` count, so callers
 *   can persist progress for auto-resume.
 */
export function createImageUploader({ onProgress, onStatus, onError, shouldSkip, onCheckpoint } = {}) {
  let aborted = false;
  let paused = false;

  async function waitWhilePaused() {
    while (paused && !aborted) await sleep(150);
  }

  /** Interruptible sleep — wakes on abort; pause is handled by the outer loop. */
  async function cooperativeSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !aborted && !paused) {
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  /**
   * @param {Array<{x:number,y:number,color:number}>} pixels - full ordered pixel list for this job
   * @param {{startPlaced?: number}} [opts] - resume offset into pixels (pixels before this index are skipped)
   */
  async function run(pixels, { startPlaced = 0 } = {}) {
    aborted = false;
    paused = false;
    const total = pixels.length;
    let remaining = pixels.slice(Math.min(startPlaced, total));
    let placed = Math.min(startPlaced, total);
    let batchCount = 0;
    let nextSendAt = 0; // epoch ms; first send goes out immediately

    onProgress?.(placed, total);

    while (remaining.length > 0 && !aborted) {
      await waitWhilePaused();
      if (aborted) break;

      // Progressive skip — re-filter remaining against the predicate.
      if (shouldSkip && batchCount > 0 && batchCount % PROGRESSIVE_SKIP_EVERY === 0) {
        const before = remaining.length;
        remaining = remaining.filter((p) => !shouldSkip(p));
        const dropped = before - remaining.length;
        if (dropped > 0) {
          placed += dropped;
          onStatus?.(`Skipped ${dropped} already-matching pixel${dropped === 1 ? '' : 's'}.`);
          onProgress?.(placed, total);
          onCheckpoint?.(placed);
          if (remaining.length === 0) break;
        }
      }

      const waitMs = nextSendAt - Date.now();
      if (waitMs > 0) {
        onStatus?.(`Waiting ${Math.ceil(waitMs / 1000)}s…`);
        await cooperativeSleep(waitMs);
        continue;
      }

      const batch = remaining.slice(0, MAX_BATCH_SIZE);
      onStatus?.(`Sending ${batch.length} pixels…`);

      let res;
      try {
        res = await fetch('/api/place', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pixels: batch }),
        });
      } catch (err) {
        onError?.(err);
        onStatus?.(`Network error, retrying in 3s…`);
        await cooperativeSleep(3000);
        continue;
      }

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const waitSec = Math.max(1, body.retryAfter ?? REQUEST_COOLDOWN_SEC);
        onStatus?.(`Rate limited, waiting ${waitSec}s…`);
        nextSendAt = Date.now() + waitSec * 1000;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${text}`);
        onError?.(err);
        return { placed, total, aborted: false, error: err };
      }

      remaining = remaining.slice(batch.length);
      placed += batch.length;
      batchCount += 1;
      onProgress?.(placed, total);
      onCheckpoint?.(placed);
      nextSendAt = Date.now() + COOLDOWN_MS;
    }

    return { placed, total, aborted };
  }

  return {
    run,
    pause() { paused = true; },
    resume() { paused = false; },
    abort() { aborted = true; paused = false; },
    get isPaused() { return paused; },
    get isAborted() { return aborted; },
  };
}
