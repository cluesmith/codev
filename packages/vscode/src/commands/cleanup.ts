import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Codev: Cleanup Builder — pick builder, run afx cleanup.
 */
export async function cleanupBuilder(connectionManager: ConnectionManager): Promise<void> {
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

  const child = spawn('afx', ['cleanup', '-p', picked.id], { detached: true, stdio: 'ignore' });
  child.unref();
  vscode.window.showInformationMessage(`Codev: Cleaning up builder #${picked.id}`);
}
