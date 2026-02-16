/**
 * Attach command - attach to a running builder terminal
 *
 * Default mode: connect directly to shellper Unix socket as a terminal client.
 * --browser mode: open Tower dashboard in browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Builder } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { loadState, getBuilder, getBuilders } from '../state.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';
import { ShellperClient } from '../../terminal/shellper-client.js';
import type { DbTerminalSession } from '../servers/tower-types.js';
import { normalizeWorkspacePath } from '../servers/tower-utils.js';
import { getGlobalDb } from '../db/index.js';
import chalk from 'chalk';

export interface AttachOptions {
  project?: string;     // Builder ID / project ID
  issue?: number;       // Issue number (for bugfix builders)
  browser?: boolean;    // Open in browser instead of attaching
}

/**
 * Find a builder by issue number
 */
function findBuilderByIssue(issueNumber: number): Builder | null {
  const builders = getBuilders();
  return builders.find((b) => b.issueNumber === issueNumber) ?? null;
}

/**
 * Find a builder by ID (supports partial matching)
 */
function findBuilderById(id: string): Builder | null {
  // First try exact match
  const exact = getBuilder(id);
  if (exact) return exact;

  // Try prefix match (e.g., "0073" matches "0073-feature-name")
  const builders = getBuilders();
  const matches = builders.filter((b) => b.id.startsWith(id) || b.id.includes(id));

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    logger.error(`Ambiguous builder ID "${id}". Matches:`);
    for (const b of matches) {
      logger.info(`  - ${b.id}`);
    }
    return null;
  }

  return null;
}

/**
 * Display a list of running builders for interactive selection
 */
async function displayBuilderList(): Promise<void> {
  const state = loadState();
  const builders = state.builders;

  if (builders.length === 0) {
    logger.info('No builders running.');
    logger.blank();
    logger.info('Spawn a builder with:');
    logger.info('  af spawn -p <project-id>');
    logger.info('  af spawn --issue <number>');
    logger.info('  af spawn --task "description"');
    return;
  }

  logger.header('Running Builders');
  logger.blank();

  const widths = [15, 30, 8, 10];
  logger.row(['ID', 'Name', 'Type', 'Status'], widths);
  logger.row(['──', '────', '────', '──────'], widths);

  for (const builder of builders) {
    const running = !!builder.terminalId;
    const statusText = running ? chalk.green(builder.status) : chalk.red('stopped');
    const typeColor = getTypeColor(builder.type);

    logger.row([
      builder.id,
      builder.name.substring(0, 28),
      typeColor(builder.type),
      statusText,
    ], widths);
  }

  logger.blank();
  logger.info('Attach with:');
  logger.info('  af attach -p <id>         # terminal mode (direct)');
  logger.info('  af attach --issue <num>   # by issue number');
  logger.info('  af attach -p <id> --browser  # open in browser');
}

/**
 * Get color function for builder type
 */
