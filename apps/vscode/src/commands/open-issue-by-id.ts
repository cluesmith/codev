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
 * `issueId` vocabulary. `parseIssueId` stays numeric (Open PR by ID shares it);
 * `parseIssueInput` adds tracker keys (`ENG-123`) on workspaces whose issues
 * use them (#1740), gated by `acceptsIssueKeys`.
 *
 * Graceful degradation: the issue is fetched via the same forge-agnostic
 * `getIssue` path the in-editor preview uses. When the forge supplies a `url`
 * (GitHub does), we open the browser; when it doesn't, we fall back to the
 * in-editor preview (`codev.viewBacklogIssue`) rather than failing.
 */

import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import { acceptsIssueKeys, isIssueKey } from '../issue-id.js';

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
 * Normalize a typed issue id: a number (as `parseIssueId`), or, when
 * `acceptKeys`, a tracker key canonicalized to upper case (`" eng-12 "` →
 * `"ENG-12"`, a leading `#` tolerated). `undefined` for anything else.
 */
export function parseIssueInput(input: string, acceptKeys: boolean): string | undefined {
  const numeric = parseIssueId(input);
  if (numeric !== undefined) { return numeric; }
  if (!acceptKeys) { return undefined; }
  const trimmed = input.trim();
  let withoutHash = trimmed;
  if (trimmed.startsWith('#')) { withoutHash = trimmed.slice(1); }
  if (!isIssueKey(withoutHash)) { return undefined; }
  return withoutHash.toUpperCase();
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
      `Codev: Could not open issue ${issueLabel(issueId)} (not found, or forge unavailable).`,
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

/** `#42` for numbers, `ENG-12` for keys (no `#` on a tracker key). */
function issueLabel(issueId: string): string {
  if (isIssueKey(issueId)) { return issueId; }
  return `#${issueId}`;
}

export async function openIssueById(
  connectionManager: ConnectionManager,
  getOverview?: () => Pick<OverviewData, 'issueIdKind' | 'backlog'> | null | undefined,
): Promise<void> {
  const acceptKeys = acceptsIssueKeys(getOverview?.(), 'explicit');
  let placeHolder = 'Issue ID, e.g. 1096 or #1096';
  let invalidMessage = 'Enter a numeric issue id (e.g. 1096 or #1096).';
  if (acceptKeys) {
    placeHolder = 'Issue ID, e.g. 1096 or PROJ-123';
    invalidMessage = 'Enter an issue id (e.g. 1096 or PROJ-123).';
  }
  const input = await vscode.window.showInputBox({
    title: 'Codev: Open Issue by ID',
    placeHolder,
    prompt: 'Opens the issue in your browser — works for open, closed, or archived issues.',
    validateInput: (value) => {
      if (parseIssueInput(value, acceptKeys) === undefined) { return invalidMessage; }
      return undefined;
    },
  });
  if (input === undefined) { return; }

  const issueId = parseIssueInput(input, acceptKeys);
  if (issueId === undefined) { return; }

  await openIssueInBrowser(connectionManager, issueId);
}
