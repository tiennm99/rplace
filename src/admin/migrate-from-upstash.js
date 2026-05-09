import { getFullCanvas } from '../lib/canvas-storage.js';
import { TOTAL_PIXELS, CANVAS_WIDTH } from '../lib/constants.js';

/**
 * One-shot Upstash → DO migration. Reads the full canvas via the legacy
 * Upstash REST path, ships the raw bytes to the DO `/import` endpoint,
 * then verifies a few sample coordinates round-trip correctly.
 *
 * Removed entirely in Phase 4 of the canvas-on-do storage plan, along
 * with the @upstash/redis dependency.
 *
 * @param {object} env - Worker env (Upstash creds + CANVAS_ROOM binding)
 * @param {DurableObjectStub} roomStub
 * @param {{force?: boolean}} opts
 * @returns {Promise<Response>}
 */
export async function migrateFromUpstash(env, roomStub, { force = false } = {}) {
  let upstashBytes;
  try {
    upstashBytes = await getFullCanvas(env);
  } catch (err) {
    return Response.json({ error: 'upstash_read_failed', message: String(err) }, { status: 500 });
  }

  if (upstashBytes.length !== TOTAL_PIXELS) {
    return Response.json(
      {
        error: 'upstash_size_mismatch',
        expected: TOTAL_PIXELS,
        got: upstashBytes.length,
      },
      { status: 500 },
    );
  }

  const importUrl = force ? 'http://do/import?force=1' : 'http://do/import';
  const importRes = await roomStub.fetch(importUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: upstashBytes,
  });

  if (!importRes.ok) {
    const text = await importRes.text().catch(() => '');
    return Response.json(
      { error: 'do_import_failed', status: importRes.status, body: text },
      { status: 502 },
    );
  }

  // Round-trip verification: pull canvas back from the DO and compare a
  // handful of sampled bytes. Catches subtle byte-order or chunking bugs.
  const verifyRes = await roomStub.fetch('http://do/canvas');
  if (!verifyRes.ok) {
    return Response.json({ error: 'do_verify_read_failed' }, { status: 502 });
  }
  const doBytes = new Uint8Array(await verifyRes.arrayBuffer());

  const samples = pickSampleOffsets(upstashBytes);
  const mismatches = [];
  for (const offset of samples) {
    if (doBytes[offset] !== upstashBytes[offset]) {
      mismatches.push({ offset, upstash: upstashBytes[offset], do: doBytes[offset] });
    }
  }

  return Response.json({
    ok: mismatches.length === 0,
    bytes_imported: upstashBytes.length,
    samples_checked: samples.length,
    mismatches,
  });
}

/**
 * Pick byte offsets to verify post-migration. Includes corners, midpoints,
 * and (preferentially) up to 5 offsets where the source has a non-zero
 * value — those catch byte-order bugs that all-zero samples would miss.
 */
function pickSampleOffsets(srcBytes) {
  const offsets = new Set([
    0,                                               // (0, 0)
    CANVAS_WIDTH - 1,                                // first-row right edge
    TOTAL_PIXELS - 1,                                // last byte
    Math.floor(TOTAL_PIXELS / 2),                    // middle
    Math.floor(TOTAL_PIXELS / 2) + CANVAS_WIDTH + 1, // off-middle
  ]);

  // Add up to 5 non-zero offsets so we don't only check empty pixels.
  let found = 0;
  const stride = Math.max(1, Math.floor(TOTAL_PIXELS / 1000));
  for (let i = 0; i < TOTAL_PIXELS && found < 5; i += stride) {
    if (srcBytes[i] !== 0) {
      offsets.add(i);
      found++;
    }
  }

  return [...offsets];
}
