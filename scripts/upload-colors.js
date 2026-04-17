#!/usr/bin/env node
/**
 * Upload rplace palette JSON to the canvas at (x, y).
 *
 * Usage:
 *   node scripts/upload-colors.js <data.json> <x> <y> [--url=http://localhost:8787] [--batch=256] [--dry]
 *
 * Respects the server's credit bucket: starts assuming MAX_CREDITS, tracks regen
 * locally between batches, and on 429 waits `retryAfter` seconds before retry.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  CANVAS_WIDTH, CANVAS_HEIGHT,
  MAX_BATCH_SIZE, MAX_CREDITS, CREDIT_REGEN_RATE,
} from '../src/lib/constants.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string', default: 'http://localhost:8787' },
    batch: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (positionals.length < 3) {
  console.error('Usage: node scripts/upload-colors.js <data.json> <x> <y> [--url=http://localhost:8787] [--batch=256] [--dry]');
  process.exit(1);
}

const [dataPath, xArg, yArg] = positionals;
const originX = parseInt(xArg, 10);
const originY = parseInt(yArg, 10);
const batchSize = Math.max(1, Math.min(parseInt(values.batch ?? String(MAX_BATCH_SIZE), 10), MAX_BATCH_SIZE));
const apiUrl = values.url.replace(/\/+$/, '');
const dry = values.dry;

if (!Number.isInteger(originX) || !Number.isInteger(originY)) {
  console.error('x and y must be integers');
  process.exit(1);
}

const { width, height, pixels } = JSON.parse(await readFile(dataPath, 'utf8'));

if (
  originX < 0 || originY < 0 ||
  originX + width > CANVAS_WIDTH ||
  originY + height > CANVAS_HEIGHT
) {
  console.error(`Image ${width}x${height} at (${originX},${originY}) exceeds canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`);
  process.exit(1);
}

const toSend = [];
for (let i = 0; i < pixels.length; i++) {
  const color = pixels[i];
  if (color < 0) continue;
  const lx = i % width;
  const ly = (i / width) | 0;
  toSend.push({ x: originX + lx, y: originY + ly, color });
}

console.log(`Placing ${toSend.length} pixels (image ${width}x${height} at ${originX},${originY}), batch=${batchSize}`);

if (dry) {
  console.log('Dry run, no requests sent.');
  process.exit(0);
}

await upload(toSend);

async function upload(allPixels) {
  let credits = MAX_CREDITS;
  let lastUpdate = Date.now();
  let placed = 0;
  const started = Date.now();

  for (let i = 0; i < allPixels.length; ) {
    const batch = allPixels.slice(i, i + batchSize);

    // Refresh local credit estimate with elapsed regen.
    const now = Date.now();
    credits = Math.min(MAX_CREDITS, credits + ((now - lastUpdate) / 1000) * CREDIT_REGEN_RATE);
    lastUpdate = now;

    if (credits < batch.length) {
      const waitSec = Math.ceil((batch.length - credits) / CREDIT_REGEN_RATE);
      console.log(`  waiting ${waitSec}s for credits (${credits.toFixed(1)}/${batch.length})`);
      await sleep(waitSec * 1000);
      credits = Math.min(MAX_CREDITS, credits + waitSec * CREDIT_REGEN_RATE);
      lastUpdate = Date.now();
    }

    let res;
    try {
      res = await fetch(`${apiUrl}/api/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels: batch }),
      });
    } catch (err) {
      console.error(`  network error: ${err.message}, retrying in 3s`);
      await sleep(3000);
      continue;
    }

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.max(1, body.retryAfter ?? 2);
      console.log(`  rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      credits = 0;
      lastUpdate = Date.now();
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }

    const body = await res.json();
    if (typeof body.credits === 'number') {
      credits = body.credits;
      lastUpdate = Date.now();
    } else {
      credits = Math.max(0, credits - batch.length);
    }

    i += batch.length;
    placed += batch.length;
    const pct = ((placed / allPixels.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  [${placed}/${allPixels.length}] ${pct}% credits=${credits} elapsed=${elapsed}s`);
  }

  const total = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`Done. Placed ${placed} pixels in ${total}s`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
