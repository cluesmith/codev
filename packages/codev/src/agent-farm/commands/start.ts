/**
 * Start command - activates a project via Tower
 *
 * Phase 3 (Spec 0090): Uses tower API for project activation.
 * Tower is the single daemon that manages all projects.
 */

import type { StartOptions } from '../types.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { TowerClient } from '../lib/tower-client.js';
import { towerStart } from './tower.js';

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/**
 * Start via tower API (Phase 3 - Spec 0090)
 *
 * This is the way to start projects:
 * 1. Ensure tower is running
 * 2. Call tower's activate API
 * 3. Open browser to tower URL
 */
export async function start(options: StartOptions = {}): Promise<void> {
  const config = getConfig();
  const projectPath = config.projectRoot;

  logger.header('Starting Agent Farm');
  logger.kv('Project', projectPath);

  // Create tower client
  const client = new TowerClient(DEFAULT_TOWER_PORT);

  // Check if tower is running
  const towerRunning = await client.isRunning();

  if (!towerRunning) {
    logger.info('Starting tower daemon...');
    await towerStart({ port: DEFAULT_TOWER_PORT, wait: true });

    // Give tower a moment to fully initialize
    await new Promise((r) => setTimeout(r, 500));
  }

  // Activate project via tower API
  logger.info('Activating project...');
  const result = await client.activateProject(projectPath);

  if (!result.ok) {
    fatal(`Failed to activate project: ${result.error}`);
  }

  if (result.adopted) {
    logger.info('Project auto-adopted (codev/ directory created)');
  }

  // Get project URL from tower
  const projectUrl = client.getProjectUrl(projectPath);

  logger.blank();
  logger.success('Agent Farm started!');
  logger.kv('Dashboard', projectUrl);

  // Open browser only if Tower wasn't already running (user already has it open)
  if (!options.noBrowser && !towerRunning) {
    await openBrowser(projectUrl);
  } else if (towerRunning) {
    logger.info('Tower already running — project visible in your browser.');
  }
}
