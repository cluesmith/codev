#!/usr/bin/env node

/**
 * Tower server for Agent Farm.
 * Provides a centralized view of all agent-farm instances across projects.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { WebSocketServer, WebSocket } from 'ws';
import { escapeHtml, parseJsonBody, isRequestAllowed } from '../utils/server-utils.js';
import { encodeData, encodeControl, decodeFrame } from '../../terminal/ws-protocol.js';
import { SessionManager } from '../../terminal/session-manager.js';
import type { SSEClient } from './tower-types.js';
import {
  isRateLimited,
  startRateLimitCleanup,
  normalizeProjectPath,
  getLanguageForExt,
  getMimeTypeForFile,
  MIME_TYPES,
  serveStaticFile,
} from './tower-utils.js';
import {
  initTunnel,
  shutdownTunnel,
  handleTunnelEndpoint,
} from './tower-tunnel.js';
import {
  initInstances,
  shutdownInstances,
  registerKnownProject,
  getKnownProjectPaths,
  getInstances,
  getDirectorySuggestions,
  launchInstance,
  killTerminalWithShepherd,
  stopInstance,
} from './tower-instances.js';
import {
  initTerminals,
  shutdownTerminals,
  getProjectTerminals,
  getTerminalManager,
  getProjectTerminalsEntry,
  getNextShellId,
  saveTerminalSession,
  isSessionPersistent,
  deleteTerminalSession,
  deleteProjectTerminalSessions,
  saveFileTab,
  deleteFileTab,
  getTerminalsForProject,
  reconcileTerminalSessions,
  startGateWatcher,
  stopGateWatcher,
} from './tower-terminals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default port for tower dashboard
const DEFAULT_PORT = 4100;

// Rate limiting: imported from ./tower-utils.ts
// Start cleanup interval — store handle for graceful shutdown
const rateLimitCleanupInterval = startRateLimitCleanup();

// Cloud tunnel: imported from ./tower-tunnel.ts (initTunnel, shutdownTunnel, handleTunnelEndpoint)

// Terminal management: imported from ./tower-terminals.ts
// (getProjectTerminals, getTerminalManager, getProjectTerminalsEntry, etc.)

// getProjectTerminalsEntry, getNextShellId, getTerminalManager, saveTerminalSession,
// isSessionPersistent, deleteTerminalSession, deleteProjectTerminalSessions,
// saveFileTab, deleteFileTab, loadFileTabsForProject, processExists,
// reconcileTerminalSessions, getTerminalSessionsForProject: imported from ./tower-terminals.ts

// Shepherd session manager (initialized at startup)
let shepherdManager: SessionManager | null = null;

import type { PtySession, PtySessionInfo } from '../../terminal/pty-session.js';

/**
 * Handle WebSocket connection to a terminal session
 * Uses hybrid binary protocol (Spec 0085):
 * - 0x00 prefix: Control frame (JSON)
 * - 0x01 prefix: Data frame (raw PTY bytes)
 */
