import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const execFileAsync = promisify(execFile);

/**
 * Codev: Cleanup Builder — pick builder, run `afx cleanup`, then refresh the
 * sidebar so the removed builder disappears immediately.
 *
 * After successful cleanup, fires three side effects in order:
 *
 *   1. Show success / error toast based on the actual exit status (the old
 *      fire-and-forget spawn silently swallowed errors).
 *   2. Notify the architect — cleanup removes a builder from porch's view,
 *      which is a state change worth recording in the architect's
 *      conversation history.
 *   3. Refresh OverviewCache so the Needs Attention and Builders trees
 *      drop the removed entry without waiting for the next SSE tick. This
 *      fixes the user-visible bug where a cleaned-up builder lingered in
 *      the sidebar.
 */
export async function cleanupBuilder(
  connectionManager: ConnectionManager,
  cache?: OverviewCache,
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
    vscode.window.showInformationMessage('Codev: No builders to clean up');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    builders.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      description: b.phase,
      id: b.id,
    })),
    { placeHolder: 'Select builder to clean up' },
  );
  if (!picked) { return; }

  try {
    await execFileAsync('afx', ['cleanup', '-p', picked.id]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Codev: afx cleanup failed — ${msg}`);
    return;
  }

  vscode.window.showInformationMessage(`Codev: Cleaned up builder #${picked.id}`);

  // Architect breadcrumb — cleanup removes a builder from porch's view;
  // the architect should know.
  execFileAsync('afx', [
    'send',
    'architect',
    `User cleaned up builder ${picked.id} via VSCode.`,
  ]).catch(() => {
    // Best-effort.
  });

  // Refresh the cache so the sidebar drops the removed builder immediately.
  cache?.refresh();
}
