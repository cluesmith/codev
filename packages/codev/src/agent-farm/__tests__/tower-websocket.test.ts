/**
 * Unit tests for tower-websocket.ts (Spec 0105 Phase 5)
 *
 * Tests: handleTerminalWebSocket frame bridging (data, control, resize, ping/pong,
 * resume, replay, close/error cleanup) and setupUpgradeHandler routing
 * (direct /ws/terminal/:id, workspace-scoped /workspace/:path/ws/terminal/:id,
 * invalid paths, bad base64, missing sessions).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { handleTerminalWebSocket, setupUpgradeHandler } from '../servers/tower-websocket.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getTerminalManager: () => ({
    getSession: mockGetSession,
  }),
}));

vi.mock('../servers/tower-utils.js', () => ({
  normalizeWorkspacePath: (p: string) => p,
}));

// ============================================================================
// Helpers
// ============================================================================

function makeWs(): any {
  const ws = new EventEmitter();
  (ws as any).readyState = 1; // WebSocket.OPEN
  (ws as any).send = vi.fn();
  (ws as any).OPEN = 1;
  return ws;
}

function makeSession(): any {
  return {
    attach: vi.fn(() => []),
    attachResume: vi.fn(() => []),
    detach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  };
}

function makeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as any;
}

/**
 * Encode a data frame (0x01 prefix + payload) matching ws-protocol.ts format.
 */
function encodeDataFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const frame = Buffer.allocUnsafe(1 + payload.length);
  frame[0] = 0x01;
  payload.copy(frame, 1);
  return frame;
}

/**
 * Encode a control frame (0x00 prefix + JSON payload) matching ws-protocol.ts format.
 */
function encodeControlFrame(msg: Record<string, unknown>): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf-8');
  const frame = Buffer.allocUnsafe(1 + payload.length);
  frame[0] = 0x00;
  payload.copy(frame, 1);
  return frame;
}

// ============================================================================
// Tests
// ============================================================================