function handleTerminalWebSocket(ws: WebSocket, session: PtySession, req: http.IncomingMessage): void {
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

// Parse arguments with Commander
const program = new Command()
  .name('tower-server')
  .description('Tower dashboard for Agent Farm - centralized view of all instances')
  .argument('[port]', 'Port to listen on', String(DEFAULT_PORT))
  .option('-p, --port <port>', 'Port to listen on (overrides positional argument)')
  .option('-l, --log-file <path>', 'Log file path for server output')
  .parse(process.argv);

const opts = program.opts();
const args = program.args;
const portArg = opts.port || args[0] || String(DEFAULT_PORT);
const port = parseInt(portArg, 10);
const logFilePath = opts.logFile;

// Logging utility
function log(level: 'INFO' | 'ERROR' | 'WARN', message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}`;

  // Always log to console
  if (level === 'ERROR') {
    console.error(logLine);
  } else {
    console.log(logLine);
  }

  // Also log to file if configured
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, logLine + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}

// Global exception handlers to catch uncaught errors
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  log('ERROR', `Unhandled rejection: ${message}`);
  process.exit(1);
});

// Graceful shutdown handler (Phase 2 - Spec 0090)
async function gracefulShutdown(signal: string): Promise<void> {
  log('INFO', `Received ${signal}, starting graceful shutdown...`);

  // 1. Stop accepting new connections
  server?.close();

  // 2. Close all WebSocket connections
  if (terminalWss) {
    for (const client of terminalWss.clients) {
      client.close(1001, 'Server shutting down');
    }
    terminalWss.close();
  }

  // 3. Shepherd clients: do NOT call shepherdManager.shutdown() here.
  // SessionManager.shutdown() disconnects sockets, which triggers ShepherdClient
  // 'close' events → PtySession exit(-1) → SQLite row deletion. This would erase
  // the rows that reconcileTerminalSessions() needs on restart.
  // Instead, let the process exit naturally — OS closes all sockets, and shepherds
  // detect the disconnection and keep running. SQLite rows are preserved.
  if (shepherdManager) {
    log('INFO', 'Shepherd sessions will continue running (sockets close on process exit)');
  }

  // 4. Stop rate limit cleanup
  clearInterval(rateLimitCleanupInterval);

  // 5. Disconnect tunnel (Spec 0097 Phase 4 / Spec 0105 Phase 2)
  shutdownTunnel();

  // 6. Tear down instance module (Spec 0105 Phase 3)
  shutdownInstances();

  // 7. Tear down terminal module (Spec 0105 Phase 4) — stops gate watcher, shuts down terminal manager
  shutdownTerminals();

  log('INFO', 'Graceful shutdown complete');
  process.exit(0);
}

// Catch signals for clean shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

if (isNaN(port) || port < 1 || port > 65535) {
  log('ERROR', `Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

log('INFO', `Tower server starting on port ${port}`);

// registerKnownProject, getKnownProjectPaths: imported from ./tower-instances.ts

// startGateWatcher, stopGateWatcher: imported from ./tower-terminals.ts

// SSE (Server-Sent Events) infrastructure for push notifications
// SSEClient interface: imported from ./tower-types.ts

const sseClients: SSEClient[] = [];
let notificationIdCounter = 0;

/**
 * Broadcast a notification to all connected SSE clients
 */
function broadcastNotification(notification: { type: string; title: string; body: string; project?: string }): void {
  const id = ++notificationIdCounter;
  const data = JSON.stringify({ ...notification, id });
  const message = `id: ${id}\ndata: ${data}\n\n`;

  for (const client of sseClients) {
    try {
      client.res.write(message);
    } catch {
      // Client disconnected, will be cleaned up on next iteration
    }
  }
}

// getTerminalsForProject: imported from ./tower-terminals.ts

// getInstances, getDirectorySuggestions, launchInstance, killTerminalWithShepherd,
// stopInstance: imported from ./tower-instances.ts

/**
 * Find the tower template
 * Template is bundled with agent-farm package in templates/ directory
 */
function findTemplatePath(): string | null {
  // Templates are at package root: packages/codev/templates/
  // From compiled: dist/agent-farm/servers/ -> ../../../templates/
  // From source: src/agent-farm/servers/ -> ../../../templates/
  const pkgPath = path.resolve(__dirname, '../../../templates/tower.html');
  if (fs.existsSync(pkgPath)) {
    return pkgPath;
  }

  return null;
}

// escapeHtml, parseJsonBody, isRequestAllowed imported from ../utils/server-utils.js

// Find template path
const templatePath = findTemplatePath();

// WebSocket server for terminal connections (Phase 2 - Spec 0090)
let terminalWss: WebSocketServer | null = null;

// React dashboard dist path (for serving directly from tower)
// Phase 4 (Spec 0090): Tower serves everything directly, no dashboard-server
const reactDashboardPath = path.resolve(__dirname, '../../../dashboard/dist');
const hasReactDashboard = fs.existsSync(reactDashboardPath);
if (hasReactDashboard) {
  log('INFO', `React dashboard found at: ${reactDashboardPath}`);
} else {
  log('WARN', 'React dashboard not found - project dashboards will not work');
}

// MIME_TYPES, serveStaticFile: imported from ./tower-utils.ts

// handleTunnelEndpoint: imported from ./tower-tunnel.ts

// Create server
const server = http.createServer(async (req, res) => {
  // Security: Validate Host and Origin headers
  if (!isRequestAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers — allow localhost and tunnel proxy origins
  const origin = req.headers.origin;
  if (origin && (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://')
  )) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${port}`);

  try {
    // =========================================================================
    // NEW API ENDPOINTS (Spec 0090 - Tower as Single Daemon)
    // =========================================================================

    // Health check endpoint (Spec 0090 Phase 1)
    if (req.method === 'GET' && url.pathname === '/health') {
      const instances = await getInstances();
      const activeCount = instances.filter((i) => i.running).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          uptime: process.uptime(),
          activeProjects: activeCount,
          totalProjects: instances.length,
          memoryUsage: process.memoryUsage().heapUsed,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // =========================================================================
    // Tunnel Management Endpoints (Spec 0097 Phase 4)
    // Also reachable from /project/<encoded>/api/tunnel/* (see project router)
    // =========================================================================

    if (url.pathname.startsWith('/api/tunnel/')) {
      const tunnelSub = url.pathname.slice('/api/tunnel/'.length);
      await handleTunnelEndpoint(req, res, tunnelSub);
      return;
    }

    // API: List all projects (Spec 0090 Phase 1)
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const instances = await getInstances();
      const projects = instances.map((i) => ({
        path: i.projectPath,
        name: i.projectName,
        active: i.running,
        proxyUrl: i.proxyUrl,
        terminals: i.terminals.length,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects }));
      return;
    }

    // API: Project-specific endpoints (Spec 0090 Phase 1)
    // Routes: /api/projects/:encodedPath/activate, /deactivate, /status
    const projectApiMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(activate|deactivate|status)$/);
    if (projectApiMatch) {
      const [, encodedPath, action] = projectApiMatch;
      let projectPath: string;
      try {
        projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
        if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
          throw new Error('Invalid path');
        }
        // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
        projectPath = normalizeProjectPath(projectPath);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project path encoding' }));
        return;
      }

      // GET /api/projects/:path/status
      if (req.method === 'GET' && action === 'status') {
        const instances = await getInstances();
        const instance = instances.find((i) => i.projectPath === projectPath);
        if (!instance) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            path: instance.projectPath,
            name: instance.projectName,
            active: instance.running,
            terminals: instance.terminals,
            gateStatus: instance.gateStatus,
          })
        );
        return;
      }

      // POST /api/projects/:path/activate
      if (req.method === 'POST' && action === 'activate') {
        // Rate limiting: 10 activations per minute per client
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        if (isRateLimited(clientIp)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many activations, try again later' }));
          return;
        }

        const result = await launchInstance(projectPath);
        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, adopted: result.adopted }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error }));
        }
        return;
      }

      // POST /api/projects/:path/deactivate
      if (req.method === 'POST' && action === 'deactivate') {
        // Check if project is known (has terminals or sessions)
        const knownPaths = getKnownProjectPaths();
        const resolvedPath = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : projectPath;
        const isKnown = knownPaths.some(
          (p) => p === projectPath || p === resolvedPath
        );

        if (!isKnown) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Project not found' }));
          return;
        }

        // Phase 4: Stop terminals directly via tower
        const result = await stopInstance(projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
    }

    // =========================================================================
    // TERMINAL API (Phase 2 - Spec 0090)
    // =========================================================================

    // POST /api/terminals - Create a new terminal
    if (req.method === 'POST' && url.pathname === '/api/terminals') {
      try {
        const body = await parseJsonBody(req);
        const manager = getTerminalManager();

        // Parse request fields
        let command = typeof body.command === 'string' ? body.command : undefined;
        let args = Array.isArray(body.args) ? body.args as string[] : undefined;
        const cols = typeof body.cols === 'number' ? body.cols : undefined;
        const rows = typeof body.rows === 'number' ? body.rows : undefined;
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
        const env = typeof body.env === 'object' && body.env !== null ? (body.env as Record<string, string>) : undefined;
        const label = typeof body.label === 'string' ? body.label : undefined;

        // Optional session persistence via shepherd
        const projectPath = typeof body.projectPath === 'string' ? body.projectPath : null;
        const termType = typeof body.type === 'string' && ['builder', 'shell'].includes(body.type) ? body.type as 'builder' | 'shell' : null;
        const roleId = typeof body.roleId === 'string' ? body.roleId : null;
        const requestPersistence = body.persistent === true;

        let info: PtySessionInfo | undefined;
        let persistent = false;

        // Try shepherd if persistence was requested
        if (requestPersistence && shepherdManager && command && cwd) {
          try {
            const sessionId = crypto.randomUUID();
            // Strip CLAUDECODE so spawned Claude processes don't detect nesting
            const sessionEnv = { ...(env || process.env) } as Record<string, string>;
            delete sessionEnv['CLAUDECODE'];
            const client = await shepherdManager.createSession({
              sessionId,
              command,
              args: args || [],
              cwd,
              env: sessionEnv,
              cols: cols || 200,
              rows: 50,
              restartOnExit: false,
            });

            const replayData = client.getReplayData() ?? Buffer.alloc(0);
            const shepherdInfo = shepherdManager.getSessionInfo(sessionId)!;

            const session = manager.createSessionRaw({
              label: label || `terminal-${sessionId.slice(0, 8)}`,
              cwd,
            });
            const ptySession = manager.getSession(session.id);
            if (ptySession) {
              ptySession.attachShepherd(client, replayData, shepherdInfo.pid, sessionId);
            }

            info = session;
            persistent = true;

            if (projectPath && termType && roleId) {
              const entry = getProjectTerminalsEntry(normalizeProjectPath(projectPath));
              if (termType === 'builder') {
                entry.builders.set(roleId, session.id);
              } else {
                entry.shells.set(roleId, session.id);
              }
              saveTerminalSession(session.id, projectPath, termType, roleId, shepherdInfo.pid,
                shepherdInfo.socketPath, shepherdInfo.pid, shepherdInfo.startTime);
              log('INFO', `Registered shepherd terminal ${session.id} as ${termType} "${roleId}" for project ${projectPath}`);
            }
          } catch (shepherdErr) {
            log('WARN', `Shepherd creation failed for terminal, falling back: ${(shepherdErr as Error).message}`);
          }
        }

        // Fallback: non-persistent session (graceful degradation per plan)
        // Shepherd is the only persistence backend for new sessions.
        if (!info) {
          info = await manager.createSession({ command, args, cols, rows, cwd, env, label });
          persistent = false;

          if (projectPath && termType && roleId) {
            const entry = getProjectTerminalsEntry(normalizeProjectPath(projectPath));
            if (termType === 'builder') {
              entry.builders.set(roleId, info.id);
            } else {
              entry.shells.set(roleId, info.id);
            }
            saveTerminalSession(info.id, projectPath, termType, roleId, info.pid);
            log('WARN', `Terminal ${info.id} for ${projectPath} is non-persistent (shepherd unavailable)`);
          }
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...info, wsPath: `/ws/terminal/${info.id}`, persistent }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log('ERROR', `Failed to create terminal: ${message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message }));
      }
      return;
    }

    // GET /api/terminals - List all terminals
    if (req.method === 'GET' && url.pathname === '/api/terminals') {
      const manager = getTerminalManager();
      const terminals = manager.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals }));
      return;
    }

    // Terminal-specific routes: /api/terminals/:id/*
    const terminalRouteMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)(\/.*)?$/);
    if (terminalRouteMatch) {
      const [, terminalId, subpath] = terminalRouteMatch;
      const manager = getTerminalManager();

      // GET /api/terminals/:id - Get terminal info
      if (req.method === 'GET' && (!subpath || subpath === '')) {
        const session = manager.getSession(terminalId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session.info));
        return;
      }

      // DELETE /api/terminals/:id - Kill terminal (disable shepherd auto-restart if applicable)
      if (req.method === 'DELETE' && (!subpath || subpath === '')) {
        if (!(await killTerminalWithShepherd(manager, terminalId))) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }

        // TICK-001: Delete from SQLite
        deleteTerminalSession(terminalId);

        res.writeHead(204);
        res.end();
        return;
      }

      // POST /api/terminals/:id/write - Write data to terminal (Spec 0104)
      if (req.method === 'POST' && subpath === '/write') {
        try {
          const body = await parseJsonBody(req);
          if (typeof body.data !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'data must be a string' }));
            return;
          }
          const session = manager.getSession(terminalId);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
            return;
          }
          session.write(body.data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Invalid JSON body' }));
        }
        return;
      }

      // POST /api/terminals/:id/resize - Resize terminal
      if (req.method === 'POST' && subpath === '/resize') {
        try {
          const body = await parseJsonBody(req);
          if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'cols and rows must be numbers' }));
            return;
          }
          const info = manager.resizeSession(terminalId, body.cols, body.rows);
          if (!info) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(info));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Invalid JSON body' }));
        }
        return;
      }

      // GET /api/terminals/:id/output - Get terminal output
      if (req.method === 'GET' && subpath === '/output') {
        const lines = parseInt(url.searchParams.get('lines') ?? '100', 10);
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const output = manager.getOutput(terminalId, lines, offset);
        if (!output) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
        return;
      }
    }

    // =========================================================================
    // EXISTING API ENDPOINTS
    // =========================================================================

    // API: Get status of all instances (legacy - kept for backward compat)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const instances = await getInstances();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ instances }));
      return;
    }

    // API: Server-Sent Events for push notifications
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const clientId = crypto.randomBytes(8).toString('hex');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', id: clientId })}\n\n`);

      const client: SSEClient = { res, id: clientId };
      sseClients.push(client);

      log('INFO', `SSE client connected: ${clientId} (total: ${sseClients.length})`);

      // Clean up on disconnect
      req.on('close', () => {
        const index = sseClients.findIndex((c) => c.id === clientId);
        if (index !== -1) {
          sseClients.splice(index, 1);
        }
        log('INFO', `SSE client disconnected: ${clientId} (total: ${sseClients.length})`);
      });

      return;
    }

    // API: Receive notification from builder
    if (req.method === 'POST' && url.pathname === '/api/notify') {
      const body = await parseJsonBody(req);
      const type = typeof body.type === 'string' ? body.type : 'info';
      const title = typeof body.title === 'string' ? body.title : '';
      const messageBody = typeof body.body === 'string' ? body.body : '';
      const project = typeof body.project === 'string' ? body.project : undefined;

      if (!title || !messageBody) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing title or body' }));
        return;
      }

      // Broadcast to all connected SSE clients
      broadcastNotification({
        type,
        title,
        body: messageBody,
        project,
      });

      log('INFO', `Notification broadcast: ${title}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: Browse directories for autocomplete
    if (req.method === 'GET' && url.pathname === '/api/browse') {
      const inputPath = url.searchParams.get('path') || '';

      try {
        const suggestions = await getDirectorySuggestions(inputPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestions }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestions: [], error: (err as Error).message }));
      }
      return;
    }

    // API: Create new project
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const body = await parseJsonBody(req);
      const parentPath = body.parent as string;
      const projectName = body.name as string;

      if (!parentPath || !projectName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing parent or name' }));
        return;
      }

      // Validate project name
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid project name' }));
        return;
      }

      // Expand ~ to home directory
      let expandedParent = parentPath;
      if (expandedParent.startsWith('~')) {
        expandedParent = expandedParent.replace('~', homedir());
      }

      // Validate parent exists
      if (!fs.existsSync(expandedParent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Parent directory does not exist: ${parentPath}` }));
        return;
      }

      const projectPath = path.join(expandedParent, projectName);

      // Check if project already exists
      if (fs.existsSync(projectPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Directory already exists: ${projectPath}` }));
        return;
      }

      try {
        // Run codev init (it creates the directory)
        execSync(`codev init --yes "${projectName}"`, {
          cwd: expandedParent,
          stdio: 'pipe',
          timeout: 60000,
        });

        // Launch the instance
        const launchResult = await launchInstance(projectPath);
        if (!launchResult.success) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: launchResult.error }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, projectPath }));
      } catch (err) {
        // Clean up on failure
        try {
          if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true });
          }
        } catch {
          // Ignore cleanup errors
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Failed to create project: ${(err as Error).message}` }));
      }
      return;
    }

    // API: Launch new instance
    if (req.method === 'POST' && url.pathname === '/api/launch') {
      const body = await parseJsonBody(req);
      let projectPath = body.projectPath as string;

      if (!projectPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath' }));
        return;
      }

      // Expand ~ to home directory
      if (projectPath.startsWith('~')) {
        projectPath = projectPath.replace('~', homedir());
      }

      // Reject relative paths — tower daemon CWD is unpredictable
      if (!path.isAbsolute(projectPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Relative paths are not supported. Use an absolute path (e.g., /Users/.../project or ~/Development/project).`,
        }));
        return;
      }

      // Normalize path (resolve .. segments, trailing slashes)
      projectPath = path.resolve(projectPath);

      const result = await launchInstance(projectPath);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Stop an instance
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await parseJsonBody(req);
      const targetPath = body.projectPath as string;

      if (!targetPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath' }));
        return;
      }

      const result = await stopInstance(targetPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Serve dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!templatePath) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Template not found. Make sure tower.html exists in agent-farm/templates/');
        return;
      }

      try {
        const template = fs.readFileSync(templatePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(template);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading template: ' + (err as Error).message);
      }
      return;
    }

    // Project routes: /project/:base64urlPath/*
    // Phase 4 (Spec 0090): Tower serves React dashboard and handles APIs directly
    // Uses Base64URL (RFC 4648) encoding to avoid issues with slashes in paths
    if (url.pathname.startsWith('/project/')) {
      const pathParts = url.pathname.split('/');
      // ['', 'project', base64urlPath, ...rest]
      const encodedPath = pathParts[2];
      const subPath = pathParts.slice(3).join('/');

      if (!encodedPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing project path' }));
        return;
      }

      // Decode Base64URL (RFC 4648)
      let projectPath: string;
      try {
        projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
        // Support both POSIX (/) and Windows (C:\) paths
        if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
          throw new Error('Invalid project path');
        }
        // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
        projectPath = normalizeProjectPath(projectPath);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project path encoding' }));
        return;
      }

      // Phase 4 (Spec 0090): Tower handles everything directly
      const isApiCall = subPath.startsWith('api/') || subPath === 'api';
      const isWsPath = subPath.startsWith('ws/') || subPath === 'ws';

      // Tunnel endpoints are tower-level, not project-scoped, but the React
      // dashboard uses relative paths (./api/tunnel/...) which resolve to
      // /project/<encoded>/api/tunnel/... in project context. Handle here by
      // extracting the tunnel sub-path and dispatching to handleTunnelEndpoint().
      if (subPath.startsWith('api/tunnel/')) {
        const tunnelSub = subPath.slice('api/tunnel/'.length); // e.g. "status", "connect", "disconnect"
        await handleTunnelEndpoint(req, res, tunnelSub);
        return;
      }

      // GET /file?path=<relative-path> — Read project file by path (for StatusPanel project list)
      if (req.method === 'GET' && subPath === 'file' && url.searchParams.has('path')) {
        const relPath = url.searchParams.get('path')!;
        const fullPath = path.resolve(projectPath, relPath);
        // Security: ensure resolved path stays within project directory
        if (!fullPath.startsWith(projectPath + path.sep) && fullPath !== projectPath) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(content);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
        return;
      }

      // Serve React dashboard static files directly if:
      // 1. Not an API call
      // 2. Not a WebSocket path
      // 3. React dashboard is available
      // 4. Project doesn't need to be running for static files
      if (!isApiCall && !isWsPath && hasReactDashboard) {
        // Determine which static file to serve
        let staticPath: string;
        if (!subPath || subPath === '' || subPath === 'index.html') {
          staticPath = path.join(reactDashboardPath, 'index.html');
        } else {
          // Check if it's a static asset
          staticPath = path.join(reactDashboardPath, subPath);
        }

        // Try to serve the static file
        if (serveStaticFile(staticPath, res)) {
          return;
        }

        // SPA fallback: serve index.html for client-side routing
        const indexPath = path.join(reactDashboardPath, 'index.html');
        if (serveStaticFile(indexPath, res)) {
          return;
        }
      }

      // Phase 4 (Spec 0090): Handle project APIs directly instead of proxying to dashboard-server
      if (isApiCall) {
        const apiPath = subPath.replace(/^api\/?/, '');

        // GET /api/state - Return project state (architect, builders, shells)
        if (req.method === 'GET' && (apiPath === 'state' || apiPath === '')) {
          // Refresh cache via getTerminalsForProject (handles SQLite sync
          // and shepherd reconnection in one place)
          const encodedPath = Buffer.from(projectPath).toString('base64url');
          const proxyUrl = `/project/${encodedPath}/`;
          const { gateStatus } = await getTerminalsForProject(projectPath, proxyUrl);

          // Now read from the refreshed cache
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();
          const state: {
            architect: { port: number; pid: number; terminalId?: string; persistent?: boolean } | null;
            builders: Array<{ id: string; name: string; port: number; pid: number; status: string; phase: string; worktree: string; branch: string; type: string; terminalId?: string; persistent?: boolean }>;
            utils: Array<{ id: string; name: string; port: number; pid: number; terminalId?: string; persistent?: boolean }>;
            annotations: Array<{ id: string; file: string; port: number; pid: number }>;
            projectName?: string;
            gateStatus?: { hasGate: boolean; gateName?: string; builderId?: string; requestedAt?: string };
          } = {
            architect: null,
            builders: [],
            utils: [],
            annotations: [],
            projectName: path.basename(projectPath),
            gateStatus,
          };

          // Add architect if exists
          if (entry.architect) {
            const session = manager.getSession(entry.architect);
            if (session) {
              state.architect = {
                port: 0,
                pid: session.pid || 0,
                terminalId: entry.architect,
                persistent: isSessionPersistent(entry.architect, session),
              };
            }
          }

          // Add shells from refreshed cache
          for (const [shellId, terminalId] of entry.shells) {
            const session = manager.getSession(terminalId);
            if (session) {
              state.utils.push({
                id: shellId,
                name: `Shell ${shellId.replace('shell-', '')}`,
                port: 0,
                pid: session.pid || 0,
                terminalId,
                persistent: isSessionPersistent(terminalId, session),
              });
            }
          }

          // Add builders from refreshed cache
          for (const [builderId, terminalId] of entry.builders) {
            const session = manager.getSession(terminalId);
            if (session) {
              state.builders.push({
                id: builderId,
                name: `Builder ${builderId}`,
                port: 0,
                pid: session.pid || 0,
                status: 'running',
                phase: '',
                worktree: '',
                branch: '',
                type: 'spec',
                terminalId,
                persistent: isSessionPersistent(terminalId, session),
              });
            }
          }

          // Add file tabs (Spec 0092 - served through Tower, no separate ports)
          for (const [tabId, tab] of entry.fileTabs) {
            state.annotations.push({
              id: tabId,
              file: tab.path,
              port: 0,  // No separate port - served through Tower
              pid: 0,   // No separate process
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state));
          return;
        }

        // POST /api/tabs/shell - Create a new shell terminal
        if (req.method === 'POST' && apiPath === 'tabs/shell') {
          try {
            const manager = getTerminalManager();
            const shellId = getNextShellId(projectPath);
            const shellCmd = process.env.SHELL || '/bin/bash';
            const shellArgs: string[] = [];

            let shellCreated = false;

            // Try shepherd first for persistent shell session
            if (shepherdManager) {
              try {
                const sessionId = crypto.randomUUID();
                // Strip CLAUDECODE so spawned Claude processes don't detect nesting
                const shellEnv = { ...process.env } as Record<string, string>;
                delete shellEnv['CLAUDECODE'];
                const client = await shepherdManager.createSession({
                  sessionId,
                  command: shellCmd,
                  args: shellArgs,
                  cwd: projectPath,
                  env: shellEnv,
                  cols: 200,
                  rows: 50,
                  restartOnExit: false,
                });

                const replayData = client.getReplayData() ?? Buffer.alloc(0);
                const shepherdInfo = shepherdManager.getSessionInfo(sessionId)!;

                const session = manager.createSessionRaw({
                  label: `Shell ${shellId.replace('shell-', '')}`,
                  cwd: projectPath,
                });
                const ptySession = manager.getSession(session.id);
                if (ptySession) {
                  ptySession.attachShepherd(client, replayData, shepherdInfo.pid, sessionId);
                }

                const entry = getProjectTerminalsEntry(projectPath);
                entry.shells.set(shellId, session.id);
                saveTerminalSession(session.id, projectPath, 'shell', shellId, shepherdInfo.pid,
                  shepherdInfo.socketPath, shepherdInfo.pid, shepherdInfo.startTime);

                shellCreated = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  id: shellId,
                  port: 0,
                  name: `Shell ${shellId.replace('shell-', '')}`,
                  terminalId: session.id,
                  persistent: true,
                }));
              } catch (shepherdErr) {
                log('WARN', `Shepherd creation failed for shell, falling back: ${(shepherdErr as Error).message}`);
              }
            }

            // Fallback: non-persistent session (graceful degradation per plan)
            // Shepherd is the only persistence backend for new sessions.
            if (!shellCreated) {
              const session = await manager.createSession({
                command: shellCmd,
                args: shellArgs,
                cwd: projectPath,
                label: `Shell ${shellId.replace('shell-', '')}`,
                env: process.env as Record<string, string>,
              });

              const entry = getProjectTerminalsEntry(projectPath);
              entry.shells.set(shellId, session.id);
              saveTerminalSession(session.id, projectPath, 'shell', shellId, session.pid);
              log('WARN', `Shell ${shellId} for ${projectPath} is non-persistent (shepherd unavailable)`);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                id: shellId,
                port: 0,
                name: `Shell ${shellId.replace('shell-', '')}`,
                terminalId: session.id,
                persistent: false,
              }));
            }
          } catch (err) {
            log('ERROR', `Failed to create shell: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // POST /api/tabs/file - Create a file tab (Spec 0092)
        if (req.method === 'POST' && apiPath === 'tabs/file') {
          try {
            const body = await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk: Buffer) => data += chunk.toString());
              req.on('end', () => resolve(data));
            });
            const { path: filePath, line, terminalId } = JSON.parse(body || '{}');

            if (!filePath || typeof filePath !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing path parameter' }));
              return;
            }

            // Resolve path: use terminal's cwd for relative paths when terminalId is provided
            let fullPath: string;
            if (path.isAbsolute(filePath)) {
              fullPath = filePath;
            } else if (terminalId) {
              const manager = getTerminalManager();
              const session = manager.getSession(terminalId);
              if (session) {
                fullPath = path.join(session.cwd, filePath);
              } else {
                log('WARN', `Terminal session ${terminalId} not found, falling back to project root`);
                fullPath = path.join(projectPath, filePath);
              }
            } else {
              fullPath = path.join(projectPath, filePath);
            }

            // Security: symlink-aware containment check
            // For non-existent files, resolve the parent directory to handle
            // intermediate symlinks (e.g., /tmp -> /private/tmp on macOS).
            let resolvedPath: string;
            try {
              resolvedPath = fs.realpathSync(fullPath);
            } catch {
              try {
                resolvedPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
              } catch {
                resolvedPath = path.resolve(fullPath);
              }
            }

            let normalizedProject: string;
            try {
              normalizedProject = fs.realpathSync(projectPath);
            } catch {
              normalizedProject = path.resolve(projectPath);
            }

            const isWithinProject = resolvedPath.startsWith(normalizedProject + path.sep)
              || resolvedPath === normalizedProject;

            if (!isWithinProject) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Path outside project' }));
              return;
            }

            // Non-existent files still create a tab (spec 0101: file viewer shows "File not found")
            const fileExists = fs.existsSync(fullPath);

            const entry = getProjectTerminalsEntry(projectPath);

            // Check if already open
            for (const [id, tab] of entry.fileTabs) {
              if (tab.path === fullPath) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id, existing: true, line, notFound: !fileExists }));
                return;
              }
            }

            // Create new file tab (write-through: in-memory + SQLite)
            const id = `file-${crypto.randomUUID()}`;
            const createdAt = Date.now();
            entry.fileTabs.set(id, { id, path: fullPath, createdAt });
            saveFileTab(id, projectPath, fullPath, createdAt);

            log('INFO', `Created file tab: ${id} for ${path.basename(fullPath)}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, existing: false, line, notFound: !fileExists }));
          } catch (err) {
            log('ERROR', `Failed to create file tab: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // GET /api/file/:id - Get file content as JSON (Spec 0092)
        const fileGetMatch = apiPath.match(/^file\/([^/]+)$/);
        if (req.method === 'GET' && fileGetMatch) {
          const tabId = fileGetMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const ext = path.extname(tab.path).slice(1).toLowerCase();
            const isText = !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov', 'pdf'].includes(ext);

            if (isText) {
              const content = fs.readFileSync(tab.path, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                path: tab.path,
                name: path.basename(tab.path),
                content,
                language: getLanguageForExt(ext),
                isMarkdown: ext === 'md',
                isImage: false,
                isVideo: false,
              }));
            } else {
              // For binary files, just return metadata
              const stat = fs.statSync(tab.path);
              const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
              const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                path: tab.path,
                name: path.basename(tab.path),
                content: null,
                language: ext,
                isMarkdown: false,
                isImage,
                isVideo,
                size: stat.size,
              }));
            }
          } catch (err) {
            log('ERROR', `GET /api/file/:id failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // GET /api/file/:id/raw - Get raw file content (for images/video) (Spec 0092)
        const fileRawMatch = apiPath.match(/^file\/([^/]+)\/raw$/);
        if (req.method === 'GET' && fileRawMatch) {
          const tabId = fileRawMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const data = fs.readFileSync(tab.path);
            const mimeType = getMimeTypeForFile(tab.path);
            res.writeHead(200, {
              'Content-Type': mimeType,
              'Content-Length': data.length,
              'Cache-Control': 'no-cache',
            });
            res.end(data);
          } catch (err) {
            log('ERROR', `GET /api/file/:id/raw failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // POST /api/file/:id/save - Save file content (Spec 0092)
        const fileSaveMatch = apiPath.match(/^file\/([^/]+)\/save$/);
        if (req.method === 'POST' && fileSaveMatch) {
          const tabId = fileSaveMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const body = await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk: Buffer) => data += chunk.toString());
              req.on('end', () => resolve(data));
            });
            const { content } = JSON.parse(body || '{}');

            if (typeof content !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing content parameter' }));
              return;
            }

            fs.writeFileSync(tab.path, content, 'utf-8');
            log('INFO', `Saved file: ${tab.path}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            log('ERROR', `POST /api/file/:id/save failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // DELETE /api/tabs/:id - Delete a terminal or file tab
        const deleteMatch = apiPath.match(/^tabs\/(.+)$/);
        if (req.method === 'DELETE' && deleteMatch) {
          const tabId = deleteMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Check if it's a file tab first (Spec 0092, write-through: in-memory + SQLite)
          if (tabId.startsWith('file-')) {
            if (entry.fileTabs.has(tabId)) {
              entry.fileTabs.delete(tabId);
              deleteFileTab(tabId);
              log('INFO', `Deleted file tab: ${tabId}`);
              res.writeHead(204);
              res.end();
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'File tab not found' }));
            }
            return;
          }

          // Find and delete the terminal
          let terminalId: string | undefined;

          if (tabId.startsWith('shell-')) {
            terminalId = entry.shells.get(tabId);
            if (terminalId) {
              entry.shells.delete(tabId);
            }
          } else if (tabId.startsWith('builder-')) {
            terminalId = entry.builders.get(tabId);
            if (terminalId) {
              entry.builders.delete(tabId);
            }
          } else if (tabId === 'architect') {
            terminalId = entry.architect;
            if (terminalId) {
              entry.architect = undefined;
            }
          }

          if (terminalId) {
            // Disable shepherd auto-restart if applicable, then kill the PtySession
            await killTerminalWithShepherd(manager, terminalId);

            // TICK-001: Delete from SQLite
            deleteTerminalSession(terminalId);

            res.writeHead(204);
            res.end();
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tab not found' }));
          }
          return;
        }

        // POST /api/stop - Stop all terminals for project
        if (req.method === 'POST' && apiPath === 'stop') {
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Kill all terminals (disable shepherd auto-restart if applicable)
          if (entry.architect) {
            await killTerminalWithShepherd(manager, entry.architect);
          }
          for (const terminalId of entry.shells.values()) {
            await killTerminalWithShepherd(manager, terminalId);
          }
          for (const terminalId of entry.builders.values()) {
            await killTerminalWithShepherd(manager, terminalId);
          }

          // Clear registry
          getProjectTerminals().delete(projectPath);

          // TICK-001: Delete all terminal sessions from SQLite
          deleteProjectTerminalSessions(projectPath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // GET /api/files - Return project directory tree for file browser (Spec 0092)
        if (req.method === 'GET' && apiPath === 'files') {
          const maxDepth = parseInt(url.searchParams.get('depth') || '3', 10);
          const ignore = new Set(['.git', 'node_modules', '.builders', 'dist', '.agent-farm', '.next', '.cache', '__pycache__']);

          function readTree(dir: string, depth: number): Array<{ name: string; path: string; type: 'file' | 'directory'; children?: Array<unknown> }> {
            if (depth <= 0) return [];
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              return entries
                .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
                .filter(e => !ignore.has(e.name))
                .sort((a, b) => {
                  // Directories first, then alphabetical
                  if (a.isDirectory() && !b.isDirectory()) return -1;
                  if (!a.isDirectory() && b.isDirectory()) return 1;
                  return a.name.localeCompare(b.name);
                })
                .map(e => {
                  const fullPath = path.join(dir, e.name);
                  const relativePath = path.relative(projectPath, fullPath);
                  if (e.isDirectory()) {
                    return { name: e.name, path: relativePath, type: 'directory' as const, children: readTree(fullPath, depth - 1) };
                  }
                  return { name: e.name, path: relativePath, type: 'file' as const };
                });
            } catch {
              return [];
            }
          }

          const tree = readTree(projectPath, maxDepth);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tree));
          return;
        }

        // GET /api/git/status - Return git status for file browser (Spec 0092)
        if (req.method === 'GET' && apiPath === 'git/status') {
          try {
            // Get git status in porcelain format for parsing
            const result = execSync('git status --porcelain', {
              cwd: projectPath,
              encoding: 'utf-8',
              timeout: 5000,
            });

            // Parse porcelain output: XY filename
            // X = staging area status, Y = working tree status
            const modified: string[] = [];
            const staged: string[] = [];
            const untracked: string[] = [];

            for (const line of result.split('\n')) {
              if (!line) continue;
              const x = line[0]; // staging area
              const y = line[1]; // working tree
              const filepath = line.slice(3);

              if (x === '?' && y === '?') {
                untracked.push(filepath);
              } else {
                if (x !== ' ' && x !== '?') {
                  staged.push(filepath);
                }
                if (y !== ' ' && y !== '?') {
                  modified.push(filepath);
                }
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ modified, staged, untracked }));
          } catch (err) {
            // Not a git repo or git command failed — return graceful degradation with error field
            log('WARN', `GET /api/git/status failed: ${(err as Error).message}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ modified: [], staged: [], untracked: [], error: (err as Error).message }));
          }
          return;
        }

        // GET /api/files/recent - Return recently opened file tabs (Spec 0092)
        if (req.method === 'GET' && apiPath === 'files/recent') {
          const entry = getProjectTerminalsEntry(projectPath);

          // Get all file tabs sorted by creation time (most recent first)
          const recentFiles = Array.from(entry.fileTabs.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10)  // Limit to 10 most recent
            .map(tab => ({
              id: tab.id,
              path: tab.path,
              name: path.basename(tab.path),
              relativePath: path.relative(projectPath, tab.path),
            }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(recentFiles));
          return;
        }

        // GET /api/annotate/:tabId/* — Serve rich annotator template and sub-APIs
        const annotateMatch = apiPath.match(/^annotate\/([^/]+)(\/(.*))?$/);
        if (annotateMatch) {
          const tabId = annotateMatch[1];
          const subRoute = annotateMatch[3] || '';
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          const filePath = tab.path;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
          const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
          const is3D = ['stl', '3mf'].includes(ext);
          const isPdf = ext === 'pdf';
          const isMarkdown = ext === 'md';

          // Sub-route: GET /file — re-read file content from disk
          if (req.method === 'GET' && subRoute === 'file') {
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(content);
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/file failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: POST /save — save file content
          if (req.method === 'POST' && subRoute === 'save') {
            try {
              const body = await new Promise<string>((resolve) => {
                let data = '';
                req.on('data', (chunk: Buffer) => data += chunk.toString());
                req.on('end', () => resolve(data));
              });
              const parsed = JSON.parse(body || '{}');
              const fileContent = parsed.content;
              if (typeof fileContent !== 'string') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing content');
                return;
              }
              fs.writeFileSync(filePath, fileContent, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              log('ERROR', `POST /api/annotate/:id/save failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: GET /api/mtime — file modification time
          if (req.method === 'GET' && subRoute === 'api/mtime') {
            try {
              const stat = fs.statSync(filePath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ mtime: stat.mtimeMs }));
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/api/mtime failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: GET /api/image, /api/video, /api/model, /api/pdf — raw binary content
          if (req.method === 'GET' && (subRoute === 'api/image' || subRoute === 'api/video' || subRoute === 'api/model' || subRoute === 'api/pdf')) {
            try {
              const data = fs.readFileSync(filePath);
              const mimeType = getMimeTypeForFile(filePath);
              res.writeHead(200, {
                'Content-Type': mimeType,
                'Content-Length': data.length,
                'Cache-Control': 'no-cache',
              });
              res.end(data);
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/${subRoute} failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Default: serve the annotator HTML template
          if (req.method === 'GET' && (subRoute === '' || subRoute === undefined)) {
            try {
              const templateFile = is3D ? '3d-viewer.html' : 'open.html';
              const tplPath = path.resolve(__dirname, `../../../templates/${templateFile}`);
              let html = fs.readFileSync(tplPath, 'utf-8');

              const fileName = path.basename(filePath);
              const fileSize = fs.statSync(filePath).size;

              if (is3D) {
                html = html.replace(/\{\{FILE\}\}/g, fileName);
                html = html.replace(/\{\{FILE_PATH_JSON\}\}/g, JSON.stringify(filePath));
                html = html.replace(/\{\{FORMAT\}\}/g, ext);
              } else {
                html = html.replace(/\{\{FILE\}\}/g, fileName);
                html = html.replace(/\{\{FILE_PATH\}\}/g, filePath);
                html = html.replace(/\{\{BUILDER_ID\}\}/g, '');
                html = html.replace(/\{\{LANG\}\}/g, getLanguageForExt(ext));
                html = html.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
                html = html.replace(/\{\{IS_IMAGE\}\}/g, String(isImage));
                html = html.replace(/\{\{IS_VIDEO\}\}/g, String(isVideo));
                html = html.replace(/\{\{IS_PDF\}\}/g, String(isPdf));
                html = html.replace(/\{\{FILE_SIZE\}\}/g, String(fileSize));

                // Inject initialization script (template loads content via fetch)
                let initScript: string;
                if (isImage) {
                  initScript = `initImage(${fileSize});`;
                } else if (isVideo) {
                  initScript = `initVideo(${fileSize});`;
                } else if (isPdf) {
                  initScript = `initPdf(${fileSize});`;
                } else {
                  initScript = `fetch('file').then(r=>r.text()).then(init);`;
                }
                html = html.replace('// FILE_CONTENT will be injected by the server', initScript);
              }

              // Handle ?line= query param for scroll-to-line
              const lineParam = url.searchParams.get('line');
              if (lineParam) {
                const scrollScript = `<script>window.addEventListener('load',()=>{setTimeout(()=>{const el=document.querySelector('[data-line="${lineParam}"]');if(el){el.scrollIntoView({block:'center'});el.classList.add('highlighted-line');}},200);})</script>`;
                html = html.replace('</body>', `${scrollScript}</body>`);
              }

              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(html);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end(`Failed to serve annotator: ${(err as Error).message}`);
            }
            return;
          }
        }

        // Unhandled API route
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API endpoint not found', path: apiPath }));
        return;
      }

      // For WebSocket paths, let the upgrade handler deal with it
      if (isWsPath) {
        // WebSocket paths are handled by the upgrade handler
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('WebSocket connections should use ws:// protocol');
        return;
      }

      // If we get here for non-API, non-WS paths and React dashboard is not available
      if (!hasReactDashboard) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Dashboard not available');
        return;
      }

      // Fallback for unmatched paths
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    log('ERROR', `Request error: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

// SECURITY: Bind to localhost only to prevent network exposure
server.listen(port, '127.0.0.1', async () => {
  log('INFO', `Tower server listening at http://localhost:${port}`);

  // Initialize shepherd session manager for persistent terminals
  const socketDir = path.join(homedir(), '.codev', 'run');
  const shepherdScript = path.join(__dirname, '..', '..', 'terminal', 'shepherd-main.js');
  shepherdManager = new SessionManager({
    socketDir,
    shepherdScript,
    nodeExecutable: process.execPath,
  });
  const staleCleaned = await shepherdManager.cleanupStaleSockets();
  if (staleCleaned > 0) {
    log('INFO', `Cleaned up ${staleCleaned} stale shepherd socket(s)`);
  }
  log('INFO', 'Shepherd session manager initialized');

  // Spec 0105 Phase 4: Initialize terminal management module
  initTerminals({
    log,
    shepherdManager,
    registerKnownProject,
    getKnownProjectPaths,
  });

  // Spec 0105 Phase 3: Initialize instance lifecycle module
  // Must be before reconcileTerminalSessions() so instance APIs are available
  // as soon as the server starts accepting requests.
  initInstances({
    log,
    projectTerminals: getProjectTerminals(),
    getTerminalManager,
    shepherdManager,
    getProjectTerminalsEntry,
    saveTerminalSession,
    deleteTerminalSession,
    deleteProjectTerminalSessions,
    getTerminalsForProject,
  });

  // TICK-001: Reconcile terminal sessions from previous run
  await reconcileTerminalSessions();

  // Spec 0100: Start background gate watcher for af send notifications
  startGateWatcher();
  log('INFO', 'Gate watcher started (10s poll interval)');

  // Spec 0097 Phase 4 / Spec 0105 Phase 2: Initialize cloud tunnel
  await initTunnel(
    { port, log, projectTerminals: getProjectTerminals(), terminalManager: getTerminalManager() },
    { getInstances },
  );
});

