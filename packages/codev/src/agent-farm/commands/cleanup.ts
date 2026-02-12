/**
 * Cleanup command - removes builder worktrees and branches
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Builder, Config } from '../types.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { loadState, removeBuilder } from '../state.js';

/**
 * Remove porch state for a project from codev/projects/
 */
async function cleanupPorchState(projectId: string, config: Config): Promise<void> {
  const projectsDir = join(config.codevDir, 'projects');

  if (!existsSync(projectsDir)) {
    return;
  }

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${projectId}-`)) {
        const porchStatePath = join(projectsDir, entry.name);
        logger.info(`Removing porch state: ${entry.name}`);
        await rm(porchStatePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    logger.warn(`Warning: Failed to cleanup porch state: ${error}`);
  }
}

/**
 * Get a namespaced tmux session name: builder-{project}-{id}
 */
function getSessionName(config: Config, builderId: string): string {
  return `builder-${basename(config.projectRoot)}-${builderId}`;
}

export interface CleanupOptions {
  project?: string;
  issue?: number;
  force?: boolean;
}

/**
 * Check if a worktree has uncommitted changes
 * Returns: dirty (has real changes), scaffoldOnly (only has .builder-* files)
 */
async function hasUncommittedChanges(worktreePath: string): Promise<{ dirty: boolean; scaffoldOnly: boolean; details: string }> {
  if (!existsSync(worktreePath)) {
    return { dirty: false, scaffoldOnly: false, details: '' };
  }

  try {
    // Check for uncommitted changes (staged and unstaged)
    const result = await run('git status --porcelain', { cwd: worktreePath });

    if (result.stdout.trim()) {
      // Count changed files, excluding builder scaffold files
      const scaffoldPattern = /^\?\? \.builder-/;
      const allLines = result.stdout.trim().split('\n').filter(Boolean);
      const nonScaffoldLines = allLines.filter((line) => !scaffoldPattern.test(line));

      if (nonScaffoldLines.length > 0) {
        return {
          dirty: true,
          scaffoldOnly: false,
          details: `${nonScaffoldLines.length} uncommitted file(s)`,
        };
      }

      // Only scaffold files present
      if (allLines.length > 0) {
        return { dirty: false, scaffoldOnly: true, details: '' };
      }
    }

    return { dirty: false, scaffoldOnly: false, details: '' };
  } catch {
    // If git status fails, assume dirty to be safe
    return { dirty: true, scaffoldOnly: false, details: 'Unable to check status' };
  }
}

/**
 * Delete a remote branch
 */
async function deleteRemoteBranch(branch: string, config: Config): Promise<void> {
  logger.info('Deleting remote branch...');
  try {
    await run(`git push origin --delete "${branch}"`, { cwd: config.projectRoot });
    logger.info('Remote branch deleted');
  } catch {
    logger.warn('Warning: Failed to delete remote branch (may not exist on remote)');
  }
}

/**
 * Cleanup a builder's worktree and branch
 */
export async function cleanup(options: CleanupOptions): Promise<void> {
  const config = getConfig();

  // Load state to find the builder
  const state = loadState();
  let builder: Builder | undefined;

  if (options.issue) {
    // Find bugfix builder by issue number
    const builderId = `bugfix-${options.issue}`;
    builder = state.builders.find((b) => b.id === builderId);

    if (!builder) {
      // Also check by issueNumber field (in case ID format differs)
      builder = state.builders.find((b) => b.issueNumber === options.issue);
    }

    if (!builder) {
      fatal(`Bugfix builder not found for issue #${options.issue}`);
    }
  } else if (options.project) {
    const projectId = options.project;
    builder = state.builders.find((b) => b.id === projectId);

    if (!builder) {
      // Try to find by name pattern
      const byName = state.builders.find((b) => b.name.includes(projectId));
      if (byName) {
        return cleanupBuilder(byName, options.force, options.issue);
      }
      fatal(`Builder not found for project: ${projectId}`);
    }
  } else {
    fatal('Must specify either --project or --issue');
  }

  await cleanupBuilder(builder, options.force, options.issue);
}

