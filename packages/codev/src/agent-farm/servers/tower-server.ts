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
import { sweepShellperHusks, resolveHuskGraceMs } from './shellper-husk-sweep.js';
import {
  sweepSessionLogs,
  measureSessionLogs,
  resolveLogRetentionDays,
  resolveLogSweepIntervalMs,
  formatBytes,
  MS_PER_DAY,
} from './session-log-sweep.js';
import {
  initTunnel,
  shutdownTunnel,
} from './tower-tunnel.js';
import { initCron, shutdownCron } from './tower-cron.js';
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
import { handleRequest, deliverCronMessage } from './tower-routes.js';
import { startMailboxDrainer, stopMailboxDrainer } from './mailbox-wiring.js';
import { shutdownDelayedSends } from './delayed-send.js';
import type { RouteContext } from './tower-routes.js';
import { setCodevConfigNotifier, stopAllCodevConfigWatchers } from './codev-config-watcher.js';
import { getGlobalDb } from '../db/index.js';
import { runBootConsolidation } from '../db/consolidate.js';
import { DEFAULT_TOWER_PORT, AGENT_FARM_DIR } from '../lib/tower-client.js';
import { validateHost } from '../utils/server-utils.js';
import { version } from '../../version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting: cleanup interval for token bucket
const rateLimitCleanupInterval = startRateLimitCleanup();

// Shellper session manager (initialized at startup)
let shellperManager: SessionManager | null = null;
let shellperCleanupInterval: NodeJS.Timeout | null = null;
let shellperHuskSweepInterval: NodeJS.Timeout | null = null;
let terminalPartialMonitorInterval: NodeJS.Timeout | null = null;
let sessionLogSweepInterval: NodeJS.Timeout | null = null;

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
  if (shellperHuskSweepInterval) clearInterval(shellperHuskSweepInterval);
  if (terminalPartialMonitorInterval) clearInterval(terminalPartialMonitorInterval);
  if (sessionLogSweepInterval) clearInterval(sessionLogSweepInterval);
  clearInterval(sseHeartbeatInterval);

  // 4b. Drop pending delayed sends FIRST (Spec 1307 `--delay`). Cancels every timer
  // still waiting to fire and bumps the delayed-send generation, so a timer that
  // fires mid-shutdown is a no-op at its delivery site rather than enqueuing a
  // mailbox row after teardown has begun. Delayed sends are in-memory by design
  // (dropped on restart) — the re-homed due-time callback enqueues to the mailbox
  // only WHEN due, so a not-yet-due send has nothing persisted to recover; re-send
  // if still wanted.
  const droppedDelayed = shutdownDelayedSends();
  if (droppedDelayed > 0) {
    log('INFO', `Dropped ${droppedDelayed} pending delayed send(s) — re-send them if still wanted`);
  }

  // 4c. Stop the mailbox backstop drainer (Spec 1313) — no force-flush; held
  // rows persist in SQLite and redeliver on a clean gate after restart.
  stopMailboxDrainer();

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
// Readiness gate (Issue #1261)
// ============================================================================
//
// The port must bind first — it is the single-Tower mutex (a second
// `afx tower start` detects EADDRINUSE) and the thing every readiness check
// probes. But binding used to mean "serving", and the boot sequence that wires
// up the request handlers' dependencies ran *after* the bind. Requests landing
// in that window were answered with whatever a half-wired Tower could produce:
// `DELETE /api/terminals/:id` returned 404 for a terminal that plainly existed,
// because `killTerminalWithShellper()` bails when `_deps` is null.
//
// So: bind immediately, but hold requests until `bootSequence()` finishes.
// Readiness becomes deterministic instead of a function of how long the boot's
// disk work happens to take on this machine.

// Boot is bounded by the maintenance work that stays *inside* it; anything
// slower than this is a hang, and a held request should not hang with it.
const BOOT_READY_TIMEOUT_MS = 20_000;

const bootStartedAtMs = Date.now();
let bootComplete = false;
const bootWaiters: Array<() => void> = [];

/** Open the gate: release every held request and admit all future ones. */
function markBootComplete(): void {
  if (bootComplete) return;
  bootComplete = true;
  log('INFO', `Tower ready — serving API requests (${Date.now() - bootStartedAtMs}ms after process start)`);
  for (const release of bootWaiters.splice(0)) release();
}

/** Resolves true once boot completes, or false if it takes longer than `timeoutMs`. */
function whenBootComplete(timeoutMs: number): Promise<boolean> {
  if (bootComplete) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const index = bootWaiters.indexOf(release);
      if (index !== -1) bootWaiters.splice(index, 1);
      resolve(false);
    }, timeoutMs);
    const release = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    bootWaiters.push(release);
  });
}

// ============================================================================
// Create server — delegates all HTTP handling to tower-routes.ts
// ============================================================================

