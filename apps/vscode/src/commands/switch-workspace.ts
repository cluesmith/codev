import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';
import type { FleetEntry, TowerFleetCache } from '../views/tower-cache.js';
import { OPEN_WORKSPACE_COMMAND, toWorkspaceTarget } from '../views/tower.js';
import type { WorkspaceTarget } from '../views/tower.js';
import { orderFleet } from '../views/fleet-order.js';
import { describeAttention } from '../views/attention-format.js';

/** The existing inbound command that re-validates a path and opens/focuses its window. */
const FOCUS_WORKSPACE_COMMAND = 'codev.focusWorkspaceWindow';

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
    // Opening the window we're already in would just re-focus it — skip the round-trip.
    if (target.isCurrent) { return; }
    // If the row's `active` is stale (another window deactivated it within the poll window),
    // opening the folder still self-heals: the opened window's ConnectionManager.connect()
    // re-activates its own workspace idempotently. So no pre-activation is needed here.
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
  // Anchored to the real 429 body ("Too many activations, try again later") — a bare "rate"
  // would match ordinary words (sepaRATE, migRATE).
  if (error && /too many|\b429\b/i.test(error)) {
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
  const { active, dormant } = orderFleet(fleet, currentPath);

  const items: WorkspacePickItem[] = [];
  for (const ws of active) {
    const glance = describeAttention(ws.entry.attention);
    const descriptionParts: string[] = [];
    if (ws.isCurrent) { descriptionParts.push('current'); }
    if (glance) { descriptionParts.push(glance.text); }
    items.push({
      label: ws.label,
      description: descriptionParts.join(' · '),
      target: { path: ws.entry.workspace.path, active: true, name: ws.label, isCurrent: ws.isCurrent },
    });
  }
  if (dormant.length > 0) {
    items.push({ label: 'Dormant', kind: vscode.QuickPickItemKind.Separator, target: { path: '', active: false, name: '', isCurrent: false } });
    for (const ws of dormant) {
      items.push({
        label: ws.label,
        description: 'activate',
        target: { path: ws.entry.workspace.path, active: false, name: ws.label, isCurrent: false },
      });
    }
  }
  return items;
}

/** A command registrar (extension.ts's `regCli`) that adds the CLI-preflight guard (#791). */
export interface CommandRegistrar {
  <A extends unknown[]>(id: string, handler: (...args: A) => unknown): vscode.Disposable;
}

/**
 * Register the Tower action commands: the row-click open/activate, the keyboard-first
 * `codev.switchWorkspace` quick-pick, and the row-context deactivate. Thin glue — it builds the
 * real `WorkspaceActionDeps` and delegates the logic to the tested functions above. Registration
 * goes through the injected `regCli` so Tower commands get the CLI-preflight guard like every other
 * Tower-dependent command.
 */
export function registerTowerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  cache: TowerFleetCache,
  regCli: CommandRegistrar,
): void {
  const deps: WorkspaceActionDeps = {
    runCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    activate: async (workspacePath) => {
      const client = connectionManager.getClient();
      if (!client) { return { ok: false, error: 'Not connected to Tower.' }; }
      return client.activateWorkspace(workspacePath);
    },
    // Mirrors Tower's own adopt trigger (`launchInstance` adopts iff there's no `codev/` dir). It's
    // a best-effort client-side check to confirm BEFORE the server writes: a tiny TOCTOU window and
    // the coupling to the server's condition are the residual. Robustly closing it needs a server
    // "will adopt?"/confirm flag — a Tower + SDK change, out of scope here (routes to codev:main).
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
    notify: (message) => { vscode.window.showInformationMessage(message); },
    notifyError: (message) => { vscode.window.showErrorMessage(message); },
    refresh: () => cache.refresh(),
  };

  context.subscriptions.push(
    // Invoked with a WorkspaceTarget (a row's command) or the tree node (an inline button) —
    // `toWorkspaceTarget` normalizes both.
    regCli(OPEN_WORKSPACE_COMMAND, (arg: unknown) => {
      const target = toWorkspaceTarget(arg);
      if (target) { return openOrActivateWorkspace(deps, target); }
      return undefined;
    }),
    regCli('codev.switchWorkspace', async () => {
      const picks = buildWorkspacePicks(cache.getFleet(), connectionManager.getWorkspacePath());
      if (picks.length === 0) {
        deps.notify('No Codev workspaces are registered with Tower.');
        return;
      }
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Switch workspace — needs-attention first' });
      if (chosen) { await openOrActivateWorkspace(deps, chosen.target); }
    }),
    // Invoked from the row's inline button, so the argument is the tree node — normalize it.
    regCli('codev.tower.deactivateWorkspace', async (arg: unknown) => {
      const target = toWorkspaceTarget(arg);
      if (!target) { return; }
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
