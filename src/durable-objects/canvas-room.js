/**
 * Durable Object for WebSocket broadcast room.
 * Uses Hibernation API so connections survive DO eviction.
 */
export class CanvasRoom {
  constructor(state) {
    this.state = state;
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
        } catch {
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

  /** Called when a WebSocket receives a message (required by Hibernation API) */
  webSocketMessage(ws, message) {
    // Clients don't send messages in this protocol; ignore.
  }

  /** Called when a WebSocket is closed */
  webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, reason);
  }

  /** Called on WebSocket error */
  webSocketError(ws, error) {
    ws.close(1011, 'error');
  }
}
