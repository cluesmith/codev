import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionManager } from '../connection-manager.js';

const execFileAsync = promisify(execFile);

/**
 * Codev: Send Message — pick builder, type message, send via TowerClient.
 *
 * After successful send, fires a breadcrumb to the architect so its view of
 * the protocol state stays in sync. Porch orchestrates through the architect;
 * a builder's behavior changing in response to user feedback is a fact the
 * architect should know about without having to poll porch state.
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

  // Architect breadcrumb. Short preview (first 80 chars) — full text lives
  // in the builder's pane; architect only needs the gist + target builder.
  const preview = message.length > 80 ? `${message.slice(0, 77)}...` : message;
  execFileAsync('afx', [
    'send',
    'architect',
    `User sent feedback to ${picked.id} via VSCode: "${preview}"`,
  ]).catch(() => {
    // Best-effort.
  });
}
