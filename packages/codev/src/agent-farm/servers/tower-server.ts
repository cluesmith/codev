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
import { setCodevConfigNotifier, stopAllCodevConfigWatchers } from './codev-config-watcher.js';
import { getGlobalDb } from '../db/index.js';
import { runBootConsolidation } from '../db/consolidate.js';
import { DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { validateHost } from '../utils/server-utils.js';
import { version } from '../../version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting: cleanup interval for token bucket
const rateLimitCleanupInterval = startRateLimitCleanup();

// Shellper session manager (initialized at startup)
let shellperManager: SessionManager | null = null;
let shellperCleanupInterval: NodeJS.Timeout | null = null;
let terminalPartialMonitorInterval: NodeJS.Timeout | null = null;

// Observability for Issue #1047: the ring-buffer partial is kept whole (no
// byte cap) so reconnection replay stays faithful, which means a no-newline
// full-screen TUI grows it without bound. This monitor surfaces that growth so
// we can tell whether it's ever a real memory concern. Logged periodically;
// warned past this size.
const PARTIAL_WARN_BYTES = 4 * 1024 * 1024;
const TERMINAL_MONITOR_INTERVAL_MS = 60_000;

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

// #983: stamped once at process boot so `GET /api/version` reports when *this*
// running Tower started — distinguishing it from a freshly-installed binary.
const startedAt = new Date().toISOString();

// Bridge mode: Tower binds to non-localhost when explicitly enabled.
// BRIDGE_MODE=1 is the opt-in flag; without it, no non-localhost bind is possible.
// BRIDGE_TOWER_HOST specifies the bind address when bridge mode is enabled
// (default: 127.0.0.1 — the spawned tower-server inherits process.env from the afx CLI).
const bridgeMode = process.env.BRIDGE_MODE === '1';
const bindHost = bridgeMode
  ? validateHost(process.env.BRIDGE_TOWER_HOST || '127.0.0.1')
  : '127.0.0.1';

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

  // 4. Stop rate limit cleanup, shellper periodic cleanup, and SSE heartbeat
  clearInterval(rateLimitCleanupInterval);
  if (shellperCleanupInterval) clearInterval(shellperCleanupInterval);
  if (terminalPartialMonitorInterval) clearInterval(terminalPartialMonitorInterval);
  clearInterval(sseHeartbeatInterval);

  // 4b. Flush and stop send buffer (Spec 403) — delivers any deferred messages
  stopSendBuffer();

  // 5. Stop cron scheduler (Spec 399)
  shutdownCron();

  // 6. Disconnect tunnel (Spec 0097 Phase 4 / Spec 0105 Phase 2)
  shutdownTunnel();

  // 6b. Close per-workspace .codev/config(.local).json watchers.
  stopAllCodevConfigWatchers();

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

/** Remove dead SSE clients from the array (by id list). */
function removeDeadSseClients(deadIds: string[]): void {
  for (const id of deadIds) {
    const index = sseClients.findIndex(c => c.id === id);
    if (index !== -1) {
      sseClients.splice(index, 1);
      log('INFO', `SSE client removed (dead): ${id}`);
    }
  }
}

/**
 * Broadcast a notification to all connected SSE clients.
 * Detects and removes dead clients during broadcast.
 */
function broadcastNotification(notification: { type: string; title: string; body: string; workspace?: string }): void {
  const id = ++notificationIdCounter;
  const data = JSON.stringify({ ...notification, id });
  const message = `id: ${id}\ndata: ${data}\n\n`;

  const deadIds: string[] = [];
  for (const client of sseClients) {
    if (client.res.destroyed || client.res.writableEnded) {
      deadIds.push(client.id);
      continue;
    }
    try {
      client.res.write(message);
    } catch {
      deadIds.push(client.id);
    }
  }
  if (deadIds.length > 0) removeDeadSseClients(deadIds);
}

// Heartbeat interval — detects half-open SSE connections (Bugfix #580)
// Also evicts connections older than max-age to prevent leaks from
// tunnel-proxied clients that don't properly close (clients auto-reconnect).
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;
const SSE_MAX_AGE_BASE_MS = 5 * 60_000; // 5 minutes base
const SSE_MAX_AGE_JITTER_MS = 60_000;    // ±1 minute jitter (Bugfix #1124)
const sseHeartbeatInterval = setInterval(() => {
  if (sseClients.length === 0) return;
  const now = Date.now();
  const deadIds: string[] = [];
  for (const client of sseClients) {
    if (client.res.destroyed || client.res.writableEnded) {
      deadIds.push(client.id);
      continue;
    }
    // Bugfix #1124: per-client jitter prevents synchronized eviction bursts.
    // Each client gets a max-age in the range [4min, 6min] instead of a
    // fixed 5 minutes, so evictions are spread over a 2-minute window.
    const maxAge = SSE_MAX_AGE_BASE_MS + (client.maxAgeJitterMs ?? 0);
    if (now - client.connectedAt > maxAge) {
      try { client.res.end(); } catch { /* already dead */ }
      deadIds.push(client.id);
      continue;
    }
    try {
      client.res.write(':heartbeat\n\n');
    } catch {
      deadIds.push(client.id);
    }
  }
  if (deadIds.length > 0) removeDeadSseClients(deadIds);
}, SSE_HEARTBEAT_INTERVAL_MS);
sseHeartbeatInterval.unref();

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
const reactDashboardPath = path.resolve(__dirname, '../../../dashboard-dist');
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
  version,
  startedAt,
  templatePath,
  reactDashboardPath,
  hasReactDashboard,
  getShellperManager: () => shellperManager,
  broadcastNotification,
  addSseClient: (client: SSEClient) => {
    // Bugfix #1124: reject instead of evict to prevent thundering herd.
    // Eviction causes the evicted client to reconnect, which pushes the
    // count back to the cap and evicts another — a chain reaction that
    // exhausts ephemeral ports via TIME_WAIT accumulation.
    const SSE_MAX_CLIENTS = 200;
    if (sseClients.length >= SSE_MAX_CLIENTS) {
      log('WARN', `SSE cap reached (${SSE_MAX_CLIENTS}), rejecting client: ${client.id}`);
      return false;
    }
    // Bugfix #1124: assign per-client jitter for max-age eviction
    client.maxAgeJitterMs = Math.floor(Math.random() * SSE_MAX_AGE_JITTER_MS * 2) - SSE_MAX_AGE_JITTER_MS;
    sseClients.push(client);
    return true;
  },
  removeSseClient: (id: string) => {
    const index = sseClients.findIndex(c => c.id === id);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  },
};

