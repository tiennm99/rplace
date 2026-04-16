import { getUpdatesSince } from '@/lib/sse-broadcaster';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** SSE polling interval in ms */
const POLL_INTERVAL = 500;

/** Max SSE connection duration before client must reconnect (25s for Vercel) */
const MAX_DURATION = 25000;

/**
 * GET /api/canvas/stream?since=<timestamp>
 * Server-Sent Events endpoint for real-time pixel updates.
 * Polls Redis sorted set and streams new entries to clients.
 */
export async function GET(request) {
  const url = new URL(request.url);
  let since = parseInt(url.searchParams.get('since') || '0', 10);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const startTime = Date.now();

      const poll = async () => {
        // Check if client disconnected or max duration reached
        if (request.signal.aborted || Date.now() - startTime > MAX_DURATION) {
          controller.close();
          return;
        }

        try {
          const updates = await getUpdatesSince(since + 1);
          if (updates.length > 0) {
            // Update the since cursor to latest timestamp
            since = updates[updates.length - 1].ts;
            const data = JSON.stringify(updates);
            controller.enqueue(
              encoder.encode(`data: ${data}\n\n`),
            );
          }
        } catch (err) {
          // Send error event, don't crash the stream
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${err.message}\n\n`),
          );
        }

        setTimeout(poll, POLL_INTERVAL);
      };

      // Send initial connection event
      controller.enqueue(encoder.encode(`data: {"connected":true}\n\n`));
      poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
