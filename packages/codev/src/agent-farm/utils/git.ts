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
 * still caught: `git add codev/specs/foo.md` puts foo.md in the index,
 * making it a tracked modification (status `A `), not an untracked file (`??`).
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
