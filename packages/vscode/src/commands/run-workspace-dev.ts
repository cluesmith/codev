/**
 * Codev: Start / Stop Dev Server (Workspace view) — runs the dev server for
 * whatever folder *this VSCode window is rooted at*. Not "main"-specific:
 *
 *   - window opened on the main checkout      → target `main`, cwd = root
 *   - window opened on a `.builders/<id>/`    → target `<id>`, cwd = worktree
 *     worktree (e.g. via "Open Worktree as Workspace")
 *
 * Target resolution is the *only* difference from the builder-row command;
 * the actual spawn/swap/stop is the shared core in dev-shared.ts.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { resolveWorkspaceDevTarget, startDevForTarget, stopDevForTarget } from './dev-shared.js';

export async function runWorkspaceDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  const workspacePath = connectionManager.getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }
  const target = resolveWorkspaceDevTarget(workspacePath);
  await startDevForTarget(connectionManager, terminalManager, target);
}

export async function stopWorkspaceDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  const workspacePath = connectionManager.getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }
  const target = resolveWorkspaceDevTarget(workspacePath);
  await stopDevForTarget(connectionManager, terminalManager, target.id, target.name);
}
