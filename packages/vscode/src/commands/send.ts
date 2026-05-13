import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Codev: Send Message — pick builder, type message, send via TowerClient.
 */
export async function sendMessage(connectionManager: ConnectionManager): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const state = await client.getWorkspaceState(workspacePath);
  const builders = state?.builders?.filter(b => b.terminalId) ?? [];
  if (builders.length === 0) {
    vscode.window.showWarningMessage('Codev: No active builders');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    builders.map(b => ({ label: b.name, id: b.id })),
    { placeHolder: 'Select builder to send message to' },
  );
  if (!picked) { return; }

  const message = await vscode.window.showInputBox({
    prompt: `Message to ${picked.label}`,
    placeHolder: 'Type your message...',
  });
  if (!message) { return; }

  const result = await client.sendMessage(picked.id, message, { workspace: workspacePath });
  if (!result.ok) {
    vscode.window.showErrorMessage(`Codev: Failed to send — ${result.error}`);
    return;
  }

  vscode.window.showInformationMessage(`Codev: Message sent to ${picked.label}`);
}
