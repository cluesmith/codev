/**
 * Codev: View Issue — read the body + comments of a backlog issue inside
 * VSCode instead of opening a browser.
 *
 * Right-click a backlog row → "View Issue". Fetches via Tower's
 * forge-backed GET /api/issue (so it stays forge-agnostic and
 * tunnel-safe — the extension never shells out to `gh`), renders the
 * issue as markdown behind a read-only `codev-issue:` document, and
 * opens VSCode's built-in markdown preview.
 *
 * A TextDocumentContentProvider scheme is read-only by construction, so
 * there's no editable scratch buffer left behind (unlike opening an
 * untitled document).
 *
 * Refresh model: each `set` updates the cached markdown and fires
 * `onDidChange`, so re-click refreshes immediately. For passive updates
 * while a preview is open, activate subscribes to `OverviewCache.onDidChange`
 * (the existing sidebar-poll + SSE heartbeat) and re-fetches every issue
 * still in the cache. The cache is bounded *exactly* by what's open:
 * `onDidCloseTextDocument` drops entries when their preview tab is
 * closed and VSCode unloads the underlying TextDocument. A leading-edge
 * 30s throttle absorbs SSE bursts; the dedup'ing `set` absorbs no-op
 * refetches.
 */

import * as vscode from 'vscode';
import type { IssueView } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const SCHEME = 'codev-issue';
const REFRESH_THROTTLE_MS = 30_000;

class IssueContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * Stash rendered markdown for `issueId`. Returns true iff the content
   * actually changed (dedup) — `onDidChange` only fires on real changes
   * so identical refetches don't churn the preview.
   */
  set(issueId: string, markdown: string): boolean {
    if (this.contents.get(issueId) === markdown) { return false; }
    this.contents.set(issueId, markdown);
    this._onDidChange.fire(vscode.Uri.parse(`${SCHEME}:${issueId}.md`));
    return true;
  }

  /** Drop a cached entry — called when its preview's TextDocument closes. */
  forget(issueId: string): void {
    this.contents.delete(issueId);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    // URI form: codev-issue:<id>.md  → authority/path is `<id>.md`
    const issueId = uri.path.replace(/\.md$/, '');
    return this.contents.get(issueId) ?? `# Issue #${issueId}\n\n_Content unavailable._`;
  }

  /** Issue ids whose previews are currently open. */
  knownIssueIds(): string[] {
    return [...this.contents.keys()];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

const provider = new IssueContentProvider();

function issueIdFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== SCHEME) { return undefined; }
  return uri.path.replace(/\.md$/, '');
}

function renderIssue(issueId: string, issue: IssueView): string {
  const lines: string[] = [
    `# #${issueId} ${issue.title}`,
    '',
    `**State:** ${issue.state}`,
    '',
    issue.body?.trim() ? issue.body : '_No description._',
  ];

  if (issue.comments.length > 0) {
    lines.push('', '---', '', `## Comments (${issue.comments.length})`, '');
    for (const c of issue.comments) {
      lines.push(`### @${c.author.login} — ${c.createdAt}`, '', c.body, '');
    }
  }

  return lines.join('\n');
}

export function activateIssueView(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  overviewCache: OverviewCache,
): void {
  // Re-fetch every open preview on each heartbeat from overviewCache —
  // that emitter already coalesces the 60s sidebar poll with Tower's SSE
  // events. SSE bursts (frequent during builder activity) are absorbed
  // by the leading-edge throttle.
  let lastRefreshAt = 0;
  const refreshTracked = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_THROTTLE_MS) { return; }
    lastRefreshAt = now;
    const client = connectionManager.getClient();
    const workspacePath = connectionManager.getWorkspacePath();
    if (!client || !workspacePath || connectionManager.getState() !== 'connected') { return; }
    for (const issueId of provider.knownIssueIds()) {
      try {
        const issue = await client.getIssue(issueId, workspacePath);
        if (issue) { provider.set(issueId, renderIssue(issueId, issue)); }
      } catch {
        // Benign — keep the last good content; next tick may succeed.
      }
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    // Drop cache entries when the markdown preview tab closes (and VSCode
    // therefore unloads the underlying codev-issue: TextDocument). Keeps
    // the cache shaped to exactly what's currently visible — refresh loop
    // never iterates closed previews.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const issueId = issueIdFromUri(doc.uri);
      if (issueId) { provider.forget(issueId); }
    }),
    overviewCache.onDidChange(refreshTracked),
    { dispose: () => provider.dispose() },
  );
}

export async function viewBacklogIssue(
  connectionManager: ConnectionManager,
  issueId: string | undefined,
): Promise<void> {
  if (!issueId) { return; }

  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const issue = await client.getIssue(issueId, workspacePath);
  if (!issue) {
    vscode.window.showWarningMessage(
      `Codev: Could not load issue #${issueId} (forge unavailable?)`,
    );
    return;
  }

  provider.set(issueId, renderIssue(issueId, issue));
  const uri = vscode.Uri.parse(`${SCHEME}:${issueId}.md`);
  // Render as a read-only markdown preview in editor group 2 — the same
  // placement model as builder terminals (which target ViewColumn.Two).
  //
  // `markdown.showPreviewToSide` opens in ViewColumn.Beside, which is
  // RELATIVE to the active editor group, not an absolute column. Without
  // anchoring, the first click (sidebar focused → group 1 active) lands
  // in group 2, but a second click while that preview is focused makes
  // "Beside" resolve to group 3, then 4, … — a brand-new group per click.
  // Focusing group 1 first pins "Beside" to group 2 every time, so issue
  // previews consistently reuse a single group like the builder terminals.
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}
