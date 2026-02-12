/**
 * Orphan Handler
 *
 * Detects and handles orphaned tmux sessions from previous agent-farm runs.
 * This prevents resource leaks and ensures clean startup.
 *
 * IMPORTANT: Only cleans up architect sessions matching the af-architect naming pattern.
 * Other tmux sessions are left alone.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { run } from './shell.js';
import { loadState, setArchitect } from '../state.js';

/**
 * Check if a process is still running
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface OrphanedSession {
  name: string;
  type: 'architect' | 'builder' | 'util';
}

/**
 * Find tmux sessions that match agent-farm architect patterns.
 * Matches current naming (af-architect) and legacy port-based (af-architect-XXXX).
 * PID liveness check prevents killing active sessions.
 */
async function findOrphanedSessions(): Promise<OrphanedSession[]> {
  const state = loadState();

  // Match architect sessions — current naming (af-architect) and legacy port-based (af-architect-XXXX)
  const architectPattern = /^af-architect(-\d+)?$/;

  try {
    const result = await run('tmux list-sessions -F "#{session_name}" 2>/dev/null');
    const sessions = result.stdout.trim().split('\n').filter(Boolean);
    const orphans: OrphanedSession[] = [];

    for (const name of sessions) {
      // Check architect sessions - only orphaned if PID is dead
      if (architectPattern.test(name)) {
        // If we have state for this architect, check if PID is still alive
        if (state.architect) {
          if (!isProcessAlive(state.architect.pid)) {
            // PID is dead but session exists - this is orphaned
            orphans.push({ name, type: 'architect' });
          }
          // If PID is alive, session is NOT orphaned - skip it
        } else {
          // No state entry but session exists - orphaned
          orphans.push({ name, type: 'architect' });
        }
      }
      // Note: builder and util sessions use different naming now (af-shell-UXXXXXX)
      // Those are managed by their own state entries and don't need orphan detection
    }

    return orphans;
  } catch {
    // tmux not available or no sessions
    return [];
  }
}

/**
 * Kill an orphaned tmux session
 */
async function killSession(name: string): Promise<boolean> {
  try {
    await run(`tmux kill-session -t "${name}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for and handle orphaned sessions on startup
 *
 * Returns the number of sessions that were cleaned up.
 */
export async function handleOrphanedSessions(options: {
  kill?: boolean;
  silent?: boolean;
} = {}): Promise<number> {
  const orphans = await findOrphanedSessions();

  if (orphans.length === 0) {
    return 0;
  }

  if (!options.silent) {
    logger.warn(`Found ${orphans.length} orphaned tmux session(s) from previous run:`);
    for (const orphan of orphans) {
      logger.info(`  - ${orphan.name} (${orphan.type})`);
    }
  }

  if (options.kill) {
    let killed = 0;
    for (const orphan of orphans) {
      if (await killSession(orphan.name)) {
        killed++;
        // Clear state entry for killed architects
        if (orphan.type === 'architect') {
          setArchitect(null);
        }
        if (!options.silent) {
          logger.debug(`  Killed: ${orphan.name}`);
        }
      }
    }

    if (!options.silent) {
      logger.info(`Cleaned up ${killed} orphaned session(s)`);
    }

    return killed;
  }

  return 0;
}

/**
 * Check for stale artifacts from bash script era
 */
export function checkStaleArtifacts(codevDir: string): string[] {
  const staleFiles = [
    'builders.md',  // Old bash state file
    '.architect.pid',
    '.architect.log',
  ];

  const found: string[] = [];
  for (const file of staleFiles) {
    const path = resolve(codevDir, file);
    if (existsSync(path)) {
      found.push(file);
    }
  }

  return found;
}

/**
 * Warn about stale artifacts if found
 */
export function warnAboutStaleArtifacts(codevDir: string): void {
  const stale = checkStaleArtifacts(codevDir);

  if (stale.length > 0) {
    logger.warn('Found stale artifacts from previous bash-based architect:');
    for (const file of stale) {
      logger.info(`  - ${file}`);
    }
    logger.info('These can be safely deleted. The new TypeScript implementation uses .agent-farm/');
  }
}
