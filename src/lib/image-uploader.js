import { MAX_BATCH_SIZE, REQUEST_COOLDOWN_SEC } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COOLDOWN_MS = REQUEST_COOLDOWN_SEC * 1000;

/**
 * Browser-side uploader for batches of pixels.
 * Server enforces 1 request per second per user (batch-size independent),
 * so we send batches up to MAX_BATCH_SIZE spaced by COOLDOWN_MS. On 429 we
 * back off using retryAfter. Pause/abort are cooperative.
 *
 * Lifecycle: create → await run(pixels) → resolves when finished or aborted.
 *
 * @param {Object} hooks
 * @param {(placed: number, total: number) => void} [hooks.onProgress]
 * @param {(message: string) => void} [hooks.onStatus] - human-readable status line
 * @param {(error: Error) => void} [hooks.onError] - recoverable errors (uploader retries)
 */
export function createImageUploader({ onProgress, onStatus, onError } = {}) {
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

  async function run(pixels) {
    aborted = false;
    paused = false;
    let placed = 0;
    const total = pixels.length;
    let nextSendAt = 0; // epoch ms; first send goes out immediately

    while (placed < total && !aborted) {
      await waitWhilePaused();
      if (aborted) break;

      const waitMs = nextSendAt - Date.now();
      if (waitMs > 0) {
        onStatus?.(`Waiting ${Math.ceil(waitMs / 1000)}s…`);
        await cooperativeSleep(waitMs);
        continue;
      }

      const batch = pixels.slice(placed, placed + MAX_BATCH_SIZE);
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

      placed += batch.length;
      onProgress?.(placed, total);
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