async function cleanupBuilder(builder: Builder, force?: boolean, issueNumber?: number): Promise<void> {
  const config = getConfig();
  const isShellMode = builder.type === 'shell';
  const isBugfixMode = builder.type === 'bugfix';

  logger.header(`Cleaning up ${isShellMode ? 'Shell' : isBugfixMode ? 'Bugfix Builder' : 'Builder'} ${builder.id}`);
  logger.kv('Name', builder.name);
  if (!isShellMode) {
    logger.kv('Worktree', builder.worktree);
    logger.kv('Branch', builder.branch);
  }

  // Check for uncommitted changes (informational - worktree is preserved)
  if (!isShellMode) {
    const { dirty, details } = await hasUncommittedChanges(builder.worktree);
    if (dirty) {
      logger.info(`Worktree has uncommitted changes: ${details}`);
    }
  }

  // Kill tmux session if exists (use stored session name for correct shell/builder naming)
  const sessionName = builder.tmuxSession || getSessionName(config, builder.id);
  try {
    await run(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
    logger.info('Killed tmux session');
  } catch {
    // Session may not exist
  }

  // For bugfix mode: actually remove worktree and delete remote branch
  if (isBugfixMode && !isShellMode) {
    // Remove worktree
    if (existsSync(builder.worktree)) {
      logger.info('Removing worktree...');
      try {
        await run(`git worktree remove "${builder.worktree}" --force`, { cwd: config.projectRoot });
        logger.info('Worktree removed');
      } catch {
        logger.warn('Warning: Failed to remove worktree');
      }
    }

    // Delete local branch
    if (builder.branch) {
      logger.info('Deleting local branch...');
      try {
        await run(`git branch -D "${builder.branch}"`, { cwd: config.projectRoot });
        logger.info('Local branch deleted');
      } catch {
        // Branch may not exist locally
      }
    }

    // Delete remote branch (verify PR is merged first unless --force)
    if (builder.branch) {
      if (!force) {
        // Check if there's a merged PR for this branch
        try {
          const prStatus = await run(`gh pr list --head "${builder.branch}" --state merged --json number --limit 1`, { cwd: config.projectRoot });
          const mergedPRs = JSON.parse(prStatus.stdout);
          if (mergedPRs.length === 0) {
            // Check for open PRs
            const openPRStatus = await run(`gh pr list --head "${builder.branch}" --state open --json number --limit 1`, { cwd: config.projectRoot });
            const openPRs = JSON.parse(openPRStatus.stdout);
            if (openPRs.length > 0) {
              logger.warn(`Warning: Branch ${builder.branch} has an open PR. Skipping remote deletion.`);
              logger.info('Use --force to delete anyway.');
            } else {
              logger.warn(`Warning: No merged PR found for ${builder.branch}. Skipping remote deletion.`);
              logger.info('Use --force to delete anyway.');
            }
          } else {
            // PR is merged, safe to delete remote
            await deleteRemoteBranch(builder.branch, config);
          }
        } catch {
          logger.warn('Warning: Could not verify PR status. Skipping remote deletion.');
        }
      } else {
        // --force: delete remote branch without checking PR status
        await deleteRemoteBranch(builder.branch, config);
      }
    }
  } else if (!isShellMode) {
    // Non-bugfix mode: preserve worktree and branch (existing behavior)
    if (existsSync(builder.worktree)) {
      logger.info(`Worktree preserved at: ${builder.worktree}`);
      logger.info('To remove: git worktree remove "' + builder.worktree + '"');
    }

    if (builder.branch) {
      logger.info(`Branch preserved: ${builder.branch}`);
      logger.info('To delete: git branch -d "' + builder.branch + '"');
    }
  }

  // Remove from state
  removeBuilder(builder.id);

  // Clean up porch state (codev/projects/NNNN-*/) so fresh kickoff gets fresh state
  if (!isShellMode) {
    await cleanupPorchState(builder.id, config);
  }

  // Always prune stale worktree entries to prevent "can't find session" errors
  // This catches any orphaned worktrees from crashes or manual kills
  if (!isShellMode) {
    try {
      await run('git worktree prune', { cwd: config.projectRoot });
    } catch {
      // Non-fatal - prune is best-effort cleanup
    }
  }

  logger.blank();
  logger.success(`Builder ${builder.id} cleaned up!`);
}
