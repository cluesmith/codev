/**
 * Cleanup command - removes builder worktrees and branches
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { Builder, Config } from '../types.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { loadState, removeBuilder } from '../state.js';
import { TowerClient } from '../lib/tower-client.js';
import { getGlobalDb, closeGlobalDb } from '../db/index.js';
import { deleteFileTabsByPathPrefix } from '../utils/file-tabs.js';

/**
 * Clean porch review artifacts for a project from codev/projects/,
 * preserving status.yaml for analytics and historical tracking.
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
        const projectDir = join(projectsDir, entry.name);
        const children = readdirSync(projectDir);

        // Delete review artifacts but preserve status.yaml
        for (const child of children) {
          if (child === 'status.yaml') continue;
          await rm(join(projectDir, child), { recursive: true, force: true });
        }

        // Log what we did
        const hasStatus = children.includes('status.yaml');
        if (hasStatus) {
          logger.info(`Cleaned porch artifacts: ${entry.name} (preserved status.yaml)`);
        } else {
          // No status.yaml — remove the empty directory
          await rm(projectDir, { recursive: true, force: true });
          logger.info(`Removed porch state: ${entry.name}`);
        }
      }
    }
  } catch (error) {
    logger.warn(`Warning: Failed to cleanup porch state: ${error}`);
  }
}

/**
 * Find and kill shellper processes associated with a worktree path (Bugfix #389).
 *
 * When Tower is not running (or the terminal was already removed from Tower's
 * registry), the Tower API kill path silently fails, leaving shellper processes
 * orphaned. This function searches `ps` output for shellper-main.js processes
 * whose JSON config contains the worktree path as `cwd`, and kills them directly.
 *
 * Uses process group kill (-pid) to also terminate PTY children (Claude, bash).
 */
export async function killShellperProcesses(worktreePath: string): Promise<number> {
  let killed = 0;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      // -ww prevents arg truncation on macOS/Linux
      execFile('ps', ['-ww', '-eo', 'pid,args'], (err, out) => {
        if (err) { reject(err); return; }
        resolve(out);
      });
    });

    // Match shellper-main.js processes whose JSON config cwd is this worktree.
    // The shellper is spawned with JSON as argv[2]: {"cwd":"/path/to/worktree",...}
    const cwdPattern = `"cwd":"${worktreePath}"`;

    for (const line of stdout.split('\n')) {
      if (!line.includes('shellper-main.js')) continue;
      if (!line.includes(cwdPattern)) continue;

      const pid = parseInt(line.trim(), 10);
      if (isNaN(pid) || pid <= 0 || pid === process.pid) continue;

      try {
        // Kill process group (shellper + its PTY child) to prevent orphaned
        // PTY processes. Shellper is spawned with detached:true, so it's a
        // process group leader.
        process.kill(-pid, 'SIGTERM');
        killed++;
      } catch {
        // Process group kill failed — try individual PID
        try {
          process.kill(pid, 'SIGTERM');
          killed++;
        } catch {
          // Process already dead
        }
      }
    }
  } catch {
    // ps not available or failed — non-fatal
  }
  return killed;
}

export interface CleanupOptions {
  project?: string;
  issue?: number;
  task?: string;
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
    await run(`git push origin --delete "${branch}"`, { cwd: config.workspaceRoot });
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
  } else if (options.task) {
    // Find task builder by worktree name (e.g., "task-bEPd")
    const taskName = options.task;
    // Task builder IDs are "builder-task-<lowercased shortId>" (via buildAgentName)
    // Extract the shortId from the worktree name (e.g., "task-bEPd" → "bEPd" → "bepd")
    const shortId = taskName.startsWith('task-') ? taskName.slice(5) : taskName;
    const normalizedId = `builder-task-${shortId.toLowerCase()}`;
    builder = state.builders.find((b) => b.id === normalizedId);

    if (!builder) {
      // Fallback: check by worktree path containing the task name
      builder = state.builders.find((b) => b.worktree.endsWith(`/${taskName}`) || b.worktree.endsWith(`/${taskName}/`));
    }

    if (!builder) {
      fatal(`Task builder not found for: ${taskName}`);
    }
  } else if (options.project) {
    const projectId = options.project;
    builder = state.builders.find((b) => b.id === projectId);

    if (!builder) {
      // Try normalized task ID (e.g., "task-bEPd" → "builder-task-bepd")
      if (projectId.startsWith('task-')) {
        const shortId = projectId.slice(5);
        const normalizedId = `builder-task-${shortId.toLowerCase()}`;
        builder = state.builders.find((b) => b.id === normalizedId);
      }
    }

    if (!builder) {
      // Try to find by name pattern
      const byName = state.builders.find((b) => b.name.includes(projectId));
      if (byName) {
        return cleanupBuilder(byName, options.force, options.issue);
      }
      fatal(`Builder not found for project: ${projectId}`);
    }
  } else {
    fatal('Must specify either --project, --issue, or --task');
  }

  await cleanupBuilder(builder, options.force, options.issue);
}

