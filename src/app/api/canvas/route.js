import { gzipSync } from 'zlib';
import { getFullCanvas } from '@/lib/canvas-storage';

/**
 * GET /api/canvas — returns the full canvas as gzipped binary.
 * Client decodes 5-bit packed pixels from the raw bytes.
 */
export async function GET() {
  const buffer = await getFullCanvas();
  const gzipped = gzipSync(buffer);

  return new Response(gzipped, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'public, max-age=1, s-maxage=1, stale-while-revalidate=5',
    },
  });
}
