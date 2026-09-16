/**
 * Tower command - launches the tower dashboard showing all instances
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, statSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { logger, fatal } from '../utils/logger.js';
import { spawn } from 'node:child_process';
import { getConfig } from '../utils/config.js';
import { DEFAULT_TOWER_PORT, AGENT_FARM_DIR } from '../lib/tower-client.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { isPortAvailable } from '../utils/shell.js';
import Database from 'better-sqlite3';
import { getGlobalDbPath } from '../db/index.js';
import { activeStateDbPath, planMigration } from '../db/consolidate.js';
import { sanitizeAgentEnv, findClaudeSessionMarkers } from '../../lib/agent-env.js';
import { getProcessesOnPort } from '../utils/port.js';

// Log file location
const LOG_FILE = resolve(AGENT_FARM_DIR, 'tower.log');

// Startup verification settings
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_CHECK_INTERVAL_MS = 200;

// Stop settings (#1198): how long towerStop waits for the SIGTERMed process
// to exit before escalating to SIGKILL, and how often it polls.
const STOP_EXIT_TIMEOUT_MS = 8000;
const STOP_CHECK_INTERVAL_MS = 200;

export interface TowerStartOptions {
  port?: number;
  wait?: boolean; // Defaults to true. Set false for fire-and-forget startup.
  dryRunMigration?: boolean; // Issue #1118: preview the state.db→global.db one-off and exit.
}

export interface TowerStopOptions {
  port?: number;
  forceKillAllChildProcesses?: boolean;
}

export function shouldWaitForTowerStart(options: TowerStartOptions = {}): boolean {
  return options.wait ?? true;
}

/**
 * Issue #1118: preview the one-time state.db→global.db migration for this start's
 * active state.db, without spawning the server or applying anything. Opens
 * global.db read-only (or an empty in-memory db if it doesn't exist yet) so the
 * preview is side-effect-free.
 */
async function previewStateDbMigration(): Promise<void> {
  const source = activeStateDbPath();
  const globalPath = getGlobalDbPath();

  logger.header('state.db → global.db migration (dry-run)');
  logger.kv('Active state.db', source);
  logger.kv('Target global.db', globalPath);
  logger.blank();

  if (!existsSync(source)) {
    logger.info('No active state.db at this path — nothing would be migrated on this start.');
    return;
  }

  let globalDb: Database.Database;
  if (existsSync(globalPath)) {
    globalDb = new Database(globalPath, { readonly: true });
  } else {
    globalDb = new Database(':memory:');
  }
  try {
    const plan = planMigration(globalDb, source);
    if (plan.total === 0) {
      logger.info('Active state.db has no rows to migrate.');
      return;
    }
    for (const s of plan.stats) {
      logger.kv(`  ${s.table}`, `${s.inserted} new, ${s.updated} newer (replace), ${s.skipped} older (skip)`);
    }
    logger.blank();
    logger.info('Dry-run only. Run `afx tower start` to apply the one-off on next boot.');
  } finally {
    globalDb.close();
  }
}

/**
 * Write to the tower log file
 */
