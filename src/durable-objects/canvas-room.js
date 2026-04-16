/**
 * Durable Object for WebSocket broadcast room.
 * All connected clients receive pixel updates in real-time.
 */
export class CanvasRoom {
  constructor(state) {
    this.state = state;
    /** @type {Set<WebSocket>} */
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal broadcast from worker
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const pixels = await request.json();
      const message = JSON.stringify({ type: 'pixels', pixels });
      for (const ws of this.sessions) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }
      return new Response('ok');
    }

    // WebSocket upgrade
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.sessions.add(server);

    server.addEventListener('close', () => {
      this.sessions.delete(server);
    });

    server.addEventListener('error', () => {
      this.sessions.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
