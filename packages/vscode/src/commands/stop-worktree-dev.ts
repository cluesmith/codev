/**
 * Codev: Stop Dev Server — kill the currently running Codev-managed dev PTY.
 *
 * Counterpart to `codev.runWorktreeDev`. Asks TerminalManager which dev
 * terminals it has open (its local map is the source of truth — see
 * `TerminalManager.listDevTerminals`), kills the Tower-side PTY for each,
 * and disposes the VSCode tab so the user doesn't see a dead "Process
 * exited" tab lingering.
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

  const devs = terminalManager.listDevTerminals();
  if (devs.length === 0) {
    vscode.window.showInformationMessage('Codev: No dev server is running');
    return;
  }

  for (const { builderId, terminalId } of devs) {
    await client.killTerminal(terminalId);
    terminalManager.closeDevTerminal(builderId);
  }

  const summary = devs.length === 1
    ? `Codev: Dev server stopped for ${devs[0]!.builderId}`
    : `Codev: Stopped ${devs.length} dev servers`;
  vscode.window.showInformationMessage(summary);
}
