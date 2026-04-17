/**
 * Durable Object for WebSocket broadcast room.
 * Uses Hibernation API so connections survive DO eviction.
 */
export class CanvasRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal broadcast from worker
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const pixels = await request.json();
      const message = JSON.stringify({ type: 'pixels', pixels });
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(message);
        } catch (err) {
          console.warn('WS send failed, closing socket:', err?.message || err);
          ws.close(1011, 'send failed');
        }
      }
      return new Response('ok');
    }

    // WebSocket upgrade
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called when a WebSocket receives a message (required by Hibernation API).
   * Clients aren't expected to send anything in this protocol; close defensively. */
  webSocketMessage(ws) {
    ws.close(1003, 'unexpected client message');
  }

  /** Called when a WebSocket is closed. */
  webSocketClose(ws, code, reason, wasClean) {
    if (!wasClean) {
      console.warn(`WS unclean close: code=${code} reason=${reason || '<none>'}`);
    }
    // Required pre-2026-04-07 compat date; harmless after.
    ws.close(code, reason);
  }

  /** Called on WebSocket error. */
  webSocketError(ws, error) {
    console.error('WS error:', error?.message || error);
    ws.close(1011, 'error');
  }
}
