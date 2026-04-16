import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvasRoom } from '../../src/durable-objects/canvas-room.js';

/** Create a mock WebSocket */
function mockWebSocket() {
  return { send: vi.fn(), close: vi.fn() };
}

/** Create a mock Durable Object state with Hibernation API */
function mockState() {
  const sockets = new Set();
  return {
    acceptWebSocket: vi.fn((ws) => sockets.add(ws)),
    getWebSockets: vi.fn(() => [...sockets]),
    _sockets: sockets,
  };
}

describe('CanvasRoom', () => {
  let state;
  let room;

  beforeEach(() => {
    state = mockState();
    room = new CanvasRoom(state);
  });

  describe('broadcast', () => {
    it('sends pixel data to all connected WebSockets', async () => {
      const ws1 = mockWebSocket();
      const ws2 = mockWebSocket();
      state._sockets.add(ws1);
      state._sockets.add(ws2);

      const pixels = [{ x: 10, y: 20, color: 5 }];
      const req = new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify(pixels),
      });

      const res = await room.fetch(req);
      expect(res.status).toBe(200);

      const expected = JSON.stringify({ type: 'pixels', pixels });
      expect(ws1.send).toHaveBeenCalledWith(expected);
      expect(ws2.send).toHaveBeenCalledWith(expected);
    });

    it('closes WebSocket on send failure', async () => {
      const ws = mockWebSocket();
      ws.send.mockImplementation(() => { throw new Error('disconnected'); });
      state._sockets.add(ws);

      const req = new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify([{ x: 0, y: 0, color: 1 }]),
      });

      const res = await room.fetch(req);
      expect(res.status).toBe(200);
      expect(ws.close).toHaveBeenCalledWith(1011, 'send failed');
    });

    it('broadcasts to empty room without error', async () => {
      const req = new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify([]),
      });

      const res = await room.fetch(req);
      expect(res.status).toBe(200);
    });
  });

  describe('webSocketClose', () => {
    it('closes the WebSocket with given code and reason', () => {
      const ws = mockWebSocket();
      room.webSocketClose(ws, 1000, 'normal', true);
      expect(ws.close).toHaveBeenCalledWith(1000, 'normal');
    });
  });

  describe('webSocketError', () => {
    it('closes the WebSocket with error code', () => {
      const ws = mockWebSocket();
      room.webSocketError(ws, new Error('test'));
      expect(ws.close).toHaveBeenCalledWith(1011, 'error');
    });
  });

  describe('webSocketMessage', () => {
    it('ignores messages (no-op)', () => {
      const ws = mockWebSocket();
      // Should not throw
      room.webSocketMessage(ws, 'hello');
      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});
