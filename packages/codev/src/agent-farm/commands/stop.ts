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
import { killProcess, killProcessTree, isProcessRunning } from '../utils/shell.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';

const execFileAsync = promisify(execFile);

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/** Kill a tmux session by name. Uses execFile (no shell) to avoid injection.
 *  If expectedPid is provided, verifies the session's PID matches before killing
 *  to prevent cross-project kills when two projects share the same basename.
 */
async function killTmuxSession(sessionName: string, expectedPid?: number): Promise<void> {
  if (expectedPid && expectedPid > 0) {
    // Verify the session belongs to this project by checking its PID
    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-sessions', '-F', '#{session_name} #{session_pid}',
      ]);
      const line = stdout.trim().split('\n').find(l => l.startsWith(sessionName + ' '));
      if (line) {
        const sessionPid = parseInt(line.split(' ')[1], 10);
        if (sessionPid !== expectedPid && !isNaN(sessionPid)) {
          // PID mismatch — this session belongs to a different project
          throw new Error(`Session ${sessionName} PID ${sessionPid} != expected ${expectedPid}`);
        }
      }
    } catch (err) {
      if ((err as Error).message?.includes('PID')) throw err;
      // tmux command failed — fall through to kill attempt
    }
  }
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

  // Stop architect — kill tmux session by name (safer than tree-kill)
  if (state.architect) {
    logger.info(`Stopping architect (PID: ${state.architect.pid})`);
    try {
      // Kill tmux session by name — this cleanly terminates the session and its processes
      if (state.architect.tmuxSession) {
        try {
          await killTmuxSession(state.architect.tmuxSession, state.architect.pid);
          stopped++;
        } catch {
          // Session may already be gone, try PID fallback
          if (await isProcessRunning(state.architect.pid)) {
            await killProcess(state.architect.pid);
            stopped++;
          }
        }
      } else if (await isProcessRunning(state.architect.pid)) {
        await killProcess(state.architect.pid);
        stopped++;
      }
    } catch (error) {
      logger.warn(`Failed to stop architect: ${error}`);
    }
  }

  // Stop all builders — prefer tmux kill-session over PID kill
  for (const builder of state.builders) {
    logger.info(`Stopping builder ${builder.id} (PID: ${builder.pid})`);
    try {
      if (builder.tmuxSession) {
        try {
          await killTmuxSession(builder.tmuxSession, builder.pid);
          stopped++;
        } catch {
          if (await isProcessRunning(builder.pid)) {
            await killProcess(builder.pid);
            stopped++;
          }
        }
      } else if (await isProcessRunning(builder.pid)) {
        await killProcess(builder.pid);
        stopped++;
      }
    } catch (error) {
      logger.warn(`Failed to stop builder ${builder.id}: ${error}`);
    }
  }

  // Stop all utils — prefer tmux kill-session over PID kill
  for (const util of state.utils) {
    logger.info(`Stopping util ${util.id} (PID: ${util.pid})`);
    try {
      if (util.tmuxSession) {
        try {
          await killTmuxSession(util.tmuxSession, util.pid);
          stopped++;
        } catch {
          if (await isProcessRunning(util.pid)) {
            await killProcess(util.pid);
            stopped++;
          }
        }
      } else if (await isProcessRunning(util.pid)) {
        await killProcess(util.pid);
        stopped++;
      }
    } catch (error) {
      logger.warn(`Failed to stop util ${util.id}: ${error}`);
    }
  }

  // Stop all annotations — use tree-kill since these are standalone node servers
  for (const annotation of state.annotations) {
    logger.info(`Stopping annotation ${annotation.id} (PID: ${annotation.pid})`);
    try {
      if (await isProcessRunning(annotation.pid)) {
        await killProcessTree(annotation.pid);
        stopped++;
      }
    } catch (error) {
      logger.warn(`Failed to stop annotation ${annotation.id}: ${error}`);
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
