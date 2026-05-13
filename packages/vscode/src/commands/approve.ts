import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const execFileAsync = promisify(execFile);

/**
 * Codev: Approve Gate — show blocked builders, pick one, approve via porch CLI.
 *
 * After `porch approve` succeeds, refresh the OverviewCache so the Needs
 * Attention tree drops the just-approved builder immediately rather than
 * waiting for the next SSE-driven tick. (The builder wake-up itself is
 * fired by porch's notifyTerminal — see packages/codev/src/commands/porch/
 * notify.ts.)
 */
export async function approveGate(
  connectionManager: ConnectionManager,
  cache?: OverviewCache,
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

  const picked = await vscode.window.showQuickPick(
    blocked.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      description: `blocked on ${b.blocked}`,
      id: b.id,
      gate: b.blocked!,
    })),
    { placeHolder: 'Select gate to approve' },
  );
  if (!picked) { return; }

  try {
    await execFileAsync('porch', [
      'approve',
      picked.id,
      picked.gate,
      '--a-human-explicitly-approved-this',
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Codev: porch approve failed — ${msg}`);
    return;
  }

  vscode.window.showInformationMessage(`Codev: Approved ${picked.gate} for #${picked.id}`);

  // Refresh the cache so Needs Attention updates without waiting for SSE.
  cache?.refresh();
}
