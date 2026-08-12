import type {
  ControllerClient,
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
  client: ControllerClient;
  openUrl?: (url: string) => void | Promise<void>;
}

/** Row-1 selector width on the SD+ (a 2×4 keypad): the fleet window is this many
 *  builders wide, and the Select dial scrolls it a page at a time (#1410). */
export const ROW1_WINDOW_SIZE = 4;

export class CodevStore {
  readonly client: ControllerClient;
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
    this.workspaces = await this.fetchActiveWorkspaces();
    // A workspace can deactivate while it is the current selection; after the
    // refresh drops it the cursor may point past the end of the (shorter) list.
    // Snap back to a valid index so `selectedWorkspacePath()` and the zoom cursor
    // stay coherent. Reset the deeper indices too (as `rotate()` and
    // `syncToWorkspace()` do on a workspace change) — the new workspace has its
    // own builders, so a stale `builder`/`file` would point into the wrong list.
    if (this.cursor.workspace >= this.workspaces.length) {
      this.cursor = { ...this.cursor, workspace: 0, builder: 0, file: 0 };
    }
    await this.refreshOverview();
  }

  /**
   * Fetch the workspace list, keeping only entries Tower reports as active
   * (`active === true`). Dormant registrations are dead stops on the zoom dial:
   * they carry no actionable overview and every command requires the workspace
   * active in Tower, so they are filtered out at fetch time. Filtering here (not
   * per-render) keeps the stored array — which the zoom cursor and
   * `selectedWorkspacePath()` index into — coherent.
   */
  private async fetchActiveWorkspaces(): Promise<TowerWorkspace[]> {
    const all = await this.client.listWorkspaces();
    return all.filter((w) => w.active);
  }

  /** Re-fetch just the selected workspace's overview (e.g. after zooming to a
   * different workspace), then notify. A request token guards against a slower
   * earlier fetch landing after a newer one (rapid workspace switching). */
  async refreshOverview(): Promise<void> {
    // With the active-only filter, "no workspaces" is now a routine state (Tower
    // up, nothing started) rather than a degenerate one. Skip the fetch: passing
    // an undefined path makes Tower fall back to an arbitrary registered (likely
    // dormant) workspace's overview, which would render its builders on a dial
    // that has no active workspace to act on.
    if (this.workspaces.length === 0) {
      this.overview = null;
      this.loadingOverview = false;
      this.emit();
      return;
    }
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

  /**
   * The builder shown in Row-1 selector slot `slotIndex` (0-based, 0..3). Row 1
   * is a 4-wide WINDOW onto the fleet, not a fixed view of the first four (#1410):
   * the window is the page containing the selection, so rotating the Select dial
   * past the 4th builder scrolls Row 1 to builders 5-8, then 9-N. A slot past the
   * end of the fleet returns `undefined` (a trailing empty slot on the last page).
   */
  windowedBuilder(slotIndex: number): OverviewBuilder | undefined {
    return this.builders()[this.builderWindowStart() + slotIndex];
  }

  /** First builder index of the Row-1 window: the page (of `ROW1_WINDOW_SIZE`)
   *  that contains the current selection. */
  private builderWindowStart(): number {
    return Math.floor(this.cursor.builder / ROW1_WINDOW_SIZE) * ROW1_WINDOW_SIZE;
  }

  /** The workspace's review-feedback delivery mode (#1410); `'forward'` until an
   *  overview arrives, so the dial touchstrip never mislabels a press. */
  feedbackMode(): 'forward' | 'queue' {
    return this.overview?.feedbackMode ?? 'forward';
  }

  /** Count of queued review-feedback for a builder (#1410); 0 when none / absent. */
  queuedFeedback(builderId: string | undefined): number {
    if (!builderId) return 0;
    return this.overview?.queuedFeedback?.[builderId] ?? 0;
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
   * at. No-op if `path` isn't an *active* registered workspace (e.g. a builder
   * worktree window, or a dormant registration — neither is in the filtered list).
   */
  async syncToWorkspace(path: string): Promise<void> {
    let index = this.workspaces.findIndex((w) => w.path === path);
    if (index < 0) {
      // The list may be stale (a workspace was registered since the last fetch).
      // A dormant registration is filtered out here, so a path that is registered
      // but not active stays unfound and this falls through to the no-op below —
      // the same behavior as an unknown path.
      this.workspaces = await this.fetchActiveWorkspaces();
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
