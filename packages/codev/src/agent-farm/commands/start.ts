/**
 * Start command - activates a workspace via Tower
 *
 * Phase 3 (Spec 0090): Uses tower API for workspace activation.
 * Tower is the single daemon that manages all workspaces.
 */

import type { StartOptions } from '../types.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { towerStart } from './tower.js';

/**
 * Start via tower API (Phase 3 - Spec 0090)
 *
 * This is the way to start workspaces:
 * 1. Ensure tower is running
 * 2. Call tower's activate API
 * 3. Open browser to tower URL
 */
export async function start(options: StartOptions = {}): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;

  logger.header('Starting Agent Farm');
  logger.kv('Workspace', workspacePath);

  // Create tower client
  const client = getTowerClient();

  // Check if tower is running
  const towerRunning = await client.isRunning();

  if (!towerRunning) {
    logger.info('Starting tower daemon...');
    await towerStart({ port: DEFAULT_TOWER_PORT, wait: true });

    // Give tower a moment to fully initialize
    await new Promise((r) => setTimeout(r, 500));
  }

  // Activate workspace via tower API
  logger.info('Activating workspace...');
  const result = await client.activateWorkspace(workspacePath);

  if (!result.ok) {
    fatal(`Failed to activate workspace: ${result.error}`);
  }

  if (result.adopted) {
    logger.info('Workspace auto-adopted (codev/ directory created)');
  }

  // Get workspace URL from tower
  const workspaceUrl = client.getWorkspaceUrl(workspacePath);

  logger.blank();
  logger.success('Agent Farm started!');
  logger.kv('Overview', workspaceUrl);

  // Open browser only if Tower wasn't already running (user already has it open)
  if (!options.noBrowser && !towerRunning) {
    await openBrowser(workspaceUrl);
  } else if (towerRunning) {
    logger.info('Tower already running — workspace visible in your browser.');
  }
}
