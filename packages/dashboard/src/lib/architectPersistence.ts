/**
 * Spec 761: per-workspace persistence of the active architect tab.
 *
 * Uses `window.location.pathname` (URL-encoded full workspace path) as the
 * key suffix rather than `DashboardState.workspaceName`. The latter is
 * `path.basename(workspacePath)` and would collide between workspaces with
 * the same basename (e.g. ~/work/codev and ~/personal/codev).
 */

const KEY_PREFIX = 'codev-active-architect:';

function workspaceKey(): string {
  return window.location.pathname;
}

export function readActiveArchitect(): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + workspaceKey());
  } catch {
    return null;
  }
}

export function writeActiveArchitect(name: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + workspaceKey(), name);
  } catch {
    // quota / SSR / private-mode — silently ignore
  }
}