async function cleanupBuilder(builder: Builder, force?: boolean, issueNumber?: number): Promise<void> {
  const config = getConfig();
  const isShellMode = builder.type === 'shell';
  const isBugfixMode = builder.type === 'bugfix';
  const isTaskMode = builder.type === 'task';
  // Ephemeral builders (bugfix, task) get full cleanup: remove worktree + delete branches
  const isEphemeral = isBugfixMode || isTaskMode;

  const typeLabel = isShellMode ? 'Shell' : isBugfixMode ? 'Bugfix Builder' : isTaskMode ? 'Task Builder' : 'Builder';
  logger.header(`Cleaning up ${typeLabel} ${builder.id}`);
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

  // Kill Tower terminal if exists
  if (builder.terminalId) {
    try {
      const client = new TowerClient();
      const killed = await client.killTerminal(builder.terminalId);
      if (killed) {
        logger.info('Killed Tower terminal');
      }
    } catch {
      // Tower may not be running
    }
  }

  // Bugfix #389: Kill shellper processes directly by worktree path.
  // The Tower API kill may fail if Tower isn't running, the terminal was already
  // removed, or Tower was restarted. This catches any surviving shellper processes.
  if (!isShellMode && builder.worktree) {
    const shellpersKilled = await killShellperProcesses(builder.worktree);
    if (shellpersKilled > 0) {
      logger.info(`Killed ${shellpersKilled} shellper process(es)`);
    }
  }

  // Bugfix #474: Delete file tabs whose file_path points into this worktree
  if (!isShellMode && builder.worktree) {
    try {
      const db = getGlobalDb();
      const deleted = deleteFileTabsByPathPrefix(db, builder.worktree);
      if (deleted > 0) {
        logger.info(`Removed ${deleted} stale file tab(s)`);
      }
      closeGlobalDb();
    } catch {
      // Non-fatal — Tower may handle cleanup on its own
    }
  }

  // For ephemeral builders (bugfix, task): actually remove worktree and delete branches
  if (isEphemeral && !isShellMode) {
    // Remove worktree
    if (existsSync(builder.worktree)) {
      logger.info('Removing worktree...');
      try {
        await run(`git worktree remove "${builder.worktree}" --force`, { cwd: config.workspaceRoot });
        logger.info('Worktree removed');
      } catch {
        logger.warn('Warning: Failed to remove worktree');
      }
    }

    // Delete local branch
    if (builder.branch) {
      logger.info('Deleting local branch...');
      try {
        await run(`git branch -D "${builder.branch}"`, { cwd: config.workspaceRoot });
        logger.info('Local branch deleted');
      } catch {
        // Branch may not exist locally
      }
    }

    // Delete remote branch
    // Task builders typically don't push to remote, so skip PR verification for them
    if (builder.branch) {
      if (isTaskMode) {
        // Task builders are ephemeral — always delete remote branch if it exists
        await deleteRemoteBranch(builder.branch, config);
      } else if (!force) {
        // Bugfix: verify PR is merged first unless --force
        try {
          const prStatus = await run(`gh pr list --head "${builder.branch}" --state merged --json number --limit 1`, { cwd: config.workspaceRoot });
          const mergedPRs = JSON.parse(prStatus.stdout);
          if (mergedPRs.length === 0) {
            // Check for open PRs
            const openPRStatus = await run(`gh pr list --head "${builder.branch}" --state open --json number --limit 1`, { cwd: config.workspaceRoot });
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
      await run('git worktree prune', { cwd: config.workspaceRoot });
    } catch {
      // Non-fatal - prune is best-effort cleanup
    }
  }

  logger.blank();
  logger.success(`Builder ${builder.id} cleaned up!`);
}
