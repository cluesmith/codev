import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a directory is itself a codev workspace root: it directly
 * contains a `.codev/` or `codev/` entry.
 *
 * Deliberately NO ancestor walk (#1144). Detection used to traverse
 * upward to the filesystem root looking for these markers, which made
 * every folder under a codev-enabled home directory silently inherit
 * that workspace — and with `onStartupFinished` activation, detection
 * is now an inertness gate that runs in every window, so it must be
 * exactly as predictable as "the folder you opened is the workspace".
 * This also matches the CLI's semantics (afx runs from the workspace
 * root; its only indirection is git worktree → main repo, and builder
 * worktrees carry their own `codev/` copy so they match directly).
 * Layouts where the marker genuinely lives above the opened folder are
 * served by the `codev.workspacePath` setting override.
 */
export function isCodevWorkspaceRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.codev'))
    || fs.existsSync(path.join(dir, 'codev'));
}

/**
 * Detect the workspace path for Tower communication.
 * Priority: setting override > first workspace folder (if it is a codev
 * workspace root). Returns null when neither applies — the caller treats
 * that as "not a codev window".
 */
export function detectWorkspacePath(): string | null {
  const override = vscode.workspace.getConfiguration('codev').get<string>('workspacePath');
  if (override) {
    return override;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  const root = folders[0].uri.fsPath;
  if (isCodevWorkspaceRoot(root)) {
    return root;
  }
  return null;
}

/**
 * Get Tower host and port from VS Code settings.
 */
export function getTowerAddress(): { host: string; port: number } {
  const config = vscode.workspace.getConfiguration('codev');
  return {
    host: config.get<string>('towerHost', 'localhost'),
    port: config.get<number>('towerPort', 4100),
  };
}
