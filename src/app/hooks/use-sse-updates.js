'use client';

import { useEffect, useRef } from 'react';

/**
 * Custom hook for SSE pixel updates.
 * Auto-reconnects when the stream closes (Vercel 25s limit).
 * @param {function} onBatch - callback receiving array of {pixels, ts}
 */
export function useSSEUpdates(onBatch) {
  const sinceRef = useRef(Date.now());
  const onBatchRef = useRef(onBatch);
  onBatchRef.current = onBatch;

  useEffect(() => {
    let es;
    let reconnectTimer;

    function connect() {
      es = new EventSource(`/api/canvas/stream?since=${sinceRef.current}`);

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Skip connection confirmation
          if (data.connected) return;

          // data is an array of {pixels, ts}
          if (Array.isArray(data)) {
            for (const batch of data) {
              if (batch.ts) sinceRef.current = batch.ts;
              onBatchRef.current(batch.pixels);
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        // Reconnect after a short delay
        reconnectTimer = setTimeout(connect, 1000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);
}
