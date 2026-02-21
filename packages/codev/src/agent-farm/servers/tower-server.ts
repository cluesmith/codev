#!/usr/bin/env node

/**
 * Tower server for Agent Farm — orchestrator module.
 * Spec 0105: Tower Server Decomposition
 *
 * Creates HTTP/WS servers, initializes all subsystem modules, and
 * delegates HTTP request handling to tower-routes.ts.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { WebSocketServer } from 'ws';
import { SessionManager } from '../../terminal/session-manager.js';
import type { SSEClient } from './tower-types.js';
import { startRateLimitCleanup } from './tower-utils.js';
import {
  initTunnel,
  shutdownTunnel,
} from './tower-tunnel.js';
import { initCron, shutdownCron } from './tower-cron.js';
import { resolveTarget } from './tower-messages.js';
import {
  initInstances,
  shutdownInstances,
  registerKnownWorkspace,
  getKnownWorkspacePaths,
  getInstances,
} from './tower-instances.js';
import {
  initTerminals,
  shutdownTerminals,
  getWorkspaceTerminals,
  getTerminalManager,
  getWorkspaceTerminalsEntry,
  saveTerminalSession,
  deleteTerminalSession,
  deleteWorkspaceTerminalSessions,
  deleteFileTabsForWorkspace,
  getTerminalsForWorkspace,
  reconcileTerminalSessions,
} from './tower-terminals.js';
import {
  setupUpgradeHandler,
} from './tower-websocket.js';
import { handleRequest, startSendBuffer, stopSendBuffer } from './tower-routes.js';
import type { RouteContext } from './tower-routes.js';
import { DEFAULT_TOWER_PORT } from '../lib/tower-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting: cleanup interval for token bucket
const rateLimitCleanupInterval = startRateLimitCleanup();

// Shellper session manager (initialized at startup)
let shellperManager: SessionManager | null = null;
let shellperCleanupInterval: NodeJS.Timeout | null = null;

// Parse arguments with Commander
const program = new Command()
  .name('tower-server')
  .description('Tower dashboard for Agent Farm - centralized view of all instances')
  .argument('[port]', 'Port to listen on', String(DEFAULT_TOWER_PORT))
  .option('-p, --port <port>', 'Port to listen on (overrides positional argument)')
  .option('-l, --log-file <path>', 'Log file path for server output')
  .parse(process.argv);

const opts = program.opts();
const args = program.args;
const portArg = opts.port || args[0] || String(DEFAULT_TOWER_PORT);
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

  // 3. Shellper clients: do NOT call shellperManager.shutdown() here.
  // SessionManager.shutdown() disconnects sockets, which triggers ShellperClient
  // 'close' events → PtySession exit(-1) → SQLite row deletion. This would erase
  // the rows that reconcileTerminalSessions() needs on restart.
  // Instead, let the process exit naturally — OS closes all sockets, and shellpers
  // detect the disconnection and keep running. SQLite rows are preserved.
  if (shellperManager) {
    log('INFO', 'Shellper sessions will continue running (sockets close on process exit)');
  }

  // 4. Stop rate limit cleanup and shellper periodic cleanup
  clearInterval(rateLimitCleanupInterval);
  if (shellperCleanupInterval) clearInterval(shellperCleanupInterval);

  // 4b. Flush and stop send buffer (Spec 403) — delivers any deferred messages
  stopSendBuffer();

  // 5. Stop cron scheduler (Spec 399)
  shutdownCron();

  // 6. Disconnect tunnel (Spec 0097 Phase 4 / Spec 0105 Phase 2)
  shutdownTunnel();

  // 7. Tear down instance module (Spec 0105 Phase 3)
  shutdownInstances();

  // 8. Tear down terminal module (Spec 0105 Phase 4) — shuts down terminal manager
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

// SSE (Server-Sent Events) infrastructure for push notifications
const sseClients: SSEClient[] = [];
let notificationIdCounter = 0;

/**
 * Broadcast a notification to all connected SSE clients
 */
function broadcastNotification(notification: { type: string; title: string; body: string; workspace?: string }): void {
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
  log('WARN', 'React dashboard not found - workspace dashboards will not work');
}

// ============================================================================
// Route context — wires orchestrator state into route handlers
// ============================================================================

const routeCtx: RouteContext = {
  log,
  port,
  templatePath,
  reactDashboardPath,
  hasReactDashboard,
  getShellperManager: () => shellperManager,
  broadcastNotification,
  addSseClient: (client: SSEClient) => {
    sseClients.push(client);
  },
  removeSseClient: (id: string) => {
    const index = sseClients.findIndex(c => c.id === id);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  },
};