function logToFile(message: string): void {
  try {
    mkdirSync(AGENT_FARM_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Check if a port is already in use (inverse of isPortAvailable from shell utils)
 */
async function isPortInUse(port: number): Promise<boolean> {
  return !(await isPortAvailable(port));
}

/**
 * Check if the tower server is actually responding
 */
async function isServerResponding(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // /api/status is a keyed route (advisory GHSA-xvjp-7748-v88v). This readiness
    // probe is a trusted local caller, so it sends the shared local key like any
    // other client — otherwise it 401s forever and startup never detects "ready".
    const headers: Record<string, string> = {};
    try {
      headers[TOWER_KEY_HEADER] = ensureLocalKey();
    } catch {
      // Key unavailable — fall through unauthenticated (probe will just fail).
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        method: 'GET',
        timeout: 2000,
        headers,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * The three distinguishable outcomes of waiting for a freshly spawned Tower (Issue #1691).
 * - `started`: the port answered readiness within the budget.
 * - `exited`: the spawned daemon died before the port answered — a fast-exit refusal (the
 *   #1629 owner-lock guard) or any early boot failure. The launcher stops waiting the instant
 *   it observes the exit instead of burning the full timeout on a process already gone.
 * - `timeout`: the budget elapsed with the daemon still alive but not answering (a real hang).
 */
export type TowerStartupOutcome = 'started' | 'exited' | 'timeout';

/**
 * Wait for a freshly spawned Tower to become ready, returning which of the three outcomes
 * occurred. `isReady` is the readiness probe (port answering); `isDaemonAlive` reports whether
 * the spawned daemon process is still running. Both are injectable so the outcome logic can be
 * exercised deterministically without spawning a real server.
 *
 * The tower-server IS the daemon, so once it exits the port can never come up — hence a dead
 * daemon short-circuits to `exited`. A final readiness re-probe closes the benign race where the
 * daemon answered readiness in the same tick it was observed to exit.
 */
export async function waitForServerOutcome(
  isReady: () => Promise<boolean>,
  isDaemonAlive: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<TowerStartupOutcome> {
  const timeoutMs = opts.timeoutMs ?? STARTUP_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? STARTUP_CHECK_INTERVAL_MS;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await isReady()) {
      return 'started';
    }
    if (!isDaemonAlive()) {
      return (await isReady()) ? 'started' : 'exited';
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return 'timeout';
}

/** Current byte length of the tower log (0 if absent) — the boundary for {@link readLogSince}. */
function currentLogOffset(): number {
  try {
    return statSync(LOG_FILE).size;
  } catch {
    return 0;
  }
}

/**
 * Read everything appended to the tower log since `offset` bytes. Surfaces a fast-exiting
 * daemon's own output (e.g. the owner-lock guard's teaching error) verbatim, without dragging in
 * stale lines from previous runs. Returns '' if the file is gone or nothing new was written.
 */
function readLogSince(offset: number): string {
  try {
    const buf = readFileSync(LOG_FILE);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8').trim();
  } catch {
    return '';
  }
}

export { getProcessesOnPort } from '../utils/port.js';

/**
 * Start the tower dashboard
 */
export async function towerStart(options: TowerStartOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_TOWER_PORT;
  const wait = shouldWaitForTowerStart(options);

  // Issue #1118: `--dry-run-migration` previews the state.db→global.db one-off
  // against this start's active state.db and exits without spawning the server.
  // Opens global.db read-only so the preview never applies the migration.
  if (options.dryRunMigration) {
    await previewStateDbMigration();
    return;
  }

  // Check if already running and responding
  if (await isServerResponding(port)) {
    const dashboardUrl = `http://localhost:${port}`;
    logger.info(`Tower already running at ${dashboardUrl}`);
    return;
  }

  // Check if port is in use but not responding (zombie process?)
  if (await isPortInUse(port)) {
    logger.warn(`Port ${port} is in use but tower not responding. Attempting cleanup...`);
    logToFile(`Port ${port} in use but not responding, attempting cleanup`);
    const pids = getProcessesOnPort(port);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        logToFile(`Killed process ${pid} on port ${port}`);
      } catch {
        // Process may have already exited
      }
    }
    // Wait for port to be released
    await new Promise((r) => setTimeout(r, 1000));
  }

  const config = getConfig();

  // Find tower server script
  const tsScript = resolve(config.serversDir, 'tower-server.ts');
  const jsScript = resolve(config.serversDir, 'tower-server.js');

  let command: string;
  let args: string[];

  if (existsSync(tsScript)) {
    // Dev mode: run with tsx
    command = 'npx';
    args = ['tsx', tsScript, String(port), '--log-file', LOG_FILE];
  } else if (existsSync(jsScript)) {
    // Prod mode: run compiled JS
    command = 'node';
    args = [jsScript, String(port), '--log-file', LOG_FILE];
  } else {
    fatal('Tower server not found');
  }

  logger.header('Starting Tower');
  logger.kv('Port', port);
  logger.kv('Log file', LOG_FILE);

  logToFile(`Starting tower server on port ${port}`);
  logToFile(`Command: ${command} ${args.join(' ')}`);

  // Issue #1219: scrub Claude Code session markers before daemonizing. Starting
  // Tower from inside a Claude Code session is routine, and the markers it plants
  // would otherwise bake into the daemon and cascade into every agent it spawns,
  // silently disabling transcript saving (and therefore resume) for all of them.
  const inheritedMarkers = findClaudeSessionMarkers(process.env);
  if (inheritedMarkers.length > 0) {
    logger.info(`Scrubbed inherited Claude Code session markers: ${inheritedMarkers.join(', ')}`);
    logToFile(`Scrubbed inherited Claude Code session markers: ${inheritedMarkers.join(', ')}`);
  }

  // Start tower server fully detached - stdio: 'ignore' ensures parent can exit
  const serverProcess = spawn(command, args, {
    cwd: process.cwd(),
    env: sanitizeAgentEnv(process.env),
    detached: true,
    stdio: 'ignore', // Must be 'ignore' for true daemonization
  });

  if (!serverProcess.pid) {
    logToFile('Failed to spawn tower server process');
    fatal('Failed to start tower server');
  }

  // Detach from parent process
  serverProcess.unref();

  logToFile(`Spawned tower server with PID ${serverProcess.pid}`);

  // Issue #1691: track the daemon's liveness and mark where its own log output begins, so the
  // readiness wait can distinguish a fast-exit (owner-lock refusal, early boot failure) from a
  // genuine hang — and, on a fast-exit, surface the daemon's teaching error verbatim instead of
  // a generic timeout. The offset is captured here (after the launcher's own pre-spawn writes)
  // so readLogSince() returns only what THIS daemon run appended.
  let daemonExited = false;
  serverProcess.on('exit', () => {
    daemonExited = true;
  });
  const logOffsetAtSpawn = currentLogOffset();

  const dashboardUrl = `http://localhost:${port}`;

  if (wait) {
    // Wait for server to actually start responding
    logger.info('Waiting for server to start...');
    const outcome = await waitForServerOutcome(
      () => isServerResponding(port),
      () => !daemonExited
    );

    if (outcome === 'exited') {
      // The daemon died before the port came up: a refusal (the #1629 owner-lock guard) or an
      // early boot failure. Surface its own log output verbatim so the user sees the teaching
      // error, not a generic timeout indistinguishable from a real hang (Issue #1691).
      const reason = readLogSince(logOffsetAtSpawn);
      logToFile('Tower server exited during startup before responding');
      logger.error('Tower server exited during startup before it became ready:');
      if (reason) {
        console.error(`\n${reason}\n`);
      } else {
        logger.error(`No output was captured. Check logs at: ${LOG_FILE}`);
      }
      process.exit(1);
    }

    if (outcome === 'timeout') {
      logToFile(`Tower server failed to respond within ${STARTUP_TIMEOUT_MS}ms`);
      logger.error(`Tower server did not respond within ${STARTUP_TIMEOUT_MS / 1000}s and is still running (status unknown).`);
      logger.error(`Check logs at: ${LOG_FILE}`);
      process.exit(1);
    }

    logToFile(`Tower server started successfully at ${dashboardUrl}`);
    logger.blank();
    logger.success('Tower started!');
    logger.kv('Dashboard', dashboardUrl);
  } else {
    // Daemonize: return immediately without waiting
    logger.blank();
    logger.success('Tower starting in background...');
    logger.kv('Dashboard', dashboardUrl);
    logger.kv('Logs', `afx tower log`);
  }
}

/**
 * Stop the tower dashboard
 */
export async function towerStop(options: TowerStopOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_TOWER_PORT;
  const forceKill = options.forceKillAllChildProcesses || false;

  logger.header(forceKill ? 'Force-Killing Tower and All Child Processes' : 'Stopping Tower');

  const pids = getProcessesOnPort(port);

  if (pids.length === 0) {
    logger.info('Tower is not running');
    return;
  }

  if (forceKill) {
    // Shellper processes are spawned DETACHED from Tower — they intentionally
    // survive Tower restarts. So pgrep -P won't find them. We need to:
    // 1. Find all shellper-main processes via pgrep -f
    // 2. Find all their children (claude, bash, etc.)
    // 3. Kill the Tower daemon itself
    const { execSync } = await import('node:child_process');
    const allPids = new Set<number>();

    // Recursive function to collect entire subtree via pgrep -P
    function collectDescendants(pid: number): void {
      if (allPids.has(pid)) return;
      allPids.add(pid);
      try {
        const output = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8' }).trim();
        for (const line of output.split('\n')) {
          const childPid = parseInt(line, 10);
          if (!isNaN(childPid)) collectDescendants(childPid);
        }
      } catch { /* no children */ }
    }

    // Collect Tower daemon PIDs
    for (const pid of pids) {
      collectDescendants(pid);
    }

    // Collect ALL shellper processes and their descendants (claude, bash, etc.)
    try {
      const shellperOutput = execSync('pgrep -f shellper-main', { encoding: 'utf-8' }).trim();
      for (const line of shellperOutput.split('\n')) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid)) collectDescendants(pid);
      }
    } catch { /* no shellper processes */ }

    // Kill leaves first (reverse order: deepest descendants → root)
    const orderedPids = [...allPids].reverse();
    let killed = 0;
    for (const pid of orderedPids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch { /* already dead */ }
    }

    logger.success(`Force-killed ${killed} process(es) (tower + ${orderedPids.length - pids.length} shellper/children)`);
    return;
  }

  let stopped = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped++;
    } catch {
      // Process may have already exited
    }
  }

  // #1198: wait for the processes to actually exit before returning.
  // Returning right after SIGTERM let `afx tower stop && afx tower start`
  // overlap the old Tower's shellper teardown with the new Tower's adoption
  // pass — an unnecessary race window during every restart.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + STOP_EXIT_TIMEOUT_MS;
  let survivors = pids.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_CHECK_INTERVAL_MS));
    survivors = survivors.filter(isAlive);
  }

  if (survivors.length > 0) {
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Exited between the check and the kill
      }
    }
    logger.warn(`Tower did not exit within ${STOP_EXIT_TIMEOUT_MS / 1000}s; sent SIGKILL to PID${survivors.length > 1 ? 's' : ''} ${survivors.join(', ')}`);
  }

  if (stopped > 0) {
    logger.success(`Tower stopped (${stopped} process${stopped > 1 ? 'es' : ''}: PIDs ${pids.join(', ')})`);
  }
}

export interface TowerLogOptions {
  follow?: boolean; // Tail the log file
  lines?: number; // Number of lines to show
}

/**
 * View or tail the tower log file
 */
export async function towerLog(options: TowerLogOptions = {}): Promise<void> {
  const { existsSync, readFileSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');

  if (!existsSync(LOG_FILE)) {
    logger.info('No tower logs found. Start the tower with: afx tower start');
    return;
  }

  if (options.follow) {
    // Tail -f the log file
    logger.info(`Following ${LOG_FILE} (Ctrl+C to stop)`);
    const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
    tail.on('error', (err) => {
      logger.error(`Failed to tail log: ${err.message}`);
    });
    // Keep process running
    await new Promise(() => {});
  } else {
    // Show last N lines (default 50)
    const lines = options.lines || 50;
    const content = readFileSync(LOG_FILE, 'utf-8');
    const allLines = content.trim().split('\n');
    const lastLines = allLines.slice(-lines);
    console.log(lastLines.join('\n'));
  }
}

// Legacy export for backward compatibility
export const tower = towerStart;
