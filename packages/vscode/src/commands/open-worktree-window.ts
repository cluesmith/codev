/**
 * Codev: Open Worktree as Workspace — opens a builder's worktree in a new
 * editor window. The new window is rooted at `.builders/<id>/`, so VSCode's
 * built-in Git extension treats it as a primary checkout: the SCM panel
 * shows working-tree changes, "View Working Tree Changes" shows committed
 * diff vs the default branch, and inline-editor diffs work natively.
 *
 * Replaces the previous "View Diff" command, which tried to render a
 * multi-file diff in the current window via `vscode.changes` + `git:` URIs
 * but couldn't, because VSCode's Git extension doesn't auto-discover
 * worktrees inside `.gitignore`d subdirectories of the host workspace.
 *
 * Editor-agnostic: `vscode.openFolder` is a built-in command exposed by
 * VSCode, Cursor, Windsurf, and other VSCode-family editors. No CLI
 * detection needed.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

export async function openWorktreeWindow(
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

  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(builder.worktreePath),
    /* forceNewWindow */ true,
  );
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
    { placeHolder: 'Select builder to open in new window' },
  );
  return picked?.builder;
}
