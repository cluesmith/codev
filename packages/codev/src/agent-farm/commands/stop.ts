/**
 * Stop command - stops all agent farm processes
 *
 * Phase 3 (Spec 0090): Uses tower API for project deactivation.
 * Does NOT stop the tower - other projects may be using it.
 */

import { loadState, clearState } from '../state.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/**
 * Stop all agent farm processes
 *
 * Phase 3 (Spec 0090): Uses tower API to deactivate project.
 * Does NOT stop the tower daemon - other projects may be using it.
 */
export async function stop(): Promise<void> {
  const config = getConfig();
  const projectPath = config.projectRoot;

  logger.header('Stopping Agent Farm');

  // Try tower API first (Phase 3 - Spec 0090)
  const client = new TowerClient(DEFAULT_TOWER_PORT);
  const towerRunning = await client.isRunning();

  if (towerRunning) {
    logger.info('Deactivating project via tower...');
    const result = await client.deactivateProject(projectPath);

    if (result.ok) {
      const stoppedCount = result.stopped?.length || 0;
      if (stoppedCount > 0) {
        logger.success(`Stopped ${stoppedCount} process(es) via tower`);
      } else {
        logger.info('Project was not running');
      }

      // Clear local state as well
      clearState();
      return;
    }

    // If tower returned error (e.g., project not found), fall through to legacy cleanup
    logger.debug(`Tower deactivation failed: ${result.error}, trying legacy cleanup`);
  }

  // Legacy cleanup for processes not managed by tower
  const state = loadState();

  let stopped = 0;

  // Stop architect terminal
  if (towerRunning && state.architect?.terminalId) {
    logger.info('Stopping architect...');
    try {
      await client.killTerminal(state.architect.terminalId);
      stopped++;
    } catch { /* best-effort */ }
  }

  // Stop all builders
  for (const builder of state.builders) {
    if (towerRunning && builder.terminalId) {
      logger.info(`Stopping builder ${builder.id}...`);
      try {
        await client.killTerminal(builder.terminalId);
        stopped++;
      } catch { /* best-effort */ }
    }
  }

  // Stop all utils
  for (const util of state.utils) {
    if (towerRunning && util.terminalId) {
      logger.info(`Stopping util ${util.id}...`);
      try {
        await client.killTerminal(util.terminalId);
        stopped++;
      } catch { /* best-effort */ }
    }
  }

  // Clear state
  clearState();

  logger.blank();
  if (stopped > 0) {
    logger.success(`Stopped ${stopped} process(es)`);
  } else {
    logger.info('No processes were running');
  }
}
