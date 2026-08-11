/**
 * Codev: Open PR by ID — open a specific pull request by typing its id,
 * mirroring `open-issue-by-id.ts` (issue #1179).
 *
 * Bound to `Cmd+K Shift+P` / `Ctrl+K Shift+P`, completing the keyboard family
 * alongside `Cmd+K I` (issue). The unshifted `Cmd+K P` chord is a VS Code
 * built-in (Copy Path of Active File), so the shifted variant keeps the
 * P-for-PR mnemonic without shadowing it (issue #1179 pr-gate decision).
 * Fetches via the SDK's forge-agnostic `getPR` (Tower's
 * GET /api/pr → the `pr-view` forge concept) and opens the PR's canonical
 * forge page in the external browser.
 *
 * Unlike issues, there is no in-editor PR preview to degrade to (no
 * `codev.viewBacklogPR`), so a PR that resolves without a `url` warns
 * instead — same message as not-found, since either way the browser page
 * can't be opened.
 *
 * Reuses `parseIssueId` for input validation: its docstring already declares
 * it forge-neutral id normalization, and PR ids share the same `#`-tolerant
 * numeric grammar.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import { parseIssueId } from './open-issue-by-id.js';

/**
 * Fetch `prId` and open its forge page in the external browser. Exported on
 * its own (like `openIssueInBrowser`) so the backlog QuickPick's dynamic
 * `View PR #N` items share the exact same path as the keybound command.
 */
export async function openPRInBrowser(
  connectionManager: ConnectionManager,
  prId: string,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const pr = await client.getPR(prId, workspacePath);
  if (!pr || !pr.url) {
    vscode.window.showWarningMessage(
      `Codev: Could not open PR #${prId} (not found, or forge unavailable).`,
    );
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(pr.url));
}

export async function openPRById(connectionManager: ConnectionManager): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Codev: Open PR by ID',
    placeHolder: 'PR ID, e.g. 1398 or #1398',
    prompt: 'Opens the pull request in your browser — works for open, closed, or merged PRs.',
    validateInput: (value) =>
      parseIssueId(value) === undefined
        ? 'Enter a numeric PR id (e.g. 1398 or #1398).'
        : undefined,
  });
  if (input === undefined) { return; }

  const prId = parseIssueId(input);
  if (prId === undefined) { return; }

  await openPRInBrowser(connectionManager, prId);
}
