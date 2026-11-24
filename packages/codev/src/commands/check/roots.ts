/**
 * Where `codev check` is running, asked of git (Spec 1951 plan § Decisions).
 *
 * `findWorkspaceRoot()` deliberately returns a builder worktree's OWN root (#407), and
 * `.builders/` does not exist there. So the roots come from git:
 *   - `checkoutRoot` — `git rev-parse --show-toplevel`, the checkout the command runs in;
 *   - `mainRoot` — the first entry of `git worktree list --porcelain`, which git always
 *     lists as the main worktree.
 * Configuration loads from `mainRoot` and builder ids resolve under it, so the commands
 * behave the same from the main checkout and from any builder worktree.
 */

import { resolve } from 'node:path';
import { CheckCommandError } from './report.js';
import type { Runner } from './runner.js';

export interface Roots {
  checkoutRoot: string;
  mainRoot: string;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** `refs/heads/…` stripped; null for a detached HEAD. */
  branch: string | null;
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain`. Paths are resolved to the platform's form. A path is
 * taken verbatim, so one ending in a space survives; `-z` would also carry a newline in a path,
 * but it needs git 2.36, and the commands run on older git (only the trial merge needs 2.38).
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l !== '');
    const pathLine = lines.find((l) => l.startsWith('worktree '));
    if (!pathLine) continue;
    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const branchLine = lines.find((l) => l.startsWith('branch '));
    entries.push({
      path: resolve(pathLine.slice('worktree '.length)),
      head: headLine ? headLine.slice('HEAD '.length) : null,
      branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
      bare: lines.includes('bare'),
    });
  }
  return entries;
}

export async function listWorktrees(runner: Runner): Promise<WorktreeEntry[]> {
  const result = await runner.git(['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) throw new CheckCommandError('could not list worktrees', result.stderr.trim());
  return parseWorktreeList(result.stdout);
}

/**
 * Find both roots: the only two git calls a command makes before its configuration is
 * validated, since the configuration is read from the main checkout and only git can name it
 * from a linked worktree. Neither takes a configuration value. Fails with exit 2 outside a
 * checkout.
 */
export async function resolveRoots(runner: Runner): Promise<Roots> {
  const top = await runner.git(['rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0) throw new CheckCommandError('not in a git repository', top.stderr.trim());
  const checkoutRoot = resolve(top.stdout.trim());

  const [main] = await listWorktrees(runner);
  if (!main) throw new CheckCommandError('git worktree list returned no worktrees');
  if (main.bare) throw new CheckCommandError(`the main worktree ${main.path} is a bare repository; run codev check from a checkout`);
  return { checkoutRoot, mainRoot: main.path };
}

/** Require an `origin` remote (exit 2 otherwise). Called after the configuration is validated. */
export async function requireOrigin(runner: Runner): Promise<void> {
  const origin = await runner.git(['config', '--get', 'remote.origin.url']);
  if (origin.exitCode !== 0 || origin.stdout.trim() === '') {
    throw new CheckCommandError('this repository has no "origin" remote; codev check reads base and head from origin');
  }
}
