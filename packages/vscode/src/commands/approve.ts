import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Codev: Approve Gate — show blocked builders, pick one, approve via porch CLI.
 */
export async function approveGate(connectionManager: ConnectionManager): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const overview = await client.getOverview(workspacePath);
  const blocked = overview?.builders?.filter(b => b.blocked) ?? [];
  if (blocked.length === 0) {
    vscode.window.showInformationMessage('Codev: No blocked builders');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    blocked.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      description: `blocked on ${b.blocked}`,
      id: b.id,
      gate: b.blocked!,
    })),
    { placeHolder: 'Select gate to approve' },
  );
  if (!picked) { return; }

  const child = spawn('porch', ['approve', picked.id, picked.gate, '--a-human-explicitly-approved-this'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  vscode.window.showInformationMessage(`Codev: Approving ${picked.gate} for #${picked.id}`);
}
