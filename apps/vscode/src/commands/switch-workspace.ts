import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { ConnectionManager } from '../connection-manager.js';
import type { FleetEntry, TowerFleetCache } from '../views/tower-cache.js';
import { OPEN_WORKSPACE_COMMAND } from '../views/tower.js';
import { disambiguateLabels } from '../views/workspace-label.js';
import { describeAttention } from '../views/attention-format.js';

/** The existing inbound command that re-validates a path and opens/focuses its window. */
const FOCUS_WORKSPACE_COMMAND = 'codev.focusWorkspaceWindow';

/** A workspace the open/activate action targets. */
export interface WorkspaceTarget {
  path: string;
  active: boolean;
  name: string;
}

/**
 * The side-effecting operations the open/activate flow needs, injected so the flow itself is a pure,
 * fully testable decision tree (no `vscode`/`fs` mock required to test the adopt-confirm, rate-limit,
 * and switch-vs-activate branches). `registerTowerCommands` wires the real implementations.
 */
export interface WorkspaceActionDeps {
  /** Run a VS Code command (the switch path delegates to `codev.focusWorkspaceWindow`). */
  runCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  /** Activate a dormant workspace (POST /activate) — may adopt server-side, may be rate-limited. */
  activate: (workspacePath: string) => Promise<{ ok: boolean; adopted?: boolean; error?: string }>;
  /** True when the target directory already contains a `codev/` project (so activation won't adopt). */
  isAdopted: (workspacePath: string) => boolean;
  /** Ask the human to confirm the adopt-on-activate write. Resolves true to proceed. */
  confirmAdopt: (target: WorkspaceTarget) => Promise<boolean>;
  /** Surface a non-fatal informational message. */
  notify: (message: string) => void;
  /** Surface a non-fatal error message. */
  notifyError: (message: string) => void;
  /** Refresh the fleet cache (activation emits no SSE, so the list must be re-polled). */
  refresh: () => Promise<void>;
}

/**
 * Open a workspace's window, activating it first if it is dormant.
 *
 * - **Active** → delegate straight to `codev.focusWorkspaceWindow` (its own re-validation +
 *   `openFolder { forceNewWindow: true }`); the hub adds no window machinery of its own.
 * - **Dormant** → activate on demand. If the directory isn't yet a Codev project, activation would
 *   run `codev adopt` server-side and write files, so we **confirm first** (never adopt silently).
 *   After a successful activate we surface an adopt notice when it happened, refresh the list (no SSE
 *   fires for activation), then open the window. A rate-limited or failed activate is reported and
 *   stops here.
 */
export async function openOrActivateWorkspace(deps: WorkspaceActionDeps, target: WorkspaceTarget): Promise<void> {
  if (target.active) {
    await deps.runCommand(FOCUS_WORKSPACE_COMMAND, target.path);
    return;
  }

  if (!deps.isAdopted(target.path)) {
    const proceed = await deps.confirmAdopt(target);
    if (!proceed) { return; }
  }

  const result = await deps.activate(target.path);
  if (!result.ok) {
    deps.notifyError(activationErrorMessage(target.name, result.error));
    return;
  }
  if (result.adopted) {
    deps.notify(`Set up Codev in ${target.name} and activated it.`);
  }
  await deps.refresh();
  await deps.runCommand(FOCUS_WORKSPACE_COMMAND, target.path);
}

/** A human-readable failure message, distinguishing the rate-limit case (requirement 5). */
export function activationErrorMessage(name: string, error?: string): string {
  if (error && /rate|too many|429/i.test(error)) {
    return `Too many workspace activations — wait a moment, then try ${name} again.`;
  }
  if (error) {
    return `Couldn't activate ${name}: ${error}`;
  }
  return `Couldn't activate ${name}.`;
}

/** A quick-pick row for one workspace. */
export interface WorkspacePickItem extends vscode.QuickPickItem {
  target: WorkspaceTarget;
}

/**
 * Build the switch quick-pick rows: the same disambiguated labels, urgency order, and attention
 * annotations as the tree. Active workspaces first (urgency-ordered, current one marked), then a
 * separator, then dormant workspaces (label order). Pure — no `vscode` runtime needed to test.
 */
