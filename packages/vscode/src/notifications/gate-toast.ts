import * as vscode from 'vscode';
import type { OverviewCache } from '../views/overview-data.js';

/**
 * Toast notifications for newly blocked builders.
 *
 * Subscribes to OverviewCache changes. Whenever a builder appears in the
 * blocked-set for the first time (or its gate name changes), fires an
 * `showInformationMessage` toast with a single "Review" action that opens
 * the **architect** terminal — porch orchestrates through the architect,
 * so user-driven review starts there.
 *
 * (Direct artifact access — View Diff, View Plan File, View Review File,
 * Run Dev Server — is available via right-click on builder rows in the
 * sidebar. The toast intentionally does not duplicate those entry points.)
 *
 * A `(builderId, gateName)` seen-set is kept in module state so we never
 * re-toast the same blocked state on subsequent cache ticks. The seen-set
 * is pruned when an entry leaves the blocked set (gate approved or builder
 * advances) so that re-blocking later (on a different gate) will re-toast.
 *
 * Respects the `codev.gateToasts.enabled` setting (default: true). Set to
 * false to silence; status bar counters and the Needs Attention tree
 * remain unaffected.
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

function showGateToast(
  builderId: string,
  gateName: string,
  issueId?: string | number | null,
  issueTitle?: string | null,
): void {
  const label = issueId ? `#${issueId}` : builderId;
  const titleSuffix = issueTitle ? ` — ${truncate(issueTitle, 50)}` : '';
  const message = `Codev: ${label} blocked on ${gateName}${titleSuffix}`;

  // Fire and forget. "Review" opens the architect terminal so the user can
  // talk about the gate from there if they want; the architect itself is
  // not pre-notified about gate state.
  vscode.window
    .showInformationMessage(message, 'Review')
    .then((selection) => {
      if (selection === 'Review') {
        vscode.commands.executeCommand('codev.openArchitectTerminal');
      }
    });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
