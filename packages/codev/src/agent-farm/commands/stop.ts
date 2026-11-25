/**
 * Stop command - stops all agent farm processes
 *
 * Phase 3 (Spec 0090): Uses tower API for workspace deactivation.
 * Does NOT stop the tower - other workspaces may be using it.
 */

import { loadState, clearRuntime, getArchitects } from '../state.js';
import { logger, fatal } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { getTowerClient } from '../lib/tower-client.js';
import { checkTower } from '../lib/tower-check.js';

/**
 * Stop all agent farm processes
 *
 * Phase 3 (Spec 0090): Uses tower API to deactivate workspace.
 * Does NOT stop the tower daemon - other workspaces may be using it.
 */
export async function stop(): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;

  logger.header('Stopping Agent Farm');

  // Try tower API first (Phase 3 - Spec 0090)
  const client = getTowerClient();
  // An unresponsive Tower is not a stopped one: the legacy path below would clear the
  // runtime state of builders that are still running (#1901).
  const tower = await checkTower(client);
  if (tower.state === 'unresponsive') {
    fatal(tower.message);
  }
  const towerRunning = tower.state === 'running';

  if (towerRunning) {
    logger.info('Deactivating workspace via tower...');
    const result = await client.deactivateWorkspace(workspacePath);

    if (result.ok) {
      const stoppedCount = result.stopped?.length || 0;
      if (stoppedCount > 0) {
        logger.success(`Stopped ${stoppedCount} process(es) via tower`);
      } else {
        logger.info('Workspace was not running');
      }

      // Spec 786 Phase 3: clear runtime state (builders/utils/annotations) but
      // PRESERVE the architect registry so sibling architects survive
      // `afx workspace stop` + `start`. The full-wipe `clearState()` would
      // have undone Tower's intentional-stop preservation. Use `clearRuntime`
      // for graceful stop; `clearState` remains for uninstall / nuke flows.
      clearRuntime(workspacePath);
      return;
    }

    // Tower took the request and never answered: it may or may not have deactivated, so nothing
    // local is cleared on a guess (#1901).
    if (result.status === 0 && !result.connectionRefused) {
      fatal(`Tower did not answer the deactivation request (${result.error}); nothing was cleared. Retry afx workspace stop.`);
    }

    // If tower returned error (e.g., workspace not found), fall through to legacy cleanup
    logger.debug(`Tower deactivation failed: ${result.error}, trying legacy cleanup`);
  }

  // Legacy cleanup for processes not managed by tower.
  // Bugfix #826: scoped by workspace_path.
  const state = loadState(workspacePath);

  let stopped = 0;

  // Stop all architect terminals (Spec 755: iterate all named architects, not
  // just 'main'. Pre-spec workspaces had one architect; multi-architect
  // workspaces must clean up every one, otherwise siblings would leak as
  // orphaned processes after the legacy fallback path runs).
  if (towerRunning) {
    // Bugfix #826: scoped by workspace_path.
    for (const architect of getArchitects(workspacePath)) {
      if (!architect.terminalId) continue;
      logger.info(`Stopping architect '${architect.name}'...`);
      try {
        await client.killTerminal(architect.terminalId);
        stopped++;
      } catch { /* best-effort */ }
    }
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

  // Spec 786 Phase 3: clear runtime state but preserve architects (see top).
  clearRuntime(workspacePath);

  logger.blank();
  if (stopped > 0) {
    logger.success(`Stopped ${stopped} process(es)`);
  } else {
    logger.info('No processes were running');
  }
}