export function buildWorkspacePicks(fleet: ReadonlyArray<FleetEntry>, currentPath: string | null): WorkspacePickItem[] {
  const labels = disambiguateLabels(fleet.map((e) => e.workspace));
  const labelOf = (entry: FleetEntry) => labels.get(entry.workspace.path) ?? entry.workspace.name;

  const active = fleet.filter((e) => e.workspace.active);
  const dormant = fleet.filter((e) => !e.workspace.active);
  active.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  active.sort((a, b) => compareAttention(a.attention, b.attention));
  dormant.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));

  const items: WorkspacePickItem[] = [];
  for (const entry of active) {
    const label = labelOf(entry);
    const glance = describeAttention(entry.attention);
    const descriptionParts: string[] = [];
    if (entry.workspace.path === currentPath) { descriptionParts.push('current'); }
    if (glance) { descriptionParts.push(glance.text); }
    items.push({
      label,
      description: descriptionParts.join(' · '),
      target: { path: entry.workspace.path, active: true, name: label },
    });
  }
  if (dormant.length > 0) {
    items.push({ label: 'Dormant', kind: vscode.QuickPickItemKind.Separator, target: { path: '', active: false, name: '' } });
    for (const entry of dormant) {
      const label = labelOf(entry);
      items.push({
        label,
        description: 'activate',
        target: { path: entry.workspace.path, active: false, name: label },
      });
    }
  }
  return items;
}

/**
 * Register the Tower action commands: the row-click open/activate, the keyboard-first
 * `codev.switchWorkspace` quick-pick, and the row-context deactivate. Thin glue — it builds the
 * real `WorkspaceActionDeps` and delegates the logic to the tested functions above.
 */
export function registerTowerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  cache: TowerFleetCache,
): void {
  const deps: WorkspaceActionDeps = {
    runCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    activate: async (workspacePath) => {
      const client = connectionManager.getClient();
      if (!client) { return { ok: false, error: 'Not connected to Tower.' }; }
      return client.activateWorkspace(workspacePath);
    },
    isAdopted: (workspacePath) => fs.existsSync(path.join(workspacePath, 'codev')),
    confirmAdopt: async (target) => {
      const choice = await vscode.window.showWarningMessage(
        `Activate “${target.name}”?`,
        {
          modal: true,
          detail: `This folder isn’t a Codev project yet. Activating it will run “codev adopt” and write Codev files into ${target.path}.`,
        },
        'Activate & adopt',
      );
      return choice === 'Activate & adopt';
    },
    notify: (message) => { void vscode.window.showInformationMessage(message); },
    notifyError: (message) => { void vscode.window.showErrorMessage(message); },
    refresh: () => cache.refresh(),
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_WORKSPACE_COMMAND, (target: WorkspaceTarget) => openOrActivateWorkspace(deps, target)),
    vscode.commands.registerCommand('codev.switchWorkspace', async () => {
      const picks = buildWorkspacePicks(cache.getFleet(), connectionManager.getWorkspacePath());
      if (picks.length === 0) {
        deps.notify('No Codev workspaces are registered with Tower.');
        return;
      }
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Switch workspace — needs-attention first' });
      if (chosen) { await openOrActivateWorkspace(deps, chosen.target); }
    }),
    vscode.commands.registerCommand('codev.tower.deactivateWorkspace', async (target: WorkspaceTarget) => {
      const choice = await vscode.window.showWarningMessage(
        `Deactivate “${target.name}”? This stops its architect and any running terminals.`,
        { modal: true },
        'Deactivate',
      );
      if (choice !== 'Deactivate') { return; }
      const client = connectionManager.getClient();
      if (!client) { deps.notifyError('Not connected to Tower.'); return; }
      const result = await client.deactivateWorkspace(target.path);
      if (!result.ok) { deps.notifyError(`Couldn't deactivate ${target.name}: ${result.error ?? 'unknown error'}`); return; }
      await cache.refresh();
    }),
  );
}
