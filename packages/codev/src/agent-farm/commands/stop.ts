/**
 * Stop command - stops all agent farm processes
 *
 * Phase 3 (Spec 0090): Uses tower API for project deactivation.
 * Does NOT stop the tower - other projects may be using it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadState, clearState } from '../state.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';

const execFileAsync = promisify(execFile);

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/** Kill a tmux session by name. Uses execFile (no shell) to avoid injection. */
async function killTmuxSession(sessionName: string): Promise<void> {
  await execFileAsync('tmux', ['kill-session', '-t', sessionName]);
}

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

  // Stop architect — kill tmux session by name, then Tower terminal
  if (state.architect?.tmuxSession) {
    logger.info('Stopping architect...');
    try {
      await killTmuxSession(state.architect.tmuxSession);
      stopped++;
    } catch {
      // Session may already be gone
    }
  }
  if (towerRunning && state.architect?.terminalId) {
    try {
      await client.killTerminal(state.architect.terminalId);
    } catch { /* best-effort */ }
  }

  // Stop all builders — kill tmux sessions, then Tower terminals
  for (const builder of state.builders) {
    if (builder.tmuxSession) {
      logger.info(`Stopping builder ${builder.id}...`);
      try {
        await killTmuxSession(builder.tmuxSession);
        stopped++;
      } catch {
        // Session may already be gone
      }
    }
    if (towerRunning && builder.terminalId) {
      try {
        await client.killTerminal(builder.terminalId);
        if (!builder.tmuxSession) stopped++;
      } catch { /* best-effort */ }
    }
  }

  // Stop all utils — kill tmux sessions, then Tower terminals
  for (const util of state.utils) {
    if (util.tmuxSession) {
      logger.info(`Stopping util ${util.id}...`);
      try {
        await killTmuxSession(util.tmuxSession);
        stopped++;
      } catch {
        // Session may already be gone
      }
    }
    if (towerRunning && util.terminalId) {
      try {
        await client.killTerminal(util.terminalId);
        if (!util.tmuxSession) stopped++;
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
