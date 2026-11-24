/**
 * The files `afx spawn` writes into a builder worktree that are not the builder's work
 * (Spec 1951). Pure, so `afx cleanup` and `codev check worktree` share one list and agree on
 * what is scaffold:
 *
 *   - any root-level `.builder-*` file (the prompt, role, start script, session id, and the
 *     refresh state files, whose names keep that prefix so they classify as scaffold);
 *   - the write guard's hook script and settings (`worktree-write-guard.ts`);
 *   - OpenCode's `opencode.json`, which points the harness at `.builder-role.md`.
 *
 * Only an untracked file is ever scaffold: a change to a tracked file is a real change,
 * whatever its path.
 */

import { GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH } from '../utils/worktree-write-guard.js';

/** Worktree-relative path of the OpenCode harness's role-injection file. */
export const OPENCODE_CONFIG_RELPATH = 'opencode.json';

const BUILDER_PREFIX = '.builder-';

/** The scaffold files with fixed paths; `.builder-*` is matched by prefix. */
export const SCAFFOLD_PATHS: readonly string[] = [GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH, OPENCODE_CONFIG_RELPATH];

/** Whether a worktree-relative, `/`-separated path of an untracked file is spawn's scaffold. */
export function isBuilderScaffold(path: string): boolean {
  return (path.startsWith(BUILDER_PREFIX) && !path.includes('/')) || SCAFFOLD_PATHS.includes(path);
}
