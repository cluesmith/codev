/**
 * Codev: resolve a `#N` / `PR #N` reference clicked in a terminal (#1412) and
 * open it in the right surface. This is the resolution half of the terminal
 * link feature; the detection half is `IssueRefTerminalLinkProvider` in
 * `terminal-link-provider.ts`.
 *
 * Reuse discipline (the core review axis): every *open* funnels through one of
 * the three existing sanctioned paths — `openPRInBrowser` (open-pr-by-id.ts),
 * `openIssueInBrowser` (open-issue-by-id.ts), and the `codev.viewBacklogIssue`
 * command (view-issue.ts). The command is invoked via `executeCommand` (not a
 * direct import) so this module carries no load-time dependency on view-issue's
 * singleton — the same indirection open-issue-by-id.ts uses for its fallback.
 * No new fetch code: the one `getIssue` call below is the same forge-agnostic
 * SDK method those helpers use, invoked solely as the issue-vs-PR discriminator.
 *
 * The discriminator is the resolved `url`, not fetch-failure. GitHub's
 * `gh issue view` (the `issue-view` forge concept) resolves a PR *number*
 * successfully — issues and PRs share one number space — returning a
 * `.../pull/N` url. A genuine issue returns `.../issues/N`. So a bare `#N`
 * whose `getIssue` url is a `/pull/` url is actually a PR and falls through to
 * the PR browser-open, exactly as the decided design intends.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import { openIssueInBrowser } from './open-issue-by-id.js';
import { openPRInBrowser } from './open-pr-by-id.js';

/** A `#N` or `PR #N` reference detected in a terminal line. */
export interface TerminalRef {
  /** Bare numeric id, e.g. `"1402"`. */
  number: string;
  /** True when the reference carried an explicit `PR ` prefix. */
  isPR: boolean;
}

/**
 * Open the surface for a clicked terminal reference.
 *
 * - `PR #N` → the PR's forge page in the browser (no in-editor PR preview exists).
 * - bare `#N` → the in-editor issue viewer by default, or the browser when
 *   `codev.terminalLinks.issueTarget` is `browser`; but if the number resolves
 *   to a PR, the browser PR page regardless of the setting.
 * - unresolvable number → warning toast (matches `openIssueInBrowser`'s grammar).
 */
export async function openTerminalRef(
  connectionManager: ConnectionManager,
  ref: TerminalRef,
): Promise<void> {
  if (ref.isPR) {
    await openPRInBrowser(connectionManager, ref.number);
    return;
  }

  // Bare `#N`: fetch once to discriminate issue vs PR by the resolved url. This
  // guard mirrors the reuse helpers so an unconnected click fails the same way.
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const issue = await client.getIssue(ref.number, workspacePath);
  if (!issue) {
    vscode.window.showWarningMessage(
      `Codev: Could not open #${ref.number} (not found, or forge unavailable).`,
    );
    return;
  }

  if (issue.url && /\/pull\/\d/.test(issue.url)) {
    // The number is actually a PR — funnel through the single PR-open path.
    await openPRInBrowser(connectionManager, ref.number);
    return;
  }

  // Genuine issue (or a forge that supplies no url — treat as an issue).
  const target = vscode.workspace
    .getConfiguration('codev')
    .get<string>('terminalLinks.issueTarget', 'editor');
  if (target === 'browser') {
    await openIssueInBrowser(connectionManager, ref.number);
    return;
  }
  await vscode.commands.executeCommand('codev.viewBacklogIssue', ref.number);
}
