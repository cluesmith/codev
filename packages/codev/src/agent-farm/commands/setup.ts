/**
 * `afx setup <builder-id>` — run the configured `worktree.postSpawn`
 * commands against an existing builder's worktree.
 *
 * Use cases: lockfile changed and dependencies need reinstalling; a new
 * step was added to `worktree.postSpawn` after the builder was spawned;
 * the original spawn aborted mid-setup and the worktree needs recovery;
 * running setup for the first time on a builder that predates the config.
 *
 * No confirmation prompt — the user invoked this explicitly. If you want
 * a dry-run, read `.codev/config.json` directly.
 */

import { logger } from '../utils/logger.js';
import { getConfig, getWorktreeConfig } from '../utils/index.js';
import { findBuilderById } from '../lib/builder-lookup.js';
import { runPostSpawnHooks } from './spawn-worktree.js';

export interface SetupOptions {
  builderId?: string;
}

export async function setup(options: SetupOptions): Promise<void> {
  if (!options.builderId) {
    throw new Error('Usage: afx setup <builder-id>');
  }

  const builder = findBuilderById(options.builderId);
  if (!builder) {
    throw new Error(`No builder found matching "${options.builderId}". Try \`afx status\`.`);
  }
  if (!builder.worktree) {
    throw new Error(`Builder ${builder.id} has no worktree path on record — cannot re-run setup.`);
  }

  const config = getConfig();
  const { postSpawn } = getWorktreeConfig(config.workspaceRoot);
  if (postSpawn.length === 0) {
    logger.info('No worktree.postSpawn configured in .codev/config.json. Nothing to do.');
    return;
  }

  logger.info(`Running ${postSpawn.length} post-spawn hook(s) in ${builder.worktree}...`);
  await runPostSpawnHooks(builder.worktree, postSpawn);
  logger.success(`Setup complete for ${builder.id}`);
}