function getTypeColor(type: string): (text: string) => string {
  switch (type) {
    case 'spec':
      return chalk.cyan;
    case 'bugfix':
      return chalk.red;
    case 'task':
      return chalk.magenta;
    case 'protocol':
      return chalk.yellow;
    case 'worktree':
      return chalk.blue;
    case 'shell':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Find the shellper socket path for a builder.
 *
 * Discovery order:
 * 1. SQLite terminal_sessions table (workspace-scoped)
 * 2. Fallback: scan ~/.codev/run/shellper-*.sock
 */
export function findShellperSocket(builder: Builder): string | null {
  // 1. Try SQLite lookup
  try {
    const db = getGlobalDb();
    const workspacePath = normalizeWorkspacePath(builder.worktree);

    const session = db.prepare(`
      SELECT shellper_socket FROM terminal_sessions
      WHERE workspace_path = ? AND role_id = ? AND shellper_socket IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(workspacePath, builder.id) as Pick<DbTerminalSession, 'shellper_socket'> | undefined;

    if (session?.shellper_socket && fs.existsSync(session.shellper_socket)) {
      return session.shellper_socket;
    }
  } catch {
    // SQLite unavailable — fall through to scan
  }

  // 2. Fallback: scan ~/.codev/run/ for matching sockets
  const runDir = path.join(homedir(), '.codev', 'run');
  try {
    if (!fs.existsSync(runDir)) return null;
    const files = fs.readdirSync(runDir);
    for (const file of files) {
      if (file.startsWith('shellper-') && file.endsWith('.sock')) {
        const sockPath = path.join(runDir, file);
        // Check if socket file exists and is accessible
        try {
          fs.accessSync(sockPath, fs.constants.R_OK | fs.constants.W_OK);
          return sockPath;
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Directory not readable
  }

  return null;
}

const DETACH_KEY = 0x1c; // Ctrl-\

/**
 * Attach to a shellper process in terminal mode.
 *
 * Connects as a 'terminal' client, enters raw mode, pipes stdin/stdout,
 * handles SIGWINCH for resize, and detaches on Ctrl-\.
 */
export async function attachTerminal(socketPath: string): Promise<void> {
  const client = new ShellperClient(socketPath, 'terminal');

  // Track terminal state for cleanup
  let rawModeEnabled = false;

  function restoreTerminal(): void {
    if (rawModeEnabled && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      rawModeEnabled = false;
    }
    process.stdin.pause();
  }

  function cleanup(): void {
    restoreTerminal();
    client.disconnect();
    process.stdout.write('\n');
  }

  // Ensure terminal is restored on process exit
  process.on('exit', restoreTerminal);

  try {
    const welcome = await client.connect();
    logger.info(`Attached to shellper (PID ${welcome.pid}, ${welcome.cols}x${welcome.rows})`);
    logger.info('Detach with Ctrl-\\');
    logger.blank();

    // Write replay buffer to stdout
    const replay = await client.waitForReplay(500);
    if (replay.length > 0) {
      process.stdout.write(replay);
    }

    // Enter raw mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      rawModeEnabled = true;
    }
    process.stdin.resume();

    // Pipe PTY output to stdout
    client.on('data', (buf: Buffer) => {
      process.stdout.write(buf);
    });

    // Handle PTY exit
    client.on('exit', () => {
      cleanup();
      process.removeListener('exit', restoreTerminal);
      logger.info('Session ended.');
      process.exit(0);
    });

    // Handle connection close
    client.on('close', () => {
      cleanup();
      process.removeListener('exit', restoreTerminal);
      logger.info('Connection closed.');
      process.exit(0);
    });

    // Handle connection error
    client.on('error', (err: Error) => {
      cleanup();
      process.removeListener('exit', restoreTerminal);
      logger.error(`Connection error: ${err.message}`);
      process.exit(1);
    });

    // Pipe stdin to shellper as DATA frames
    process.stdin.on('data', (chunk: Buffer) => {
      // Check for detach key (Ctrl-\)
      if (chunk.length === 1 && chunk[0] === DETACH_KEY) {
        cleanup();
        process.removeListener('exit', restoreTerminal);
        logger.info('Detached.');
        process.exit(0);
        return;
      }
      client.write(chunk);
    });

    // Send RESIZE on terminal size change
    const onResize = () => {
      if (process.stdout.columns && process.stdout.rows) {
        client.resize(process.stdout.columns, process.stdout.rows);
      }
    };
    process.stdout.on('resize', onResize);

    // Send initial resize to match local terminal
    onResize();

    // Keep the process alive — stdin in raw mode keeps the event loop running
    await new Promise<void>(() => {
      // Never resolves — process exits via cleanup paths above
    });
  } catch (err) {
    cleanup();
    process.removeListener('exit', restoreTerminal);
    throw err;
  }
}

/**
 * Attach to builder terminal
 */
export async function attach(options: AttachOptions): Promise<void> {
  // If no arguments provided, show list of builders
  if (!options.project && !options.issue) {
    await displayBuilderList();
    return;
  }

  // Find the builder
  let builder: Builder | null = null;

  if (options.issue) {
    builder = findBuilderByIssue(options.issue);
    if (!builder) {
      fatal(`No builder found for issue #${options.issue}. Use 'af status' to see running builders.`);
    }
  } else if (options.project) {
    builder = findBuilderById(options.project);
    if (!builder) {
      fatal(`Builder "${options.project}" not found. Use 'af status' to see running builders.`);
    }
  }

  if (!builder) {
    fatal('No builder specified. Use --project (-p) or --issue (-i).');
    return; // TypeScript doesn't know fatal() never returns
  }

  // --browser: open Tower dashboard
  if (options.browser) {
    const config = getConfig();
    const towerClient = new TowerClient();
    const url = towerClient.getWorkspaceUrl(config.workspaceRoot);
    logger.info(`Opening Tower dashboard at ${url}...`);
    await openBrowser(url);
    logger.success('Opened Tower dashboard in browser');
    return;
  }

  // Default: terminal attach mode
  const socketPath = findShellperSocket(builder);
  if (!socketPath) {
    fatal(`No shellper socket found for builder ${builder.id}. Is the builder running?`);
    return;
  }

  try {
    await attachTerminal(socketPath);
  } catch (err) {
    fatal(`Failed to attach to builder ${builder.id}: ${(err as Error).message}`);
  }
}
