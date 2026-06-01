/**
 * Codev: Search Backlog (#920) — an editor-tab `WebviewPanel` for rich,
 * exploratory backlog triage. Complements the always-on sidebar tree and the
 * Quick Pick (#918): this surface persists, lets you filter by Area /
 * Assignee / Author, substring-search title + body, sort columns, and refine
 * without re-opening.
 *
 * Architecture:
 * - **Single instance.** `createOrShow` focuses the existing panel rather than
 *   stacking duplicates.
 * - **Data via Tower.** The body-bearing dataset comes from
 *   `TowerClient.searchIssues` (GET /api/issue-search), fetched on open, on
 *   `OverviewCache` heartbeats (throttled), and whenever the Status dropdown
 *   changes (the one criterion the server resolves).
 * - **Filtering is host-side.** The webview posts criteria; this class runs the
 *   pure `searchBacklog` helper and posts back only display rows. Issue body
 *   never crosses into the webview.
 * - **Theme-aware.** The HTML uses `--vscode-*` CSS variables only — no
 *   hand-coded colors — so dark / light / high-contrast all render natively.
 */

import * as vscode from 'vscode';
import type { IssueSearchItem } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';
import {
  searchBacklog,
  clampCriteriaToDataset,
  formatAge,
  type BacklogSearchCriteria,
} from '../views/backlog-filter.js';
import { renderBacklogSearchHtml } from './backlog-search.template.js';

type IssueState = 'open' | 'closed' | 'all';

const REFRESH_THROTTLE_MS = 30_000;
/** gh issue list is hard-capped at 200; surfaced in the footer so the cap isn't silent. */
const SOURCE_CAP = 200;

/** A single display row sent to the webview — deliberately body-free. */
interface ResultRow {
  id: string;
  title: string;
  area: string;
  assignee: string;
  age: string;
}

export class BacklogSearchPanel {
  public static readonly viewType = 'codev.backlogSearch';
  private static current: BacklogSearchPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private dataset: IssueSearchItem[] = [];
  private currentUser: string | undefined;
  private state: IssueState = 'open';
  private criteria: BacklogSearchCriteria = {};
  private lastRefreshAt = 0;
  private loadError: string | undefined;

  static createOrShow(
    connectionManager: ConnectionManager,
    overviewCache: OverviewCache,
    extensionUri: vscode.Uri,
  ): void {
    // Anchor "Beside" to group 1 so the panel reuses a single editor group on
    // repeated invocations (same reasoning as view-issue.ts's preview).
    if (BacklogSearchPanel.current) {
      BacklogSearchPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      BacklogSearchPanel.viewType,
      'Search Backlog',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    BacklogSearchPanel.current = new BacklogSearchPanel(panel, connectionManager, overviewCache);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connectionManager: ConnectionManager,
    private readonly overviewCache: OverviewCache,
  ) {
    this.panel.webview.html = renderBacklogSearchHtml(this.panel.webview.cspSource);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      null,
      this.disposables,
    );
    // Keep an open panel fresh as backlog state changes, but throttle the
    // SSE/poll burst the same way view-issue.ts does.
    this.overviewCache.onDidChange(() => this.refreshThrottled(), null, this.disposables);

    this.fetchAndRender();
  }

  private async refreshThrottled(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_THROTTLE_MS) { return; }
    this.lastRefreshAt = now;
    await this.fetchAndRender();
  }

  /** Fetch the dataset for the current Status from Tower, then re-render. */
  private async fetchAndRender(): Promise<void> {
    this.lastRefreshAt = Date.now();
    const client = this.connectionManager.getClient();
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!client || !workspacePath || this.connectionManager.getState() !== 'connected') {
      this.loadError = 'Not connected to Tower';
      this.dataset = [];
      this.currentUser = undefined;
      this.postDataset();
      this.postResults();
      return;
    }
    const response = await client.searchIssues(workspacePath, this.state);
    if (!response) {
      this.loadError = 'Could not load backlog (forge unavailable?)';
      this.dataset = [];
    } else {
      this.loadError = response.error;
      this.dataset = response.items;
      this.currentUser = response.currentUser;
    }
    // A refresh / Status change can drop a facet value the user had selected;
    // clamp criteria to the new dataset so the rendered rows stay consistent
    // with the dropdowns (which reset a vanished option to its default). #920.
    this.criteria = clampCriteriaToDataset(this.criteria, this.dataset);
    this.postDataset();
    this.postResults();
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') { return; }
    const m = msg as { type?: string; criteria?: BacklogSearchCriteria; state?: string; id?: string; title?: string };
    switch (m.type) {
      case 'criteria':
        this.criteria = m.criteria ?? {};
        this.postResults();
        return;
      case 'state':
        this.state = m.state === 'closed' || m.state === 'all' ? m.state : 'open';
        this.fetchAndRender();
        return;
      case 'refresh':
        this.fetchAndRender();
        return;
      case 'open':
        if (m.id) { vscode.commands.executeCommand('codev.viewBacklogIssue', m.id); }
        return;
      case 'reference':
        // Same inline action as the sidebar row: open + focus the architect
        // terminal and inject `#<id> "<title>" ` (without submitting). Passing
        // the object form carries the title, which a bare id string can't.
        if (m.id) {
          vscode.commands.executeCommand('codev.referenceIssueInArchitect', {
            issueId: m.id,
            issueTitle: m.title,
          });
        }
        return;
    }
  }

  /** Send the dropdown facets (distinct areas/assignees/authors) + currentUser. */
  private postDataset(): void {
    const areas = [...new Set(this.dataset.map(i => i.area))].sort((a, b) => a.localeCompare(b));
    const assignees = [...new Set(this.dataset.flatMap(i => i.assignees ?? []))]
      .sort((a, b) => a.localeCompare(b));
    const authors = [...new Set(this.dataset.map(i => i.author).filter((a): a is string => !!a))]
      .sort((a, b) => a.localeCompare(b));
    this.panel.webview.postMessage({
      type: 'dataset',
      areas,
      assignees,
      authors,
      currentUser: this.currentUser ?? null,
      total: this.dataset.length,
      capped: this.dataset.length >= SOURCE_CAP,
      error: this.loadError ?? null,
    });
  }

  /** Run the host-side filter/sort and send display rows. */
  private postResults(): void {
    const matched = searchBacklog(this.dataset, { ...this.criteria, currentUser: this.currentUser });
    const now = Date.now();
    const rows: ResultRow[] = matched.map(i => ({
      id: i.id,
      title: i.title,
      area: i.area,
      assignee: i.assignees?.[0] ?? '',
      age: formatAge(i.createdAt, now),
    }));
    this.panel.webview.postMessage({ type: 'results', rows });
  }

  private dispose(): void {
    BacklogSearchPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
