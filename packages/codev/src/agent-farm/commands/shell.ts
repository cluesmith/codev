/**
 * Shell command - spawns a utility shell terminal
 *
 * When the dashboard is running, this creates a tab in the dashboard.
 * When the dashboard is not running, it spawns the terminal directly via node-pty.
 */

import type { UtilTerminal } from '../types.js';
import { getConfig, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { loadState, addUtil } from '../state.js';

interface UtilOptions {
  name?: string;
}

/**
 * Try to create a shell tab via the dashboard API
 * Returns true if successful, false if dashboard not available
 */
async function tryDashboardApi(name?: string): Promise<boolean> {
  const state = loadState();

  // Dashboard port from config
  if (!state.architect) {
    return false;
  }

  const config = getConfig();
  const dashboardPort = config.dashboardPort;

  try {
    const response = await fetch(`http://localhost:${dashboardPort}/api/tabs/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (response.ok) {
      const result = await response.json() as { name: string; port: number };
      logger.success(`Shell opened in dashboard tab`);
      logger.kv('Name', result.name);
      return true;
    }

    // Dashboard returned an error, fall through to direct spawn
    return false;
  } catch {
    // Dashboard not available
    return false;
  }
}

/**
 * Spawn a utility shell terminal
 */
export async function shell(options: UtilOptions = {}): Promise<void> {
  const config = getConfig();

  // Try to use dashboard API first (if dashboard is running)
  const dashboardOpened = await tryDashboardApi(options.name);
  if (dashboardOpened) {
    return;
  }

  // Direct spawn via node-pty REST API
  const id = generateUtilId();
  const name = options.name || `util-${id}`;

  // Get shell command from config (hierarchy: CLI > config.json > default)
  const commands = getResolvedCommands();
  const shellCmd = commands.shell;

  logger.header(`Spawning Utility Terminal`);
  logger.kv('ID', id);
  logger.kv('Name', name);

  // Create PTY session via REST API (node-pty backend)
  logger.info('Creating PTY terminal session...');
  const dashboardPort = config.dashboardPort;
  const response = await fetch(`http://localhost:${dashboardPort}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: shellCmd, args: [], cwd: config.projectRoot, cols: 200, rows: 50 }),
  });

  if (!response.ok) {
    fatal(`Failed to create PTY session: ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { id: string };
  const utilTerminal: UtilTerminal = {
    id,
    name,
    port: 0,
    pid: 0,
  };
  addUtil(utilTerminal);

  logger.blank();
  logger.success(`Utility terminal spawned!`);
  logger.kv('Terminal ID', result.id);

  // Open dashboard (terminal is accessible via WebSocket)
  await openBrowser(`http://localhost:${config.dashboardPort}`);
}

/**
 * Generate a unique utility ID
 */
function generateUtilId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 4);
  return `U${timestamp.slice(-3)}${random}`.toUpperCase();
}
