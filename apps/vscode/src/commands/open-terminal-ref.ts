/**
 * Codev: resolve a `#N` / `PR #N` reference clicked in a terminal (#1412) and
 * open it in the right surface. This is the resolution half of the terminal
 * link feature; the detection half is `IssueRefTerminalLinkProvider` in
 * `terminal-link-provider.ts`.
 *
 * Latency + feedback (#1412 dev-approval): a terminal-link click gets no
 * built-in VSCode feedback, so the whole resolution runs inside a status-bar
 * `withProgress` — the user sees "Opening #N…" the instant they click, even
 * while the forge fetch is in flight. And a bare `#N` fetches the forge exactly
 * once: that single `getIssue` both discriminates issue-vs-PR AND yields the
 * canonical `url`, which we then open directly rather than making a reuse
 * helper re-fetch it. Only the in-editor issue preview fetches a second time,
 * because that fetch renders the content the user is about to read.
 *
 * The discriminator is the resolved `url`, not fetch-failure. GitHub's
 * `gh issue view` (the `issue-view` forge concept) resolves a PR *number*
 * successfully — issues and PRs share one number space — returning a
 * `.../pull/N` url. A genuine issue returns `.../issues/N`. So a bare `#N`
 * whose `getIssue` url is a `/pull/` url is actually a PR and opens the PR page,
 * exactly as the decided design intends.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import { openPRInBrowser } from './open-pr-by-id.js';

/** A `#N` or `PR #N` reference detected in a terminal line. */
export interface TerminalRef {
  /** Bare numeric id, e.g. `"1402"`. */
  number: string;
  /** True when the reference carried an explicit `PR ` prefix. */
  isPR: boolean;
}

/**
 * Open the surface for a clicked terminal reference, with a status-bar spinner
 * for the duration.
 *
 * - `PR #N` → the PR's forge page in the browser (no in-editor PR preview exists).
 * - bare `#N` → the in-editor issue viewer by default, or the browser when
 *   `codev.terminalLinks.issueTarget` is `browser`; but if the number resolves
 *   to a PR, the browser PR page regardless of the setting.
 * - unresolvable number → warning toast (matches `openIssueInBrowser`'s grammar).
 */
export function openTerminalRef(
  connectionManager: ConnectionManager,
  ref: TerminalRef,
): Thenable<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Codev: Opening #${ref.number}…` },
    () => resolveRef(connectionManager, ref),
  );
}

async function resolveRef(connectionManager: ConnectionManager, ref: TerminalRef): Promise<void> {
  if (ref.isPR) {
    await openPRInBrowser(connectionManager, ref.number);
    return;
  }

  // Bare `#N`: one fetch does double duty — discriminate issue vs PR by the
  // resolved url, and hand us that url to open. This guard mirrors the reuse
  // helpers so an unconnected click fails the same way.
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

  // The number is actually a PR — open the `/pull/` url we already hold.
  if (issue.url && /\/pull\/\d/.test(issue.url)) {
    await vscode.env.openExternal(vscode.Uri.parse(issue.url));
    return;
  }

  // Genuine issue. Browser target opens the resolved url directly (no re-fetch);
  // editor target — and any forge that supplied no url — renders the in-editor
  // preview, which fetches once to build its content.
  const target = vscode.workspace
    .getConfiguration('codev')
    .get<string>('terminalLinks.issueTarget', 'editor');
  if (target === 'browser' && issue.url) {
    await vscode.env.openExternal(vscode.Uri.parse(issue.url));
    return;
  }
  await vscode.commands.executeCommand('codev.viewBacklogIssue', ref.number);
}