// ============================================================================
// Create server — delegates all HTTP handling to tower-routes.ts
// ============================================================================

const server = http.createServer(async (req, res) => {
  await handleRequest(req, res, routeCtx);
});

// SECURITY: Bind to localhost only to prevent network exposure
server.listen(port, '127.0.0.1', async () => {
  log('INFO', `Tower server listening at http://localhost:${port}`);

  // Initialize shellper session manager for persistent terminals
  const socketDir = process.env.SHELLPER_SOCKET_DIR || path.join(homedir(), '.codev', 'run');
  const shellperScript = path.join(__dirname, '..', '..', 'terminal', 'shellper-main.js');
  shellperManager = new SessionManager({
    socketDir,
    shellperScript,
    nodeExecutable: process.execPath,
    logger: (msg: string) => log('INFO', msg),
  });
  const staleCleaned = await shellperManager.cleanupStaleSockets();
  if (staleCleaned > 0) {
    log('INFO', `Cleaned up ${staleCleaned} stale shellper socket(s)`);
  }

  // Periodic cleanup: catch orphaned sockets during Tower lifetime (not just at startup)
  const cleanupIntervalMs = Math.max(parseInt(process.env.SHELLPER_CLEANUP_INTERVAL_MS || '60000', 10) || 60000, 1000);
  shellperCleanupInterval = setInterval(async () => {
    try {
      const cleaned = await shellperManager!.cleanupStaleSockets();
      if (cleaned > 0) {
        log('INFO', `Periodic cleanup: removed ${cleaned} stale shellper socket(s)`);
      }
    } catch (err) {
      log('ERROR', `Periodic shellper cleanup failed: ${(err as Error).message}`);
    }
  }, cleanupIntervalMs);

  log('INFO', 'Shellper session manager initialized');

  // Spec 0105 Phase 4: Initialize terminal management module
  initTerminals({
    log,
    shellperManager,
    registerKnownWorkspace,
    getKnownWorkspacePaths,
  });

  // Spec 403: Start send buffer for typing-aware message delivery
  startSendBuffer(log);

  // TICK-001: Reconcile terminal sessions from previous run.
  // Must run BEFORE initInstances() so that API request handlers
  // (getInstances → getTerminalsForWorkspace) cannot race with reconciliation.
  // Without this ordering, a dashboard poll arriving during reconciliation
  // triggers on-the-fly shellper reconnection that conflicts with the
  // reconciliation's own reconnection — the shellper's single-connection
  // model causes the first client to be replaced, corrupting the session
  // and deleting the architect terminal's socket file (Bugfix #274).
  await reconcileTerminalSessions();

  // Bugfix #341: Kill orphaned shellper processes not in active sessions.
  // Must run AFTER reconciliation so that reconnected sessions are in the
  // active map and won't be killed. Catches shellpers from crashed tests
  // or previous Tower instances that lost their socket files.
  const orphansKilled = await shellperManager.killOrphanedShellpers();
  if (orphansKilled > 0) {
    log('INFO', `Killed ${orphansKilled} orphaned shellper process(es)`);
  }

  // Spec 0105 Phase 3: Initialize instance lifecycle module.
  // Placed after reconciliation so getInstances() returns [] during startup
  // (since _deps is null), preventing race conditions with reconciliation.
  initInstances({
    log,
    workspaceTerminals: getWorkspaceTerminals(),
    getTerminalManager,
    shellperManager,
    getWorkspaceTerminalsEntry,
    saveTerminalSession,
    deleteTerminalSession,
    deleteWorkspaceTerminalSessions,
    deleteFileTabsForWorkspace,
    getTerminalsForWorkspace,
  });

  // Spec 399: Initialize cron scheduler after instances are ready
  initCron({
    log,
    getKnownWorkspacePaths,
    resolveTarget,
    getTerminalManager: () => getTerminalManager(),
  });

  // Spec 0097 Phase 4 / Spec 0105 Phase 2: Initialize cloud tunnel
  await initTunnel(
    { port, log, workspaceTerminals: getWorkspaceTerminals(), terminalManager: getTerminalManager() },
    { getInstances },
  );
});

// Initialize terminal WebSocket server (Phase 2 - Spec 0090)
terminalWss = new WebSocketServer({ noServer: true });

// Spec 0105 Phase 5: WebSocket upgrade handler extracted to tower-websocket.ts
setupUpgradeHandler(server, terminalWss, port);

