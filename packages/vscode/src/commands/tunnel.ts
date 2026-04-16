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
  await client.signalTunnel('disconnect');
  vscode.window.showInformationMessage('Codev: Tunnel disconnected');
}
