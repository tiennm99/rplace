import { MAX_BATCH_SIZE, MAX_CREDITS, CREDIT_REGEN_RATE } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Browser-side throttled uploader for batches of pixels.
 * Tracks credits locally (regen at CREDIT_REGEN_RATE/sec, capped at MAX_CREDITS),
 * backs off on 429, and yields control between batches so the UI stays responsive.
 *
 * Lifecycle: create → await run(pixels) → resolves when finished or aborted.
 * Call pause()/resume()/abort() from UI to steer.
 *
 * @param {Object} hooks
 * @param {(placed: number, total: number) => void} [hooks.onProgress]
 * @param {(credits: number) => void} [hooks.onCredits]
 * @param {(message: string) => void} [hooks.onStatus] - human-readable status line
 * @param {(error: Error) => void} [hooks.onError] - recoverable errors (uploader retries)
 */
export function createImageUploader({ onProgress, onCredits, onStatus, onError } = {}) {
  let aborted = false;
  let paused = false;

  async function waitWhilePaused() {
    while (paused && !aborted) await sleep(150);
  }

  async function run(pixels) {
    aborted = false;
    paused = false;
    let credits = MAX_CREDITS; // optimistic; server corrects on first response
    let lastUpdate = Date.now();
    let placed = 0;
    const total = pixels.length;

    while (placed < total && !aborted) {
      await waitWhilePaused();
      if (aborted) break;

      const batch = pixels.slice(placed, placed + MAX_BATCH_SIZE);

      // Refresh local credit estimate with elapsed regen.
      const now = Date.now();
      credits = Math.min(MAX_CREDITS, credits + ((now - lastUpdate) / 1000) * CREDIT_REGEN_RATE);
      lastUpdate = now;

      if (credits < batch.length) {
        const waitSec = Math.ceil((batch.length - credits) / CREDIT_REGEN_RATE);
        onStatus?.(`Waiting ${waitSec}s for credits…`);
        // Split sleep so pause/abort feel responsive.
        const end = Date.now() + waitSec * 1000;
        while (Date.now() < end && !aborted && !paused) {
          await sleep(Math.min(250, end - Date.now()));
        }
        continue; // re-check regen & pause on next loop
      }

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
        await sleep(3000);
        continue;
      }

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const wait = Math.max(1, body.retryAfter ?? 2);
        if (typeof body.remaining === 'number') onCredits?.(body.remaining);
        credits = 0;
        lastUpdate = Date.now();
        onStatus?.(`Rate limited, waiting ${wait}s…`);
        await sleep(wait * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${text}`);
        onError?.(err);
        // Non-recoverable: stop here so user sees the error.
        return { placed, total, aborted: false, error: err };
      }

      const body = await res.json().catch(() => ({}));
      if (typeof body.credits === 'number') {
        credits = body.credits;
        onCredits?.(body.credits);
        lastUpdate = Date.now();
      }

      placed += batch.length;
      onProgress?.(placed, total);
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
