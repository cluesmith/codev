import * as vscode from 'vscode';
import type { TeamApiResponse } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';

/** At most one SSE-driven fetch per this window (ms). */
export const TEAM_SSE_THROTTLE_MS = 30_000;

/** The slice of `vscode.TreeView` the provider reads. */
export interface TeamViewVisibility {
  readonly visible: boolean;
  readonly onDidChangeVisibility: vscode.Event<vscode.TreeViewVisibilityChangeEvent>;
}

/**
 * Team members with their GitHub activity (Spec 587).
 *
 * Issue #1919: Tower broadcasts an SSE event for nearly every agent tool call
 * (about two a second during a turn), and team data does not come from those
 * events. Each fetch makes Tower read the git origin and run the team-activity
 * GraphQL query, so the view fetches:
 *
 * - on an SSE event only while the view is visible, at most once per
 *   {@link TEAM_SSE_THROTTLE_MS} (trailing, so the last event is not lost);
 * - immediately when the view becomes visible, when the connection comes up,
 *   and on a manual `refresh()`.
 *
 * A fetch never overlaps another: a trigger that lands while one is in flight
 * re-runs once it settles.
 */
export class TeamProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private data: TeamApiResponse | null = null;

  private readonly subscriptions: vscode.Disposable[] = [];
  private view: TeamViewVisibility | null = null;
  private lastFetchStartedAt = Number.NEGATIVE_INFINITY;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunQueued = false;

  constructor(
    private connectionManager: ConnectionManager,
    private readonly now: () => number = Date.now,
  ) {
    this.subscriptions.push(
      connectionManager.onSSEEvent(() => this.onSSEEvent()),
      connectionManager.onStateChange((state) => {
        if (state === 'connected' && this.isVisible()) { this.refresh(); }
      }),
    );
  }

  /** Bind the tree view whose visibility gates SSE-driven fetches. */
  attachView(view: TeamViewVisibility): void {
    this.view = view;
    this.subscriptions.push(view.onDidChangeVisibility(({ visible }) => {
      if (visible) { this.refresh(); }
    }));
    if (view.visible) { this.refresh(); }
  }

  /** Fetch now (manual refresh, reveal, connect). */
  refresh(): void {
    this.clearThrottleTimer();
    this.startFetch();
  }

  dispose(): void {
    this.clearThrottleTimer();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.subscriptions.length = 0;
    this.changeEmitter.dispose();
  }

  private isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  private onSSEEvent(): void {
    if (!this.isVisible() || this.throttleTimer !== null) { return; }
    const wait = this.lastFetchStartedAt + TEAM_SSE_THROTTLE_MS - this.now();
    if (wait <= 0) {
      this.startFetch();
      return;
    }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.isVisible()) { this.startFetch(); }
    }, wait);
  }

  private clearThrottleTimer(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  private startFetch(): void {
    if (this.inFlight) {
      this.rerunQueued = true;
      return;
    }
    this.lastFetchStartedAt = this.now();
    this.inFlight = this.fetchData().finally(() => {
      this.inFlight = null;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        this.startFetch();
      }
    });
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!this.data?.enabled || !this.data.members) { return []; }

    // Root level — member list
    if (!element) {
      return this.data.members.map(m => {
        const item = new vscode.TreeItem(
          `@${m.github} (${m.role})`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = 'team-member';
        item.iconPath = new vscode.ThemeIcon('person');
        (item as any)._memberData = m;
        return item;
      });
    }

    // Member details
    const member = (element as any)._memberData;
    if (!member?.github_data) { return []; }

    const items: vscode.TreeItem[] = [];
    const ghd = member.github_data;

    // Count-only summaries — the issue/PR lists live in the Backlog / Pull
    // Requests views. Use the *Count fields (true totals via GitHub
    // search.issueCount); the node arrays are capped at 20 so `.length`
    // would silently max out.
    if ((ghd.assignedIssuesCount ?? 0) > 0) {
      const ti = new vscode.TreeItem(`Assigned: ${ghd.assignedIssuesCount}`);
      ti.iconPath = new vscode.ThemeIcon('issues');
      items.push(ti);
    }

    if ((ghd.openPRsCount ?? 0) > 0) {
      const ti = new vscode.TreeItem(`Open PRs: ${ghd.openPRsCount}`);
      ti.iconPath = new vscode.ThemeIcon('git-pull-request');
      items.push(ti);
    }

    const merged = ghd.recentActivity?.mergedPRsCount ?? 0;
    const closed = ghd.recentActivity?.closedIssuesCount ?? 0;
    if (merged || closed) {
      const ti = new vscode.TreeItem(`Last 7d: ${merged} merged, ${closed} closed`);
      ti.iconPath = new vscode.ThemeIcon('graph');
      items.push(ti);
    }

    return items;
  }

  private async fetchData(): Promise<void> {
    const client = this.connectionManager.getClient();
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!client || !workspacePath) {
      this.data = null;
      this.changeEmitter.fire();
      return;
    }

    try {
      const result = await client.request<TeamApiResponse>(
        `/workspace/${encodeWorkspacePath(workspacePath)}/api/team`,
      );
      this.data = result.ok ? result.data ?? null : null;
    } catch {
      this.data = null;
    }
    this.changeEmitter.fire();
  }
}

function encodeWorkspacePath(p: string): string {
  return Buffer.from(p).toString('base64url');
}
