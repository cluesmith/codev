/**
 * Tower command - launches the tower dashboard showing all instances
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { logger, fatal } from '../utils/logger.js';
import { spawnDetached } from '../utils/shell.js';
import { getConfig } from '../utils/config.js';
import { execSync } from 'node:child_process';

// Log file location
const LOG_DIR = resolve(homedir(), '.agent-farm');
const LOG_FILE = resolve(LOG_DIR, 'tower.log');

// Default port for tower dashboard
const DEFAULT_TOWER_PORT = 4100;

// Startup verification settings
const STARTUP_TIMEOUT_MS = 5000;
const STARTUP_CHECK_INTERVAL_MS = 200;

export interface TowerStartOptions {
  port?: number;
  wait?: boolean; // Wait for server to start before returning
}

export interface TowerStopOptions {
  port?: number;
}

/**
 * Write to the tower log file
 */
function logToFile(message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Check if a port is already in use
 */
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
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

  // Start tower server - explicitly pass env to ensure CODEV_WEB_KEY is inherited
  const serverProcess = spawnDetached(command, args, {
    cwd: process.cwd(),
    env: process.env,
  });

  if (!serverProcess.pid) {
    logToFile('Failed to spawn tower server process');
    fatal('Failed to start tower server');
  }

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
    logger.kv('Logs', `af tower log`);
  }
}

/**
 * Stop the tower dashboard
 */
export async function towerStop(options: TowerStopOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_TOWER_PORT;

  logger.header('Stopping Tower');

  const pids = getProcessesOnPort(port);

  if (pids.length === 0) {
    logger.info('Tower is not running');
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
    logger.info('No tower logs found. Start the tower with: af tower start');
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
