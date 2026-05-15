import * as vscode from 'vscode';
import type { OverviewCache } from '../views/overview-data.js';

/**
 * Toast notifications for newly blocked builders.
 *
 * Subscribes to OverviewCache changes. Whenever a builder appears in the
 * blocked-set for the first time (or its gate name changes), fires an
 * `showInformationMessage` toast with two action buttons:
 *
 *   1. A per-gate "inspection" button from `GATE_ACTIONS`:
 *        plan-approval → "View Plan" — opens codev/plans/<id>-*.md
 *        dev-approval  → "Run Dev"   — starts the worktree's dev PTY
 *        other gates   → "Review"    — opens the builder's terminal pane
 *   2. "Approve" — commits to porch approve directly via
 *      `codev.approveGate` with `{ skipConfirmation: true }`. The toast
 *      is the context; surfacing a second confirmation here would be
 *      friction without value.
 *
 * A `(builderId, gateName)` seen-set is kept in module state so we never
 * re-toast the same blocked state on subsequent cache ticks. The seen-set
 * is pruned when an entry leaves the blocked set (gate approved or builder
 * advances) so that re-blocking later (on a different gate) will re-toast.
 *
 * Respects the `codev.gateToasts.enabled` setting (default: true). Set to
 * false to silence; status bar counters and the Builders tree remain
 * unaffected.
 */
export function activateGateToasts(
  context: vscode.ExtensionContext,
  cache: OverviewCache,
): void {
  // Track (builderId, gateName) pairs we've already toasted for.
  const seen = new Set<string>();

  const onChange = () => {
    const enabled = vscode.workspace
      .getConfiguration('codev')
      .get<boolean>('gateToasts.enabled', true);
    if (!enabled) {
      return;
    }

    const data = cache.getData();
    if (!data) {
      return;
    }

    const currentBlocked = new Set<string>();
    for (const b of data.builders) {
      if (!b.blocked) {
        continue;
      }
      const key = `${b.id}::${b.blocked}`;
      currentBlocked.add(key);
      if (!seen.has(key)) {
        seen.add(key);
        showGateToast(b.id, b.blocked, b.issueId, b.issueTitle);
      }
    }

    // Prune entries that are no longer blocked so we re-toast on future blocks.
    for (const key of [...seen]) {
      if (!currentBlocked.has(key)) {
        seen.delete(key);
      }
    }
  };

  context.subscriptions.push(cache.onDidChange(onChange));
}

/**
 * Per-gate action mapping for the toast's single button.
 *
 *   plan-approval → "View Plan" opens the plan markdown directly
 *   dev-approval  → "Run Dev"   starts the dev PTY for the worktree
 *   other gates   → "Review"    opens the builder's terminal pane
 *
 * The plan/dev mappings match the gate's most-useful artifact (plan-approval
 * reviews the plan file; dev-approval tests the running code). Anything
 * else falls back to the builder pane — gates without a single obvious
 * artifact (spec-approval, code-review, pr) are best handled by typing
 * feedback to the interactive Claude that just announced the gate.
 */
const GATE_ACTIONS: Record<string, { label: string; command: string }> = {
  'plan-approval': { label: 'View Plan', command: 'codev.viewPlanFile' },
  'dev-approval':  { label: 'Run Dev',   command: 'codev.runWorktreeDev' },
};

function showGateToast(
  builderId: string,
  gateName: string,
  issueId?: string | number | null,
  issueTitle?: string | null,
): void {
  const label = issueId ? `#${issueId}` : builderId;
  const titleSuffix = issueTitle ? ` — ${truncate(issueTitle, 50)}` : '';
  const message = `Codev: ${label} blocked on ${gateName}${titleSuffix}`;

  const action = GATE_ACTIONS[gateName] ?? { label: 'Review', command: 'codev.openBuilderById' };

  // Two-button toast: [<artifact-specific action>] [Approve].
  // The toast itself is the context — clicking Approve here skips the
  // rich confirmation dialog (approve.ts's normal path). The reviewer
  // chose to act on the toast directly; surfacing a second confirmation
  // would be friction without value.
  vscode.window
    .showInformationMessage(message, action.label, 'Approve')
    .then((selection) => {
      if (selection === action.label) {
        vscode.commands.executeCommand(action.command, builderId);
      } else if (selection === 'Approve') {
        vscode.commands.executeCommand('codev.approveGate', builderId, { skipConfirmation: true });
      }
    });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
