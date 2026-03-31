/**
 * Tower command - launches the tower dashboard showing all instances
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import { logger, fatal } from '../utils/logger.js';
import { spawn } from 'node:child_process';
import { getConfig } from '../utils/config.js';
import { execSync } from 'node:child_process';
import { DEFAULT_TOWER_PORT, AGENT_FARM_DIR } from '../lib/tower-client.js';
import { isPortAvailable } from '../utils/shell.js';

// Log file location
const LOG_FILE = resolve(AGENT_FARM_DIR, 'tower.log');

// Startup verification settings
const STARTUP_TIMEOUT_MS = 5000;
const STARTUP_CHECK_INTERVAL_MS = 200;

export interface TowerStartOptions {
  port?: number;
  wait?: boolean; // Wait for server to start before returning
}

export interface TowerStopOptions {
  port?: number;
  forceKillAllChildProcesses?: boolean;
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
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        method: 'GET',
        timeout: 2000,
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
 * Wait for the server to start responding
 */
async function waitForServer(port: number): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
    if (await isServerResponding(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, STARTUP_CHECK_INTERVAL_MS));
  }

  return false;
}

/**
 * Get all PIDs of processes listening on a port
 */
function getProcessesOnPort(port: number): number[] {
  try {
    const result = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' });
    return result
      .trim()
      .split('\n')
      .map((line) => parseInt(line, 10))
      .filter((pid) => !isNaN(pid));
  } catch {
    return [];
  }
}

/**
 * Start the tower dashboard
 */
export async function towerStart(options: TowerStartOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_TOWER_PORT;

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

  // Start tower server fully detached - stdio: 'ignore' ensures parent can exit
  const serverProcess = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
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

  const dashboardUrl = `http://localhost:${port}`;

  if (options.wait) {
    // Wait for server to actually start responding
    logger.info('Waiting for server to start...');
    const started = await waitForServer(port);

    if (!started) {
      logToFile(`Tower server failed to respond within ${STARTUP_TIMEOUT_MS}ms`);
      logger.error(`Tower server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s`);
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
