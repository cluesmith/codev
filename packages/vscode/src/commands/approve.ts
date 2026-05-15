import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const execFileAsync = promisify(execFile);

/**
 * Per-gate side-button mapping for the approval-confirmation dialog.
 *
 * Lets the reviewer pop open the natural artifact for one final look
 * before committing to approval — without first dismissing the dialog
 * and re-triggering the command.
 *
 * Mirrors `gate-toast.ts`'s GATE_ACTIONS one-for-one so a given gate
 * surfaces the same inspection action from either entry point. The maps
 * are kept in separate files because the two surfaces have different
 * ergonomics (toast at gate-pending fires once; this confirmation fires
 * every approval click), but their *contents* must stay in sync.
 */
const GATE_SIDE_ACTIONS: Record<string, { label: string; command: string }> = {
  'plan-approval': { label: 'View Plan', command: 'codev.viewPlanFile' },
  'dev-approval':  { label: 'Run Dev',   command: 'codev.runWorktreeDev' },
};

export interface ApproveGateOptions {
  /**
   * When true, skip the confirmation dialog and approve directly. Used
   * by the gate-pending toast (gate-toast.ts), which is itself the
   * context — surfacing a second confirmation would be redundant.
   */
  skipConfirmation?: boolean;
}

/**
 * Codev: Approve Gate.
 *
 * Three invocation paths:
 *
 *   1. Right-click a blocked-builder row → pass the builder ID directly.
 *      Skips the quick-pick; auto-detects the gate from b.blockedGate.
 *      Shows the rich confirmation dialog.
 *
 *   2. Command palette / Cmd+K G → no builder ID → show quick-pick of all
 *      blocked builders. Then the rich confirmation dialog.
 *
 *   3. Gate-pending toast's [Approve] button → builder ID + options
 *      { skipConfirmation: true }. The toast was the context; approving
 *      from there commits directly with no second confirmation.
 *
 * After `porch approve` succeeds, refresh the OverviewCache so the
 * sidebar updates immediately rather than waiting for the SSE round-trip
 * triggered by porch's overview-refresh broadcast.
 */
export async function approveGate(
  connectionManager: ConnectionManager,
  cache?: OverviewCache,
  builderIdArg?: string,
  options?: ApproveGateOptions,
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
  // names; the display label is for the human-facing prompts.
  let builder: typeof blocked[number] | undefined;
  let gate: string;
  if (builderIdArg) {
    builder = blocked.find(b => b.id === builderIdArg);
    if (!builder || !builder.blockedGate) {
      vscode.window.showWarningMessage(`Codev: Builder ${builderIdArg} is not blocked at a gate`);
      return;
    }
    gate = builder.blockedGate;
  } else {
    const candidates = blocked.filter(b => b.blockedGate);
    const picked = await vscode.window.showQuickPick(
      candidates.map(b => ({
        label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
        description: `blocked on ${b.blocked}`,
        builder: b,
        gate: b.blockedGate!,
      })),
      { placeHolder: 'Select gate to approve' },
    );
    if (!picked) { return; }
    builder = picked.builder;
    gate = picked.gate;
  }

  const id = builder.id;
  const issueRef = builder.issueId ? `#${builder.issueId}` : id;
  const titlePart = builder.issueTitle ? ` — ${truncate(builder.issueTitle, 60)}` : '';
  // Display label e.g. "plan review" from overview; falls back to the
  // canonical gate name if the display label isn't set.
  const gateLabel = builder.blocked ?? gate;

  // Fast path: caller already has context (gate-pending toast). Skip the
  // confirmation dialog and go straight to porch approve.
  if (options?.skipConfirmation) {
    await runPorchApprove(workspacePath, id, gate, gateLabel, issueRef);
    cache?.refresh();
    return;
  }

  // Rich confirmation: modal (centered, blocking) keeps the dialog close
  // to where the user just clicked — the ✓ icon in the left sidebar or
  // Cmd+K G near the editor — instead of a bottom-right toast that
  // forces a diagonal cursor traversal. Approval is a deliberate,
  // once-per-gate action; the modal interrupt is appropriate.
  const sideAction = GATE_SIDE_ACTIONS[gate];
  const buttons = sideAction ? [sideAction.label, 'Approve'] : ['Approve'];

  const selection = await vscode.window.showInformationMessage(
    `Approve ${gateLabel} for ${issueRef}${titlePart}?`,
    { modal: true },
    ...buttons,
  );

  if (!selection) { return; }

  if (selection === 'Approve') {
    await runPorchApprove(workspacePath, id, gate, gateLabel, issueRef);
    cache?.refresh();
    return;
  }

  // Side-button clicked. Invoke the corresponding command with the
  // builder ID; the user can re-trigger Approve afterward.
  if (sideAction && selection === sideAction.label) {
    await vscode.commands.executeCommand(sideAction.command, id);
  }
}

async function runPorchApprove(
  workspacePath: string,
  id: string,
  gate: string,
  gateLabel: string,
  issueRef: string,
): Promise<void> {
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
  vscode.window.showInformationMessage(`Codev: Approved ${gateLabel} for ${issueRef}`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
