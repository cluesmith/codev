/**
 * Git utility helpers used by spawn-time checks.
 */

import { run } from './shell.js';

/**
 * Check whether the given worktree has uncommitted changes to tracked files.
 *
 * Returns true iff there are modifications or staged changes to files known
 * to git on HEAD. Untracked files (status `??`) are deliberately ignored —
 * those are local artifacts (build outputs, local-install symlinks, editor
 * state) that didn't come from main and aren't work-in-progress the builder
 * needs to see (Bugfix #745).
 *
 * The spec/plan case (architect writes a spec but forgets to commit) is
 * caught as long as the architect runs `git add` to stage the file — that
 * puts foo.md in the index where it shows as `A ` (tracked addition), not
 * `??` (untracked).
 *
 * Known tradeoff: an architect who creates a new file but never runs `git
 * add` will not trigger this check. The issue reporter accepted this as
 * preferable to the prior behavior (chronic false positives that forced
 * `--force` on every spawn, defeating the check entirely). The protected
 * workflow is `git add` then spawn; an entirely-unstaged file is treated
 * as draft work the architect is still authoring.
 *
 * Fails open: returns false if `git status` errors for any reason, so a
 * transient git failure doesn't block legitimate spawns.
 */
export async function hasUncommittedTrackedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('git status --porcelain --untracked-files=no', { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
