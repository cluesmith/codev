/**
 * Title-bar actions for the Codev Dev panel tab (#921). Thin handlers that
 * delegate to the shared dev core (dev-shared.ts) and the existing stop
 * command — the tab surfaces controls; the orchestration lives where every
 * other dev front-end's does.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { stopWorktreeDev } from './stop-worktree-dev.js';
import {
  startDevForTarget,
  restartDevForTarget,
  resolveDevTargetById,
  listSwitchTargets,
} from './dev-shared.js';

/** Stop the running dev. Single-slot, so this is the one dev in the registry. */
export async function stopDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  await stopWorktreeDev(connectionManager, terminalManager);
}

/** Stop and respawn the dev for whatever target is currently running. */
export async function restartDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  const running = terminalManager.listDevTerminals()[0];
  if (!running) {
    vscode.window.showInformationMessage('Codev: No dev is running');
    return;
  }
  const target = await resolveDevTargetById(connectionManager, running.builderId);
  if (!target) {
    vscode.window.showErrorMessage(`Codev: Could not resolve a target to restart for ${running.builderId}`);
    return;
  }
  await restartDevForTarget(connectionManager, terminalManager, target);
}

/** Quick Pick a dev target (main or a builder) and start it — startDevForTarget
 *  surfaces the single-slot swap prompt when another target is already running. */
export async function switchDevTarget(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
): Promise<void> {
  const targets = await listSwitchTargets(connectionManager);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Codev: No dev targets available');
    return;
  }
  const running = terminalManager.listDevTerminals()[0]?.builderId;
  const picked = await vscode.window.showQuickPick(
    targets.map(t => ({
      label: t.id === running ? `$(check) ${t.name}` : t.name,
      description: t.id === running ? 'running' : undefined,
      target: t,
    })),
    { placeHolder: 'Select dev target' },
  );
  if (!picked) { return; }
  await startDevForTarget(connectionManager, terminalManager, picked.target);
}

/**
 * Open the Codev sidebar and focus the Workspace view, where the Dev row
 * lives. Paired with `hideCodevSidebar` to form a show/hide toggle on the tab's
 * title bar (the two `view/title` entries swap on the sidebar-visibility context
 * keys, mirroring the Backlog view's show-all / mine-only toggle).
 */
export async function showCodevSidebar(): Promise<void> {
  await vscode.commands.executeCommand('codev.workspace.focus');
}

/** Close the sidebar — the toggle-off half of the Codev Dev tab's sidebar control. */
export async function hideCodevSidebar(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
}
