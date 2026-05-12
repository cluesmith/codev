/**
 * Codev: Open Worktree Folder — reveal a builder's worktree in the OS
 * file manager (Finder on macOS, Explorer on Windows, xdg-open on Linux).
 *
 * Right-click a builder row → "Open Worktree Folder". Resolves the
 * builder via Tower's overview and hands off to
 * `vscode.env.openExternal(file://...)` which opens directories natively
 * on all three platforms.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

export async function openWorktreeFolder(
  connectionManager: ConnectionManager,
  builderIdArg: string | undefined,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const overview = await client.getOverview(workspacePath);
  const builders = overview?.builders ?? [];
  if (builders.length === 0) {
    vscode.window.showInformationMessage('Codev: No builders available');
    return;
  }

  const builder = builderIdArg
    ? builders.find(b => b.id === builderIdArg)
    : await pickBuilder(builders);
  if (!builder) {
    if (builderIdArg) {
      vscode.window.showErrorMessage(`Codev: No builder found for "${builderIdArg}"`);
    }
    return;
  }
  if (!builder.worktreePath) {
    vscode.window.showErrorMessage(`Codev: Builder ${builder.id} has no worktree on record`);
    return;
  }

  await vscode.env.openExternal(vscode.Uri.file(builder.worktreePath));
}

interface BuilderLike {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
}

async function pickBuilder<T extends BuilderLike>(builders: T[]): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(
    builders.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      builder: b,
    })),
    { placeHolder: 'Select builder whose worktree to open' },
  );
  return picked?.builder;
}
