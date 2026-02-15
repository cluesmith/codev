/**
 * WebSocket terminal handler for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 5
 *
 * Contains: bidirectional WS ↔ PTY frame bridging and
 * WebSocket upgrade routing (direct + workspace-scoped).
 */

import http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeData, encodeControl, decodeFrame } from '../../terminal/ws-protocol.js';
import type { PtySession } from '../../terminal/pty-session.js';
import { getTerminalManager } from './tower-terminals.js';
import { normalizeWorkspacePath } from './tower-utils.js';

// ============================================================================
// Frame bridging — WS ↔ PTY
// ============================================================================

/**
 * Handle WebSocket connection to a terminal session.
 * Uses hybrid binary protocol (Spec 0085):
 * - 0x00 prefix: Control frame (JSON)
 * - 0x01 prefix: Data frame (raw PTY bytes)
 */
export function handleTerminalWebSocket(ws: WebSocket, session: PtySession, req: http.IncomingMessage): void {
  const resumeSeq = req.headers['x-session-resume'];

  // Create a client adapter for the PTY session
  // Uses binary protocol for data frames
  const client = {
    send: (data: Buffer | string) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Encode as binary data frame (0x01 prefix)
        ws.send(encodeData(data));
      }
    },
  };

  // Attach client to session and get replay data
  let replayLines: string[];
  if (resumeSeq && typeof resumeSeq === 'string') {
    replayLines = session.attachResume(client, parseInt(resumeSeq, 10));
  } else {
    replayLines = session.attach(client);
  }

  // Send replay data as binary data frame
  if (replayLines.length > 0) {
    const replayData = replayLines.join('\n');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeData(replayData));
    }
  }

  // Handle incoming messages from client (binary protocol)
  ws.on('message', (rawData: Buffer) => {
    try {
      const frame = decodeFrame(Buffer.from(rawData));

      if (frame.type === 'data') {
        // Write raw input to terminal
        session.write(frame.data.toString('utf-8'));
      } else if (frame.type === 'control') {
        // Handle control messages
        const msg = frame.message;
        if (msg.type === 'resize') {
          const cols = msg.payload.cols as number;
          const rows = msg.payload.rows as number;
          if (typeof cols === 'number' && typeof rows === 'number') {
            session.resize(cols, rows);
          }
        } else if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeControl({ type: 'pong', payload: {} }));
          }
        }
      }
    } catch {
      // If decode fails, try treating as raw UTF-8 input (for simpler clients)
      try {
        session.write(rawData.toString('utf-8'));
      } catch {
        // Ignore malformed input
      }
    }
  });

  ws.on('close', () => {
    session.detach(client);
  });

  ws.on('error', () => {
    session.detach(client);
  });
}

// ============================================================================
// WebSocket upgrade routing
// ============================================================================

/**
 * Set up the WebSocket upgrade handler on the HTTP server.
 * Parses upgrade requests and routes them to the appropriate terminal session:
 * - Direct route: /ws/terminal/:id
 * - Workspace-scoped route: /workspace/:encodedPath/ws/terminal/:id
 */
export function setupUpgradeHandler(
  server: http.Server,
  wss: WebSocketServer,
  port: number,
): void {
  server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

    // Phase 2: Handle /ws/terminal/:id routes directly
    const terminalMatch = reqUrl.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (terminalMatch) {
      const terminalId = terminalMatch[1];
      const manager = getTerminalManager();
      const session = manager.getSession(terminalId);

      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalWebSocket(ws, session, req);
      });
      return;
    }

    // Phase 4 (Spec 0090): Handle workspace WebSocket routes directly
    // Route: /workspace/:encodedPath/ws/terminal/:terminalId
    if (!reqUrl.pathname.startsWith('/workspace/')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const pathParts = reqUrl.pathname.split('/');
    // ['', 'workspace', base64urlPath, 'ws', 'terminal', terminalId]
    const encodedPath = pathParts[2];

    if (!encodedPath) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Decode Base64URL (RFC 4648) - NOT URL encoding
    // Wrap in try/catch to handle malformed Base64 input gracefully
    let workspacePath: string;
    try {
      workspacePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
      // Support both POSIX (/) and Windows (C:\) paths
      if (!workspacePath || (!workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(workspacePath))) {
        throw new Error('Invalid workspace path');
      }
      // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
      workspacePath = normalizeWorkspacePath(workspacePath);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Check for terminal WebSocket route: /workspace/:path/ws/terminal/:id
    const wsMatch = reqUrl.pathname.match(/^\/workspace\/[^/]+\/ws\/terminal\/([^/]+)$/);
    if (wsMatch) {
      const terminalId = wsMatch[1];
      const manager = getTerminalManager();
      const session = manager.getSession(terminalId);

      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalWebSocket(ws, session, req);
      });
      return;
    }

    // Unhandled WebSocket route
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
}