// Wire the broadcast function into the codev config-file watcher so edits
// to .codev/config{,.local}.json fan out as `codev-config-updated` SSE
// events. The actual watcher is installed lazily by any config-resolving
// route handler (/api/worktree-config, /api/activity-hooks) on first request.
setCodevConfigNotifier(broadcastNotification);

// ============================================================================
// Create server — delegates all HTTP handling to tower-routes.ts
// ============================================================================

const server = http.createServer(async (req, res) => {
  await handleRequest(req, res, routeCtx);
});

// SECURITY: Bind to configured host (default 127.0.0.1 for localhost-only).
// Bridge mode enables non-localhost binding when BRIDGE_MODE=1 is set.
server.listen(port, bindHost, async () => {
  if (bridgeMode) {
    log('WARN', `Bridge mode is ENABLED — Tower is listening on ${bindHost} network interfaces.`);
  }
  // Display localhost in URLs for local UX even when bound to all interfaces.
  const displayHost = bindHost === '0.0.0.0' ? 'localhost' : bindHost;
  log('INFO', `Tower server listening at http://${displayHost}:${port}`);

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

  // Issue #1047 observability: periodically report terminal ring-buffer
  // partial sizes so a no-newline TUI stream (the freeze trigger) is visible
  // in the Tower log. Cheap (O(sessions) once a minute) and .unref()'d so it
  // never holds the process open.
  terminalPartialMonitorInterval = setInterval(() => {
    try {
      const partials = getTerminalManager().inspectPartials();
      if (partials.length === 0) return;
      let maxBytes = 0;
      for (const p of partials) {
        if (p.partialBytes > maxBytes) maxBytes = p.partialBytes;
        if (p.partialBytes >= PARTIAL_WARN_BYTES) {
          log('WARN', `Terminal ${p.id} (${p.label}) ring-buffer partial at ${Math.round(p.partialBytes / 1024)} KB — large no-newline TUI stream growing unbounded (#1047)`);
        }
      }
      log('INFO', `Terminal partial monitor: ${partials.length} session(s), max partial ${Math.round(maxBytes / 1024)} KB`);
    } catch (err) {
      log('ERROR', `Terminal partial monitor failed: ${(err as Error).message}`);
    }
  }, TERMINAL_MONITOR_INTERVAL_MS);
  terminalPartialMonitorInterval.unref();

  // Spec 403: Start send buffer for typing-aware message delivery
  startSendBuffer(log);

  // Issue #1118: one-time state.db → global.db consolidation. Runs once ever
  // (strict `_consolidation` marker), BEFORE initInstances() reads architect /
  // builder rows. Migrates this boot's active state.db; satellite files are
  // recovered on demand via `afx db consolidate <path>`.
  try {
    const consolidation = runBootConsolidation(getGlobalDb());
    if (consolidation?.migrated) {
      const moved = consolidation.stats.reduce((n, s) => n + s.inserted + s.updated, 0);
      log('INFO', `state.db consolidation: migrated ${moved} row(s) from ${consolidation.sourcePath} into global.db; source renamed to ${consolidation.renamedTo}`);
    }
  } catch (err) {
    log('ERROR', `state.db consolidation failed: ${(err as Error).message}`);
  }

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

