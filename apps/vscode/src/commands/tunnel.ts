import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

export async function connectTunnel(connectionManager: ConnectionManager): Promise<void> {
  const client = connectionManager.getClient();
  if (!client || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }
  await client.signalTunnel('connect');
  vscode.window.showInformationMessage('Codev: Tunnel connecting...');
}

export async function disconnectTunnel(connectionManager: ConnectionManager): Promise<void> {
  const client = connectionManager.getClient();
  if (!client || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  // #1370: this deregisters the tower server-side and deletes the local cloud
  // credentials — reconnecting needs a fresh OAuth. A fuzzy palette match plus
  // Enter must not be enough to trigger it.
  const choice = await vscode.window.showWarningMessage(
    'Disconnect this tower from Codev Cloud?',
    {
      modal: true,
      detail:
        'This deregisters the tower server-side and deletes its local cloud credentials. '
        + 'Reconnecting requires signing in again.',
    },
    'Disconnect',
  );
  if (choice !== 'Disconnect') {return;}

  await client.signalTunnel('disconnect');
  vscode.window.showInformationMessage('Codev: Tower deregistered from Codev Cloud');
}
