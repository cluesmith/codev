/**
 * Codev: Run Worktree Setup — execute `worktree.postSpawn` against an
 * existing builder's worktree, without recreating it.
 *
 * Use cases: lockfile changed and dependencies need reinstalling; a new
 * step was added to `worktree.postSpawn` after the builder spawned;
 * setup aborted mid-spawn and the worktree needs recovery; running
 * setup for the first time on a builder that predates the config.
 *
 * Implementation: shells out to `afx setup <builder-id>` in a fresh
 * VSCode integrated terminal. The CLI is the single source of truth for
 * postSpawn semantics — each command runs in its own bash subshell with
 * cwd = worktreePath (so `cd apps/foo && uv sync` doesn't bleed into
 * the next command), and runStreaming in the back-end pipes stdout /
 * stderr live so the user sees install progress in real time.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

export async function runWorktreeSetup(
  connectionManager: ConnectionManager,
  builderIdArg: string | undefined,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  let builderId = builderIdArg;
  if (!builderId) {
    const overview = await client.getOverview(workspacePath);
    const builders = overview?.builders ?? [];
    if (builders.length === 0) {
      vscode.window.showInformationMessage('Codev: No builders available');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      builders.map(b => ({
        label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
        builder: b,
      })),
      { placeHolder: 'Select builder whose worktree to re-setup' },
    );
    builderId = picked?.builder.id;
  }
  if (!builderId) { return; }

  const terminal = vscode.window.createTerminal({
    name: `Codev: Setup ${builderId}`,
    cwd: workspacePath,
  });
  terminal.show();
  terminal.sendText(`afx setup ${builderId}`);
}
