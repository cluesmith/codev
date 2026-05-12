/**
 * `afx setup <builder-id>` — apply worktree setup (symlinks + postSpawn)
 * to an existing builder's worktree, without recreating it.
 *
 * Mirrors what `createWorktree` does at spawn time minus the git steps:
 *   1. `symlinkConfigFiles` — root `.env`, `.codev/config.json`, and any
 *      `worktree.symlinks` glob matches. Idempotent: skips targets that
 *      already exist; adds missing.
 *   2. `runPostSpawnHooks` — each `worktree.postSpawn` command runs in
 *      its own bash subshell with cwd = worktree root. Output streams live.
 *
 * Use cases:
 *   - lockfile changed; dependencies need reinstalling
 *   - new entry added to `worktree.symlinks` or `worktree.postSpawn` after
 *     the builder was spawned
 *   - main added a new file matching an existing symlinks glob
 *   - a symlink was accidentally deleted inside the worktree
 *   - the original spawn aborted mid-setup; recovery
 *   - running setup for the first time on a builder that predates the config
 *
 * No confirmation prompt — the user invoked this explicitly.
 */

import { logger } from '../utils/logger.js';
import { getConfig, getWorktreeConfig } from '../utils/index.js';
import { findBuilderById } from '../lib/builder-lookup.js';
import { runPostSpawnHooks, symlinkConfigFiles } from './spawn-worktree.js';

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
    throw new Error(`Builder ${builder.id} has no worktree path on record — cannot apply setup.`);
  }

  const config = getConfig();
  const { symlinks, postSpawn } = getWorktreeConfig(config.workspaceRoot);

  logger.info(`Applying symlinks for ${builder.id}...`);
  symlinkConfigFiles(config, builder.worktree);

  if (postSpawn.length === 0) {
    if (symlinks.length === 0) {
      logger.info('No worktree.symlinks or worktree.postSpawn configured. Nothing further to do.');
    } else {
      logger.success(`Setup complete for ${builder.id} (symlinks only — no postSpawn configured)`);
    }
    return;
  }

  logger.info(`Running ${postSpawn.length} post-spawn hook(s) in ${builder.worktree}...`);
  await runPostSpawnHooks(builder.worktree, postSpawn);
  logger.success(`Setup complete for ${builder.id}`);
}
