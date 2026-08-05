import type {
  TowerClient,
  TowerWorkspace,
  OverviewData,
  OverviewBuilder,
  OverviewPR,
  OverviewBacklogItem,
} from '@cluesmith/codev-sdk/controller';
import { initialCursor, rotate, descend, ascend, type CursorState, type LevelCounts } from './nav/cursor.js';

/**
 * Shared state for all actions: one Tower client, the latest overview for the
 * selected workspace, the workspaces list, the zoom cursor, and online status.
 * Actions read selection helpers and call `client.sendCommand(...)`; they
 * subscribe via `onChange` to re-render when overview / status updates arrive
 * over SSE.
 *
 * `openUrl` is injectable so `pr-nav` (which opens a PR in the browser) stays
 * testable without the SDK.
 */
export interface CodevStoreOptions {
  client: TowerClient;
  openUrl?: (url: string) => void | Promise<void>;
}

export class CodevStore {
  readonly client: TowerClient;
  readonly openUrl: (url: string) => void | Promise<void>;

  cursor: CursorState = initialCursor();
  online = false;
  workspaces: TowerWorkspace[] = [];
  overview: OverviewData | null = null;
  /** True while the selected workspace's overview is being (re)fetched after a switch. */
  loadingOverview = false;

  /** Monotonic token so an out-of-order overview fetch can't overwrite a newer one. */
  private overviewReq = 0;

  private readonly listeners = new Set<() => void>();
  private stopSse?: () => void;

  constructor(options: CodevStoreOptions) {
    this.client = options.client;
    this.openUrl = options.openUrl ?? (() => {});
  }

  /** Subscribe to state changes (for re-render). Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Connect the SSE stream and pull the first snapshot. */
  async start(): Promise<void> {
    this.stopSse = this.client.subscribeEvents({
      onStatus: (online) => {
        this.online = online;
        this.emit();
      },
      onEnvelope: () => {
        void this.refresh();
      },
    });
    await this.refresh();
  }

  stop(): void {
    this.stopSse?.();
    this.stopSse = undefined;
  }

  /** Re-fetch workspaces + the selected workspace's overview, then notify. */
  async refresh(): Promise<void> {
    this.workspaces = await this.client.listWorkspaces();
    await this.refreshOverview();
  }

  /** Re-fetch just the selected workspace's overview (e.g. after zooming to a
   * different workspace), then notify. A request token guards against a slower
   * earlier fetch landing after a newer one (rapid workspace switching). */
  async refreshOverview(): Promise<void> {
    const req = ++this.overviewReq;
    const data = await this.client.getOverview(this.selectedWorkspacePath());
    if (req !== this.overviewReq) return; // superseded by a newer fetch
    this.overview = data;
    this.loadingOverview = false;
    this.emit();
  }

  // ── Selection helpers ─────────────────────────────────────────────────

  selectedWorkspacePath(): string | undefined {
    return this.workspaces[this.cursor.workspace]?.path;
  }

  builders(): OverviewBuilder[] {
    return this.overview?.builders ?? [];
  }

  selectedBuilder(): OverviewBuilder | undefined {
    return this.builders()[this.cursor.builder];
  }

  pendingGates(): OverviewBuilder[] {
    return this.builders().filter((b) => b.blocked);
  }

  /** The builder whose gate the approve-gate key targets (oldest-first not yet
   * available in overview — first blocked builder for now; see PLAN open detail). */
  topGateBuilderId(): string | undefined {
    return this.pendingGates()[0]?.id;
  }

  pendingPRs(): OverviewPR[] {
    return this.overview?.pendingPRs ?? [];
  }

  backlog(): OverviewBacklogItem[] {
    return this.overview?.backlog ?? [];
  }

  // ── Cursor ops (clamped to live counts) ───────────────────────────────

  private counts(): LevelCounts {
    return { workspaces: this.workspaces.length, builders: this.builders().length, files: 0 };
  }

  rotateCursor(delta: number): void {
    const before = this.selectedWorkspacePath();
    this.cursor = rotate(this.cursor, delta, this.counts());
    // Rotating at the workspaces altitude changes which workspace's builders we
    // show. Drop the previous workspace's overview *before* rendering so its
    // stale builder details never flash under the new workspace, then re-fetch.
    if (this.selectedWorkspacePath() !== before) {
      this.overview = null;
      this.loadingOverview = true;
      this.emit();
      void this.refreshOverview();
    } else {
      this.emit();
    }
  }

  descendCursor(): void {
    this.cursor = descend(this.cursor);
    this.emit();
  }

  ascendCursor(): void {
    this.cursor = ascend(this.cursor);
    this.emit();
  }

  /** Force the cursor to a specific altitude (used by the zoom navigator to skip
   * the trivial workspaces level on single-workspace setups). */
  setLevel(level: CursorState['level']): void {
    if (this.cursor.level === level) return;
    this.cursor = { ...this.cursor, level };
    this.emit();
  }

  /**
   * Follow the focused editor provider: point the cursor at `path` and load that
   * workspace's overview, so the plugin targets the workspace the user is looking
   * at. No-op if `path` isn't a registered workspace (e.g. a builder worktree
   * window, which isn't in the workspaces list).
   */
  async syncToWorkspace(path: string): Promise<void> {
    let index = this.workspaces.findIndex((w) => w.path === path);
    if (index < 0) {
      // The list may be stale (a workspace was registered since the last fetch).
      this.workspaces = await this.client.listWorkspaces();
      index = this.workspaces.findIndex((w) => w.path === path);
    }
    if (index < 0 || index === this.cursor.workspace) return;
    this.cursor = { ...this.cursor, workspace: index, builder: 0 };
    this.overview = null;
    this.loadingOverview = true;
    this.emit();
    await this.refreshOverview();
  }

  /**
   * Follow the active builder in VSCode: point the cursor at the matching builder
   * and descend to the builders level, so the diff dials track the builder the user
   * is working on (a focused diff, the builder terminal, or its sidebar row).
   *
   * `id` is the builder identifier the extension uses everywhere — for diff/sidebar
   * signals it is `OverviewBuilder.id` (the worktree dir name, what `builderById`
   * matches), for the terminal it may be the `roleId` form. We match BOTH `id` and
   * `roleId` (both on `OverviewBuilder`, both from the same Tower overview), so any
   * of the extension's id forms resolves. No-op if no builder matches, or it is
   * already the selection.
   */
  syncToBuilder(id: string): void {
    const index = this.builders().findIndex((b) => b.id === id || b.roleId === id);
    if (index < 0) return;
    if (index === this.cursor.builder && this.cursor.level === 'builders') return;
    this.cursor = { ...this.cursor, builder: index, level: 'builders' };
    this.emit();
  }
}
