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

/**
 * Ids of every currently-open codev-issue preview document. This is the
 * authoritative "what's on screen" set — including a preview tab VSCode restored
 * on launch, which has an open document but (until fetched) no cache entry. The
 * refresh loop iterates these so a restored tab gets filled once Tower connects,
 * rather than staying stuck on the "Content unavailable" fallback.
 */
export function openIssueDocIds(): string[] {
  const ids: string[] = [];
  for (const doc of vscode.workspace.textDocuments) {
    const id = issueIdFromUri(doc.uri);
    if (id) { ids.push(id); }
  }
  return ids;
}

/**
 * Pick the editor group for the issue preview with the same count-then-pick
 * model the builder/shell terminals use (#804, terminal-manager.ts): target
 * group 2 when a second group already exists, else group 1. Reading layout
 * state directly is what makes the placement deterministic — no focus
 * side-effect, no dependence on `Beside`'s active-group-relative semantics.
 */
export function pickIssuePreviewColumn(groupCount: number): vscode.ViewColumn {
  if (groupCount >= 2) {
    return vscode.ViewColumn.Two;
  }
  return vscode.ViewColumn.One;
}

/**
 * Render an ISO 8601 timestamp as its `YYYY-MM-DD` date prefix (no locale
 * dependency, matching the terse style already used for comment headers).
 * Falls back to the raw string when it isn't in the expected form.
 */
function formatIssueDate(iso: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(iso);
  if (match) { return match[0]; }
  return iso;
}

/**
 * The "opened by … on …" attribution line, collapsing author + creation date
 * onto one line. Returns just the present fragment when only one is available,
 * or undefined when the forge supplied neither (so the caller omits the line).
 */
function openedByLine(issue: IssueView): string | undefined {
  const login = issue.author?.login;
  let date: string | undefined;
  if (issue.createdAt) { date = formatIssueDate(issue.createdAt); }

  if (login && date) { return `**Opened by** @${login} on ${date}`; }
  if (login) { return `**Opened by** @${login}`; }
  if (date) { return `**Opened** ${date}`; }
  return undefined;
}

export function renderIssue(issueId: string, issue: IssueView): string {
  // The metadata block sits under the title. State and labels share the first
  // line (labels read as status chips alongside the state); the rest are their
  // own blank-separated paragraphs so each renders on its own line. Lines whose
  // data is absent are never pushed, and the count-sensitive labels use the
  // singular form when there is exactly one.
  let stateLine = `**State:** ${issue.state}`;
  if (issue.labels && issue.labels.length > 0) {
    const labelLabel = issue.labels.length === 1 ? 'Label' : 'Labels';
    stateLine += `  ·  **${labelLabel}:** ${issue.labels.map((l) => l.name).join(', ')}`;
  }
  const metaLines: string[] = [stateLine];

  const opened = openedByLine(issue);
  if (opened) { metaLines.push(opened); }

  if (issue.assignees && issue.assignees.length > 0) {
    const assigneeLabel = issue.assignees.length === 1 ? 'Assignee' : 'Assignees';
    metaLines.push(`**${assigneeLabel}:** ${issue.assignees.map((a) => `@${a.login}`).join(', ')}`);
  }
  if (issue.milestone?.title) {
    metaLines.push(`**Milestone:** ${issue.milestone.title}`);
  }

  const lines: string[] = [
    `# #${issueId} ${issue.title}`,
    '',
    metaLines.join('\n\n'),
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
  // Re-fetch open previews on each heartbeat from overviewCache — that emitter
  // already coalesces the 60s sidebar poll with Tower's SSE events. We iterate
  // the *currently open* codev-issue documents (not just entries already in the
  // cache), so a preview tab VSCode restored on launch — before Tower connected,
  // so it never got content and shows "Content unavailable" — is filled once the
  // connection is up instead of staying stuck. SSE bursts are absorbed by the
  // leading-edge throttle; the dedup'ing `set` absorbs no-op refetches.
  let lastRefreshAt = 0;
  const refreshOpenPreviews = async (): Promise<void> => {
    if (Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) { return; }
    const client = connectionManager.getClient();
    const workspacePath = connectionManager.getWorkspacePath();
    if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
      // Not connected yet — leave the throttle window untouched so the first
      // heartbeat after the connection completes still fetches immediately.
      return;
    }
    lastRefreshAt = Date.now();
    const issueIds = new Set<string>([...provider.knownIssueIds(), ...openIssueDocIds()]);
    for (const issueId of issueIds) {
      try {
        const issue = await client.getIssue(issueId, workspacePath);
        if (issue) { provider.set(issueId, renderIssue(issueId, issue)); }
      } catch {
        // Benign — keep the last good content; next tick may succeed.
      }
    }
  };

  // Force an immediate pass, bypassing the throttle. Used when the connection
  // transitions to connected and when a preview document opens, so recovery is
  // prompt rather than waiting up to REFRESH_THROTTLE_MS for the next heartbeat.
  const refreshNow = (): void => {
    lastRefreshAt = 0;
    void refreshOpenPreviews();
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    // Drop cache entries when the markdown preview tab closes (and VSCode
    // therefore unloads the underlying codev-issue: TextDocument). Keeps
    // the cache shaped to exactly what's currently visible.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const issueId = issueIdFromUri(doc.uri);
      if (issueId) { provider.forget(issueId); }
    }),
    // A codev-issue document opening (including a tab VSCode restores after the
    // extension activates) fetches immediately instead of waiting for a heartbeat.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (issueIdFromUri(doc.uri)) { refreshNow(); }
    }),
    // When Tower finishes connecting (or reconnecting), fill any preview that
    // opened while disconnected — this is what unsticks a tab restored on launch
    // before the connection was ready.
    connectionManager.onStateChange((state) => {
      if (state === 'connected') { refreshNow(); }
    }),
    overviewCache.onDidChange(refreshOpenPreviews),
    { dispose: () => provider.dispose() },
  );

  // Cover activation-while-already-connected with tabs already restored (e.g. an
  // extension-host reload): fetch them right away rather than on the next tick.
  refreshNow();
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
  // Render as a read-only markdown preview in editor group 2 when one exists,
  // else group 1 — the same count-then-pick model as builder terminals (#804).
  //
  // We open the built-in preview's custom-editor viewType via `vscode.openWith`
  // (which accepts an explicit ViewColumn + TextDocumentShowOptions) rather than
  // the `markdown.showPreview` / `showPreviewToSide` commands. Those commands
  // anchor the preview to the *active* editor group and ignore any column
  // argument, so the old code had to `focusFirstEditorGroup` first to make
  // `Beside` resolve to group 2 — a focus side-effect that yanked the user away
  // from wherever they were sitting and, if any caller skipped the focus step,
  // chained previews into groups 3/4/5. Reading `tabGroups` and passing the
  // column explicitly removes both fragilities; `preserveFocus` keeps focus on
  // the backlog row the user clicked.
  //
  // The viewType `vscode.markdown.preview.editor` is VS Code's BUILT-IN markdown
  // preview (markdown-language-features manifest), distinct from Codev's own
  // `codev.markdownPreview` artifact canvas — so this stays on the built-in
  // renderer and does not pre-empt #1068.
  const viewColumn = pickIssuePreviewColumn(vscode.window.tabGroups.all.length);
  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    'vscode.markdown.preview.editor',
    { viewColumn, preserveFocus: true },
  );
}
