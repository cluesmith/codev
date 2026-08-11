/**
 * Codev: Open Issue by ID — open a specific issue by typing its id, without
 * first finding it in the backlog Quick Pick.
 *
 * Bound to `Cmd+K I` / `Ctrl+K I`. This is the *browser* counterpart to the
 * backlog/`View Issue` family: where those render a read-only preview inside
 * VSCode, "Open Issue by ID" opens the issue's canonical forge page in the
 * external browser. That split is the command's reason to exist — direct,
 * keyboard-driven access to any issue (open, closed, archived, or one already
 * claimed by a builder and therefore filtered out of the backlog), fetched live
 * by id rather than picked from the loaded backlog set.
 *
 * "ID" rather than "number": the term is forge-neutral (GitLab `iid`, Linear /
 * Jira identifiers aren't bare numbers), matching the extension's existing
 * `issueId` vocabulary. The numeric validation in `parseIssueId` is the
 * GitHub-specific part; only it loosens if a non-numeric forge is supported.
 *
 * Graceful degradation: the issue is fetched via the same forge-agnostic
 * `getIssue` path the in-editor preview uses. When the forge supplies a `url`
 * (GitHub does), we open the browser; when it doesn't, we fall back to the
 * in-editor preview (`codev.viewBacklogIssue`) rather than failing.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Normalize a typed issue id to its bare numeric string, or `undefined` if it
 * isn't a valid issue id. Accepts a single optional leading `#` and surrounding
 * whitespace (`" #1096 "` → `"1096"`); rejects empty, non-numeric, and
 * malformed input (`""`, `"abc"`, `"12a3"`, `"#"`, `"##12"`).
 *
 * Pure (no `vscode` dependency) so it is unit-testable in isolation and reusable
 * as the `showInputBox` validator.
 */
export function parseIssueId(input: string): string | undefined {
  const trimmed = input.trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (withoutHash.length === 0) { return undefined; }
  if (!/^\d+$/.test(withoutHash)) { return undefined; }
  return withoutHash;
}

/**
 * Fetch `issueId` and open its forge page in the external browser. The
 * post-InputBox body of `openIssueById`, exported on its own so the backlog
 * QuickPick's dynamic `View Issue #N` items (issue #1179) share the exact
 * same fetch → browser → preview-fallback path.
 */
export async function openIssueInBrowser(
  connectionManager: ConnectionManager,
  issueId: string,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const issue = await client.getIssue(issueId, workspacePath);
  if (!issue) {
    vscode.window.showWarningMessage(
      `Codev: Could not open issue #${issueId} (not found, or forge unavailable).`,
    );
    return;
  }

  if (issue.url) {
    await vscode.env.openExternal(vscode.Uri.parse(issue.url));
    return;
  }

  // Forge supplied no URL — degrade to the in-editor preview rather than fail.
  await vscode.commands.executeCommand('codev.viewBacklogIssue', issueId);
}

export async function openIssueById(connectionManager: ConnectionManager): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Codev: Open Issue by ID',
    placeHolder: 'Issue ID, e.g. 1096 or #1096',
    prompt: 'Opens the issue in your browser — works for open, closed, or archived issues.',
    validateInput: (value) =>
      parseIssueId(value) === undefined
        ? 'Enter a numeric issue id (e.g. 1096 or #1096).'
        : undefined,
  });
  if (input === undefined) { return; }

  const issueId = parseIssueId(input);
  if (issueId === undefined) { return; }

  await openIssueInBrowser(connectionManager, issueId);
}