const server = http.createServer(async (req, res) => {
  if (!bootComplete) {
    if (!(await whenBootComplete(BOOT_READY_TIMEOUT_MS))) {
      log('ERROR', `Boot did not complete within ${BOOT_READY_TIMEOUT_MS}ms; rejecting ${req.method} ${req.url} with 503`);
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: 'STARTING_UP', message: 'Tower is starting up. Try again shortly.' }));
      return;
    }
    // The client may have given up while it was held.
    if (res.destroyed || res.writableEnded) return;
  }
  await handleRequest(req, res, routeCtx);
});

// SECURITY: Bind to configured host (default 127.0.0.1 for localhost-only).
// Bridge mode enables non-localhost binding when BRIDGE_MODE=1 is set.
server.listen(port, bindHost, () => {
  if (bridgeMode) {
    log('WARN', `Bridge mode is ENABLED — Tower is listening on ${bindHost} network interfaces.`);
  }
  // Display localhost in URLs for local UX even when bound to all interfaces.
  const displayHost = bindHost === '0.0.0.0' ? 'localhost' : bindHost;
  log('INFO', `Tower server listening at http://${displayHost}:${port}`);

  bootSequence().catch((err) => {
    // Preserve the previous fail-fast behaviour: before Issue #1261 this body
    // was the listen callback, so a throw surfaced as an unhandled rejection
    // and the process-level handler exited. Keep exiting rather than serving
    // from a half-wired Tower.
    log('ERROR', `Tower boot sequence failed: ${(err as Error).message}\n${(err as Error).stack}`);
    process.exit(1);
  });
});

/**
 * Everything that must be wired up before Tower can answer API requests
 * correctly. Runs once, immediately after the port binds; requests are held by
 * the readiness gate above until it calls markBootComplete().
 */
