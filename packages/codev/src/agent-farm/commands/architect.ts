/**
 * Architect command - direct CLI access to architect role
 *
 * Opens the Tower dashboard for the current workspace.
 * The dashboard provides full terminal access to the architect session.
 */

import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { TowerClient, encodeWorkspacePath } from '../lib/tower-client.js';

export interface ArchitectOptions {
  args?: string[];
  layout?: boolean;
}

/**
 * Start or open the architect session via Tower dashboard
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const config = getConfig();
  const client = new TowerClient();

  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    fatal('Tower is not running. Start it with: af tower start');
  }

  // Open the workspace dashboard in browser
  const url = client.getWorkspaceUrl(config.workspaceRoot);

  if (options.layout) {
    logger.info('Layout mode is handled by the Tower dashboard.');
  }

  logger.info(`Opening Tower dashboard at ${url}...`);
  await openBrowser(url);
  logger.success('Opened Tower dashboard in browser');
}