// Initialize terminal WebSocket server (Phase 2 - Spec 0090)
terminalWss = new WebSocketServer({ noServer: true });

// WebSocket upgrade handler for terminal connections and proxying
server.on('upgrade', async (req, socket, head) => {
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

    terminalWss!.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWebSocket(ws, session, req);
    });
    return;
  }

  // Phase 4 (Spec 0090): Handle project WebSocket routes directly
  // Route: /project/:encodedPath/ws/terminal/:terminalId
  if (!reqUrl.pathname.startsWith('/project/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathParts = reqUrl.pathname.split('/');
  // ['', 'project', base64urlPath, 'ws', 'terminal', terminalId]
  const encodedPath = pathParts[2];

  if (!encodedPath) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Decode Base64URL (RFC 4648) - NOT URL encoding
  // Wrap in try/catch to handle malformed Base64 input gracefully
  let projectPath: string;
  try {
    projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    // Support both POSIX (/) and Windows (C:\) paths
    if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
      throw new Error('Invalid project path');
    }
    // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
    projectPath = normalizeProjectPath(projectPath);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check for terminal WebSocket route: /project/:path/ws/terminal/:id
  const wsMatch = reqUrl.pathname.match(/^\/project\/[^/]+\/ws\/terminal\/([^/]+)$/);
  if (wsMatch) {
    const terminalId = wsMatch[1];
    const manager = getTerminalManager();
    const session = manager.getSession(terminalId);

    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    terminalWss!.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWebSocket(ws, session, req);
    });
    return;
  }

  // Unhandled WebSocket route
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});