async function bootSequence(): Promise<void> {
  // Initialize shellper session manager for persistent terminals
  const socketDir = process.env.SHELLPER_SOCKET_DIR || path.join(homedir(), '.codev', 'run');
  const shellperScript = path.join(__dirname, '..', '..', 'terminal', 'shellper-main.js');
  shellperManager = new SessionManager({
    socketDir,
    shellperScript,
    nodeExecutable: process.execPath,
    logger: (msg: string) => log('INFO', msg),
  });

  // #1198: a shellper connection that dies must leave a trace. Before this
  // subscription existed, 'session-error' had no consumer anywhere, so a
  // failed reconnect was completely invisible in the Tower log.
  shellperManager.on('session-error', (sessionId: string, err: Error) => {
    log('ERROR', `Shellper session ${sessionId}: ${err.message}`);
  });

  // #1264: SessionManager stopped respawning a session for a reason the user
  // needs to see. Put it in the terminal itself, not just the Tower log — the
  // person affected is watching a pane that just went quiet, and has no reason
  // to go reading server logs to find out why.
  shellperManager.on('session-gave-up', (sessionId: string, reason: string) => {
    log('ERROR', `Shellper session ${sessionId} gave up: ${reason}`);
    const ptySession = getTerminalManager().findByShellperSessionId(sessionId);
    if (!ptySession) {
      log('WARN', `Shellper session ${sessionId} gave up but no matching terminal session found to notify`);
      return;
    }
    ptySession.notice(reason);
  });

  // #1198: SessionManager re-established a session's connection in place
  // after an unexpected socket close. Re-attach the replacement client to the
  // PtySession so viewer I/O resumes (attachShellper is idempotent and
  // cancels the pending close-grace teardown). Replay is deliberately empty:
  // the ring buffer already holds the session history.
  shellperManager.on('session-reconnected', (sessionId: string, client: import('../../terminal/shellper-client.js').IShellperClient) => {
    const ptySession = getTerminalManager().findByShellperSessionId(sessionId);
    if (!ptySession) {
      log('WARN', `Shellper session ${sessionId} reconnected but no matching terminal session found`);
      return;
    }
    const info = shellperManager!.getSessionInfo(sessionId);
    let pid = -1;
    if (info) {
      pid = info.pid;
    }
    ptySession.attachShellper(client, Buffer.alloc(0), pid, ptySession.shellperSessionId ?? sessionId);
    log('INFO', `Shellper session ${sessionId} re-attached to terminal ${ptySession.id}`);
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

  // Issue #1227: husk sweep — a stricter second pass that reaps shellpers
  // killOrphanedShellpers() can never reach, because it unconditionally
  // protects any shellper whose socket still responds. A husk (child exited,
  // shellper still listening) answers its socket, so it needs the stricter
  // unregistered+childless+aged predicate instead. See shellper-husk-sweep.ts.
  const huskGraceMs = resolveHuskGraceMs();
  const parsedHuskSweepIntervalMs = parseInt(process.env.SHELLPER_HUSK_SWEEP_INTERVAL_MS || '3600000', 10);
  const huskSweepIntervalMs = Math.max(
    Number.isNaN(parsedHuskSweepIntervalMs) ? 3600000 : parsedHuskSweepIntervalMs,
    1000,
  );
  const runHuskSweep = async (): Promise<void> => {
    try {
      const result = await sweepShellperHusks({
        socketDir,
        db: getGlobalDb(),
        graceMs: huskGraceMs,
        log: (msg: string) => log('INFO', msg),
      });
      if (result.swept > 0) {
        log('INFO', `Husk sweep: reaped ${result.swept} shellper husk(s)`);
      }
    } catch (err) {
      log('ERROR', `Husk sweep failed: ${(err as Error).message}`);
    }
  };
  shellperHuskSweepInterval = setInterval(runHuskSweep, huskSweepIntervalMs);

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

  // Spec 1313: start the mailbox backstop drainer (prunes terminal rows, then
  // periodically redelivers held mail on a clean render-gate). Replaces the
  // retired Spec 403 SendBuffer.
  startMailboxDrainer(log);

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

  // Issue #1261 test hook: widen the pre-wiring window to a known duration so
  // the startup race is deterministic instead of a function of this machine's
  // process table and session-log volume. Never set outside tests.
  const bootDelayMs = parseInt(process.env.AF_TEST_BOOT_DELAY_MS || '0', 10);
  if (bootDelayMs > 0) {
    log('WARN', `AF_TEST_BOOT_DELAY_MS=${bootDelayMs} — delaying dependency wiring (test hook)`);
    await new Promise((r) => setTimeout(r, bootDelayMs));
  }

  // Spec 0105 Phase 3: Initialize instance lifecycle module.
  // Placed after reconciliation so getInstances() cannot race with it.
  //
  // Issue #1261: this used to be the *last* step of the boot sequence, after
  // the husk sweep and the session-log retention scan — both of which scale
  // with disk state. Every route that touches `_deps` was therefore broken for
  // as long as those scans took. It only needs to follow reconciliation, so it
  // now runs here and the two maintenance sweeps run after readiness instead.
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

  // Spec 399: Initialize cron scheduler after instances are ready.
  // Spec 1313 (Phase 6): cron delivers through the mailbox + gate via `deliverCronMessage`
  // (the same single gated path as `handleSend`) instead of a blind PTY write.
  initCron({
    log,
    getKnownWorkspacePaths,
    deliver: (task, message) => deliverCronMessage(task, message, log),
  });

  // Issue #1261: dependency wiring is complete — open the gate. Everything
  // below is maintenance or background service startup: it must not gate the
  // API, and none of it is a prerequisite for a correct response.
  markBootComplete();

  // Issue #1227: run the stricter husk sweep once at startup too, same
  // ordering requirement as killOrphanedShellpers (must run after
  // reconciliation so a reconnected session's shellper is registered).
  // Safe to run post-readiness: the sweep's predicate requires an aged
  // shellper (1h grace by default), so a session created by an incoming
  // request while the sweep runs can never match it.
  await runHuskSweep();

  // Issue #1238: PTY session log retention. Session logs are per-session files
  // in ~/.agent-farm/logs that nothing ever deleted, so they accreted forever
  // (19 GB / 29,728 files on an audited machine). Sweep aged-out logs at
  // startup and then daily. Deliberately placed AFTER reconcileTerminalSessions
  // so surviving sessions are in the terminal manager's map and are excluded by
  // id — the sweep must never unlink a log whose fd is still open.
  const logRetentionDays = resolveLogRetentionDays();
  const sessionLogDir = path.join(AGENT_FARM_DIR, 'logs');
  const runSessionLogSweep = (): void => {
    try {
      sweepSessionLogs({
        logDir: sessionLogDir,
        retentionMs: logRetentionDays * MS_PER_DAY,
        activeSessionIds: getTerminalManager().listSessions().map((s) => s.id),
        log: (msg: string) => log('INFO', msg),
      });
    } catch (err) {
      log('ERROR', `Session log sweep failed: ${(err as Error).message}`);
    }
  };
  if (logRetentionDays === 0) {
    log('INFO', 'Session log retention disabled (AGENT_FARM_LOG_RETENTION_DAYS=0)');
  } else {
    runSessionLogSweep();
    const footprint = measureSessionLogs(sessionLogDir);
    log(
      'INFO',
      `Session logs: ${footprint.files} file(s), ${formatBytes(footprint.bytes)} ` +
      `(retention ${logRetentionDays}d)`,
    );
    sessionLogSweepInterval = setInterval(runSessionLogSweep, resolveLogSweepIntervalMs());
    sessionLogSweepInterval.unref();
  }

  // Spec 0097 Phase 4 / Spec 0105 Phase 2: Initialize cloud tunnel.
  // Deliberately after markBootComplete(): connectTunnel() talks to a remote
  // service, so gating local API readiness on it would make an unreachable
  // cloud endpoint look like a broken Tower.
  await initTunnel(
    { port, log, workspaceTerminals: getWorkspaceTerminals(), terminalManager: getTerminalManager() },
    { getInstances },
  );
}

// Initialize terminal WebSocket server (Phase 2 - Spec 0090)
terminalWss = new WebSocketServer({ noServer: true });

// Spec 0105 Phase 5: WebSocket upgrade handler extracted to tower-websocket.ts
setupUpgradeHandler(server, terminalWss, port);

