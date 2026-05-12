/**
 * Codev: Stop Dev Server — kill the currently running Codev-managed dev PTY.
 *
 * Counterpart to `codev.runWorktreeDev`. Finds the running dev terminal by
 * its `Dev: <id>` label prefix, kills it via Tower, and disposes the
 * corresponding VSCode terminal tab.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';

export async function stopWorktreeDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  const client = connectionManager.getClient();
  if (!client || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const all = await client.listTerminals();
  const dev = all.find(t => t.label?.startsWith('Dev: '));
  if (!dev) {
    vscode.window.showInformationMessage('Codev: No dev server is running');
    return;
  }

  const builderId = dev.label.slice('Dev: '.length);
  await client.killTerminal(dev.id);
  terminalManager.closeDevTerminal(builderId);
  vscode.window.showInformationMessage(`Codev: Dev server stopped for ${builderId}`);
}
