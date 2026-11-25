/**
 * Where the Work and Decisions panels are offered (Spec 1963): only in a window of a Codev
 * workspace, and not in a builder-worktree window (#1809: surfaces that act on the parent workspace
 * stay in the parent's window). Elsewhere their commands stay in the Command Palette and say why
 * they do nothing, instead of being silently absent. No `vscode` import.
 */

export interface WorkspaceViewsWindow {
  /** The window is rooted at a builder worktree (#1809). */
  builderWorktreeWindow: boolean;
  /** This window's Codev workspace, or null when it has none. */
  workspacePath: string | null;
}

/** Why `surface` is not offered in this window, or null when it is. */
export function workspaceViewUnavailableReason(surface: string, window: WorkspaceViewsWindow): string | null {
  if (window.builderWorktreeWindow) {
    return `Codev: ${surface} is not offered in a builder-worktree window. Use it from the parent workspace's window.`;
  }
  if (window.workspacePath === null) {
    return `Codev: ${surface} needs a Codev workspace, and this window has none. Open a folder containing a Codev project.`;
  }
  return null;
}
