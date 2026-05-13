import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const execFileAsync = promisify(execFile);

/**
 * Codev: Approve Gate.
 *
 * Two invocation paths:
 *
 *   1. Right-click a blocked-builder row → pass the builder ID directly.
 *      Skips the quick-pick; auto-detects the gate from b.blocked.
 *
 *   2. Command palette / Cmd+K G → no builder ID → show quick-pick of all
 *      blocked builders.
 *
 * After `porch approve` succeeds, refresh the OverviewCache so the
 * sidebar updates immediately rather than waiting for the SSE round-trip
 * triggered by porch's overview-refresh broadcast.
 */
export async function approveGate(
  connectionManager: ConnectionManager,
  cache?: OverviewCache,
  builderIdArg?: string,
): Promise<void> {
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

  // We need blockedGate (canonical name like "plan-approval"), not blocked
  // (display label like "plan review"). Porch's gate keys are the canonical
  // names; the display label is for the sidebar only.
  let id: string;
  let gate: string;
  if (builderIdArg) {
    const direct = blocked.find(b => b.id === builderIdArg);
    if (!direct || !direct.blockedGate) {
      vscode.window.showWarningMessage(`Codev: Builder ${builderIdArg} is not blocked at a gate`);
      return;
    }
    id = direct.id;
    gate = direct.blockedGate;
  } else {
    const candidates = blocked.filter(b => b.blockedGate);
    const picked = await vscode.window.showQuickPick(
      candidates.map(b => ({
        label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
        description: `blocked on ${b.blocked}`,
        id: b.id,
        gate: b.blockedGate!,
      })),
      { placeHolder: 'Select gate to approve' },
    );
    if (!picked) { return; }
    id = picked.id;
    gate = picked.gate;
  }

  const confirmed = await vscode.window.showInformationMessage(
    `Approve ${gate} for ${id}?`,
    { modal: true },
    'Approve',
  );
  if (confirmed !== 'Approve') { return; }

  try {
    await execFileAsync('porch', [
      'approve',
      id,
      gate,
      '--a-human-explicitly-approved-this',
    ], { cwd: workspacePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Codev: porch approve failed — ${msg}`);
    return;
  }

  vscode.window.showInformationMessage(`Codev: Approved ${gate} for ${id}`);

  // Refresh the cache so the Builders tree updates without waiting for SSE.
  cache?.refresh();
}