describe('tower-websocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // handleTerminalWebSocket
  // =========================================================================

  describe('handleTerminalWebSocket', () => {
    it('attaches client to session on connect', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      expect(session.attach).toHaveBeenCalledTimes(1);
    });

    it('uses attachResume when x-session-resume header is set', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq({ 'x-session-resume': '42' });

      handleTerminalWebSocket(ws, session, req);

      expect(session.attachResume).toHaveBeenCalledWith(expect.anything(), 42);
      expect(session.attach).not.toHaveBeenCalled();
    });

    it('sends replay data on connect', () => {
      const ws = makeWs();
      const session = makeSession();
      session.attach.mockReturnValue(['line1', 'line2']);
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      // Should send encoded replay data
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('skips replay when no lines', () => {
      const ws = makeWs();
      const session = makeSession();
      session.attach.mockReturnValue([]);
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('writes data frames to session', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      // Emit a data frame (0x01 prefix)
      ws.emit('message', encodeDataFrame('hello'));

      expect(session.write).toHaveBeenCalledWith('hello');
    });

    it('handles resize control frames', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      ws.emit('message', encodeControlFrame({
        type: 'resize',
        payload: { cols: 120, rows: 40 },
      }));

      expect(session.resize).toHaveBeenCalledWith(120, 40);
    });

    it('handles ping control frames with pong', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      ws.emit('message', encodeControlFrame({
        type: 'ping',
        payload: {},
      }));

      // Should send a pong response
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('falls back to raw UTF-8 on decode error', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      // Send raw text without protocol prefix — will fail decode, fallback to UTF-8
      ws.emit('message', Buffer.from('raw text'));

      expect(session.write).toHaveBeenCalledWith('raw text');
    });

    it('detaches client on close', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      ws.emit('close');

      expect(session.detach).toHaveBeenCalledTimes(1);
    });

    it('detaches client on error', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      ws.emit('error');

      expect(session.detach).toHaveBeenCalledTimes(1);
    });

    it('does not send when ws is not OPEN', () => {
      const ws = makeWs();
      ws.readyState = 3; // CLOSED
      const session = makeSession();
      session.attach.mockReturnValue(['replay-line']);
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      // Should not try to send replay when connection is closed
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('drops data frames when WebSocket bufferedAmount exceeds high water mark (Bugfix #313)', () => {
      const ws = makeWs();
      const session = makeSession();
      const req = makeReq();

      handleTerminalWebSocket(ws, session, req);

      // Get the client adapter that was passed to session.attach
      const client = session.attach.mock.calls[0][0];

      // Normal send should work
      ws.bufferedAmount = 0;
      client.send('small data');
      expect(ws.send).toHaveBeenCalledTimes(1);

      // Send with bufferedAmount above 1MB threshold should be dropped
      ws.send.mockClear();
      ws.bufferedAmount = 2 * 1024 * 1024; // 2MB
      client.send('large data that should be dropped');
      expect(ws.send).not.toHaveBeenCalled();

      // Should resume sending after buffer drains
      ws.send.mockClear();
      ws.bufferedAmount = 0;
      client.send('resumed data');
      expect(ws.send).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // setupUpgradeHandler
  // =========================================================================

  describe('setupUpgradeHandler', () => {
    function makeServer(): any {
      return new EventEmitter();
    }

    function makeWss(): any {
      return {
        handleUpgrade: vi.fn((_req: unknown, _socket: unknown, _head: unknown, cb: (ws: any) => void) => {
          cb(makeWs());
        }),
      };
    }

    function makeSocket(): any {
      return {
        write: vi.fn(),
        destroy: vi.fn(),
      };
    }

    it('routes /ws/terminal/:id to session', () => {
      const server = makeServer();
      const wss = makeWss();
      const session = makeSession();
      mockGetSession.mockReturnValue(session);

      setupUpgradeHandler(server, wss, 4100);

      const socket = makeSocket();
      server.emit('upgrade', { url: '/ws/terminal/term-1', headers: {} }, socket, Buffer.alloc(0));

      expect(mockGetSession).toHaveBeenCalledWith('term-1');
      expect(wss.handleUpgrade).toHaveBeenCalled();
    });

    it('returns 404 for /ws/terminal/:id with unknown session', () => {
      const server = makeServer();
      const wss = makeWss();
      mockGetSession.mockReturnValue(null);

      setupUpgradeHandler(server, wss, 4100);

      const socket = makeSocket();
      server.emit('upgrade', { url: '/ws/terminal/unknown-id', headers: {} }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('routes workspace-scoped /workspace/:path/ws/terminal/:id', () => {
      const server = makeServer();
      const wss = makeWss();
      const session = makeSession();
      mockGetSession.mockReturnValue(session);

      setupUpgradeHandler(server, wss, 4100);

      // Encode "/test/workspace" as base64url
      const encodedPath = Buffer.from('/test/workspace').toString('base64url');
      const socket = makeSocket();
      server.emit('upgrade', {
        url: `/workspace/${encodedPath}/ws/terminal/term-2`,
        headers: {},
      }, socket, Buffer.alloc(0));

      expect(mockGetSession).toHaveBeenCalledWith('term-2');
      expect(wss.handleUpgrade).toHaveBeenCalled();
    });

    it('returns 404 for non-workspace, non-terminal WS paths', () => {
      const server = makeServer();
      const wss = makeWss();

      setupUpgradeHandler(server, wss, 4100);

      const socket = makeSocket();
      server.emit('upgrade', { url: '/some/random/path', headers: {} }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('returns 400 for missing encoded path', () => {
      const server = makeServer();
      const wss = makeWss();

      setupUpgradeHandler(server, wss, 4100);

      const socket = makeSocket();
      server.emit('upgrade', { url: '/workspace//ws/terminal/t1', headers: {} }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('returns 400 for invalid base64url path', () => {
      const server = makeServer();
      const wss = makeWss();

      setupUpgradeHandler(server, wss, 4100);

      // "relative/path" is valid base64url but decodes to non-absolute path
      const encodedPath = Buffer.from('relative/path').toString('base64url');
      const socket = makeSocket();
      server.emit('upgrade', {
        url: `/workspace/${encodedPath}/ws/terminal/t1`,
        headers: {},
      }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('returns 404 for workspace path without terminal route', () => {
      const server = makeServer();
      const wss = makeWss();

      setupUpgradeHandler(server, wss, 4100);

      const encodedPath = Buffer.from('/test/workspace').toString('base64url');
      const socket = makeSocket();
      server.emit('upgrade', {
        url: `/workspace/${encodedPath}/some/other/path`,
        headers: {},
      }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('returns 404 for workspace-scoped route with unknown session', () => {
      const server = makeServer();
      const wss = makeWss();
      mockGetSession.mockReturnValue(null);

      setupUpgradeHandler(server, wss, 4100);

      const encodedPath = Buffer.from('/test/workspace').toString('base64url');
      const socket = makeSocket();
      server.emit('upgrade', {
        url: `/workspace/${encodedPath}/ws/terminal/unknown`,
        headers: {},
      }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });
  });
});
