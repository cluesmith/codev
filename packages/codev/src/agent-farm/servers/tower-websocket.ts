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
import { WS_CLOSE_SESSION_UNKNOWN } from '../lib/reconnect-backoff.js';
import { encodeData, encodeControl, decodeFrame } from '../../terminal/ws-protocol.js';
import type { PtySession } from '../../terminal/pty-session.js';
import { getTerminalManager, isStartupReconcileSettled, whenStartupReconcileSettled } from './tower-terminals.js';
import { normalizeWorkspacePath } from './tower-utils.js';
import { decodeWorkspacePath } from '../lib/tower-client.js';
import { addSubscriber, removeSubscriber } from './tower-messages.js';

// ============================================================================
// Frame bridging — WS ↔ PTY
// ============================================================================

/**
 * Maximum bytes to buffer in a WebSocket before dropping data frames.
 * Terminal output is ephemeral — dropping frames under backpressure is
 * preferable to unbounded memory growth or connection stalls.
 */
const WS_HIGH_WATER_MARK = 1 * 1024 * 1024; // 1 MB

/**
 * Handle WebSocket connection to a terminal session.
 * Uses hybrid binary protocol (Spec 0085):
 * - 0x00 prefix: Control frame (JSON)
 * - 0x01 prefix: Data frame (raw PTY bytes)
 */
export function handleTerminalWebSocket(ws: WebSocket, session: PtySession, req: http.IncomingMessage): void {
  // Support resume via header (server-to-server) or query param (browser WebSocket)
  const reqUrl = new URL(req.url || '/', `http://localhost`);
  const resumeSeq = req.headers['x-session-resume'] || reqUrl.searchParams.get('resume');

  // Create a client adapter for the PTY session.
  // Checks bufferedAmount to prevent unbounded memory growth when
  // the browser can't consume data fast enough (Bugfix #313).
  const client = {
    send: (data: Buffer | string) => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < WS_HIGH_WATER_MARK) {
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

  // Send replay data as binary data frame, bracketed by pause/resume control
  // frames (#1047). The bracket tells the client "this is the one-shot buffer
  // snapshot" so it paces the write and excludes it from its live-backpressure
  // budget. Without it, a client counts a large replay as live overload and
  // (historically) looped forever reconnecting for the same oversized replay.
  if (replayLines.length > 0) {
    const replayData = replayLines.join('\n');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeControl({ type: 'pause', payload: {} }));
      ws.send(encodeData(replayData));
      ws.send(encodeControl({ type: 'resume', payload: {} }));
    }
  }

  // Send current sequence number so client can resume from this point (Bugfix #442)
  const sendSeq = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeControl({ type: 'seq', payload: { seq: session.ringBuffer.currentSeq } }));
    }
  };
  sendSeq();

  // Periodic seq heartbeat so client always has a recent sequence number
  const seqInterval = setInterval(sendSeq, 10_000);

  // Handle incoming messages from client (binary protocol)
  ws.on('message', (rawData: Buffer) => {
    try {
      const frame = decodeFrame(Buffer.from(rawData));

      if (frame.type === 'data') {
        // Spec 403 typing-awareness + Bugfix #450 composing/submit detection are
        // consolidated in PtySession.handleUserInput so every live input path stays
        // consistent (Spec 1313 Phase 5 — its 'submit' fast trigger fires from there).
        session.handleUserInput(frame.data.toString('utf-8'));
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
        session.handleUserInput(rawData.toString('utf-8'));
      } catch {
        // Ignore malformed input
      }
    }
  });

  ws.on('close', () => {
    clearInterval(seqInterval);
    session.detach(client);
  });

  ws.on('error', () => {
    clearInterval(seqInterval);
    session.detach(client);
  });
}

// ============================================================================
// WebSocket upgrade routing
// ============================================================================

/**
 * Reject an upgrade request that targets an unknown terminal session.
 *
 * Two client shapes need different signals (#971):
 * - **Browser** clients can't read a failed *upgrade*'s HTTP status — a failed
 *   WS handshake only surfaces as `onclose` code `1006`, indistinguishable from
 *   a transport blip. So we accept the upgrade and immediately close with an
 *   app-range code ({@link WS_CLOSE_SESSION_UNKNOWN}) the dashboard reads via
 *   `CloseEvent.code` to fast-path its give-up instead of blind-retrying.
 * - **Node `ws`** clients (the VSCode terminal) get the HTTP-stage `404`: they
 *   rely on the `"Unexpected server response: 404"` upgrade error (#936), so
 *   this path must stay byte-for-byte unchanged to avoid regressing them.
 *
 * Discriminator: the `Origin` header, which browsers always send on a WS
 * upgrade and the Node `ws` terminal client never sets. A browser arriving
 * without `Origin` degrades gracefully to the Node path (blind retry) — no
 * worse than today's behavior.
 */
function rejectUnknownSession(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  wss: WebSocketServer,
): void {
  if (req.headers.origin) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(WS_CLOSE_SESSION_UNKNOWN, 'session-unknown');
    });
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
}

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
      // #997: don't reject a terminal id as unknown while the startup reconcile
      // is still re-registering persistent sessions — wait for it to settle so a
      // client reconnecting to its preserved id (#991) isn't spuriously 404'd.
      // Fast-path the settled (normal post-startup) case to avoid per-upgrade overhead.
      if (!isStartupReconcileSettled()) await whenStartupReconcileSettled();
      const manager = getTerminalManager();
      const session = manager.getSession(terminalId);

      if (!session) {
        rejectUnknownSession(req, socket, head, wss);
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalWebSocket(ws, session, req);
      });
      return;
    }

    // Spec 0110 Phase 3: Handle /ws/messages — message bus subscription
    if (reqUrl.pathname === '/ws/messages') {
      const projectFilter = reqUrl.searchParams.get('project') || undefined;

      wss.handleUpgrade(req, socket, head, (ws) => {
        addSubscriber(ws, projectFilter);

        ws.on('close', () => {
          removeSubscriber(ws);
        });

        ws.on('error', () => {
          removeSubscriber(ws);
        });
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
      workspacePath = decodeWorkspacePath(encodedPath);
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
      // #997: same readiness gate as the direct route above — wait out the
      // startup reconcile window before treating an id as unknown.
      if (!isStartupReconcileSettled()) await whenStartupReconcileSettled();
      const manager = getTerminalManager();
      const session = manager.getSession(terminalId);

      if (!session) {
        rejectUnknownSession(req, socket, head, wss);
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
