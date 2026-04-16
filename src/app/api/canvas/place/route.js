import { NextResponse } from 'next/server';
import { setPixels } from '@/lib/canvas-storage';
import { getUserId } from '@/lib/get-user-id';
import { checkAndDeductCredits } from '@/lib/rate-limiter';
import { publishPixelUpdates } from '@/lib/sse-broadcaster';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  MAX_COLORS,
  MAX_BATCH_SIZE,
} from '@/lib/constants';

/**
 * POST /api/canvas/place — batch pixel placement.
 * Body: { pixels: [{x, y, color}] }
 * Returns: { ok, credits } or error with 400/429.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { pixels } = body;
  if (!Array.isArray(pixels) || pixels.length === 0) {
    return NextResponse.json({ error: 'pixels_required' }, { status: 400 });
  }
  if (pixels.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { error: 'batch_too_large', max: MAX_BATCH_SIZE },
      { status: 400 },
    );
  }

  // Validate each pixel
  for (const p of pixels) {
    if (
      typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.color !== 'number' ||
      p.x < 0 || p.x >= CANVAS_WIDTH ||
      p.y < 0 || p.y >= CANVAS_HEIGHT ||
      p.color < 0 || p.color >= MAX_COLORS ||
      !Number.isInteger(p.x) || !Number.isInteger(p.y) ||
      !Number.isInteger(p.color)
    ) {
      return NextResponse.json({ error: 'invalid_pixel', pixel: p }, { status: 400 });
    }
  }

  // Rate limiting
  const userId = getUserId(request);
  const { allowed, remaining, retryAfter } = await checkAndDeductCredits(
    userId,
    pixels.length,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: 'rate_limited', remaining, retryAfter },
      { status: 429 },
    );
  }

  // Write pixels to canvas
  await setPixels(pixels);

  // Broadcast updates for SSE consumers
  await publishPixelUpdates(pixels);

  return NextResponse.json({ ok: true, credits: remaining });
}
