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

  /** Row-1 window width = the number of `BuilderAction` selector keys currently
   *  placed on the deck (#1465, replacing the fixed 4 of #1410). The `BuilderAction`
   *  singleton counts its visible instances and reports it via `setBuilderWindowSize`;
   *  the window then pages the fleet by that count, so a builder is never selectable
   *  while shown on no key. Defaults to 1 until the first key reports — with no keys
   *  placed nothing renders, so the value is only a division guard. */
  private builderWindowSize = 1;

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
   * The architects the Architects board enumerates (#1495): the names of the workspace's
   * architects with a LIVE session, from `OverviewData.architects`, ordered `main` first then
   * alphabetically. An `ArchitectAction` key indexes this by its slot rank and, on press,
   * relays `open-architect-terminal <name>` — so the board must list "architects that exist",
   * every one of them, not "architects that own visible work". Deriving from builders'
   * `spawnedByArchitect` would omit a live architect that owns no builders (e.g. `demos`,
   * `reviewer`), leaving it permanently unopenable from the deck.
   *
   * This does NOT violate #1463's "the deck never consumes the live-architect view". That
   * ruling guards against a SILENTLY WRONG ACTION on a single-target key: a stale list could
   * resolve the wrong architect and the face would faithfully render the wrong name, so the
   * human never learns. This is an ENUMERATION board: the press still relays the name and
   * VSCode still performs resolution — including its "No 'X' architect found — is the workspace
   * activated?" warning — so a stale or incomplete list yields a key that FAILS LOUDLY when
   * pressed, never one that quietly opens the wrong person. The deck does not RESOLVE liveness;
   * it enumerates candidates and delegates resolution to VSCode. An empty list (Tower
   * restarting, sessions not yet reattached) renders no keys — visibly empty, self-correcting
   * on the next overview; we deliberately add no deck-side pre-validation.
   *
   * Main-first ordering keeps `main` on key 1 WHENEVER it is live — the keys are positional, so
   * a new architect can't displace it while main has a session. This replicates VS Code's
   * `sortArchitectsForPicker` (`apps/vscode/src/views/architect-display.ts`); the two apps can't
   * import each other, so the rule is twinned here. Tower already returns the list main-first,
   * but we sort anyway rather than depend on the server's order. Keep it in sync with that
   * function.
   *
   * We SORT main first but do NOT PIN it — main is never injected when it has no live session.
   * A pinned main key pressed while main is transiently invisible would not fail loudly: an
   * explicit `'main'` arms VSCode's main-else-first fallback (#1497), so it could silently open
   * the wrong architect's terminal under main's own unqualified label, self-correcting only on the
   * next press. That is the silently-wrong-action failure ruling 2 exists to prevent. An unpinned
   * main is simply absent during the flicker: visible, self-correcting, and unable to open the
   * wrong person — the safer failure.
   */
  architects(): string[] {
    const names = (this.overview?.architects ?? []).map((a) => a.name);
    return names.sort((a, b) => {
      if (a === 'main') return -1;
      if (b === 'main') return 1;
      return a.localeCompare(b);
    });
  }

  /** Report how many `BuilderAction` selector keys are currently placed (#1465). The
   *  window pages the fleet by this count, so the Row-1 window is exactly as wide as
   *  the keys on the board and a builder can't be selected while shown on no key.
   *  Never below 1 (a division guard for the no-keys-placed case). */
  setBuilderWindowSize(count: number): void {
    this.builderWindowSize = Math.max(1, count);
  }

  /**
   * The builder shown in Row-1 selector slot `slotIndex` (0-based). Row 1 is a
   * WINDOW onto the fleet whose width is the number of placed builder keys (#1465,
   * replacing the fixed 4 of #1410): the window is the page containing the selection,
   * so rotating the Select dial past the last visible builder scrolls Row 1 to the
   * next page. A slot past the end of the fleet returns `undefined` (a trailing empty
   * slot on the last page).
   */
  windowedBuilder(slotIndex: number): OverviewBuilder | undefined {
    return this.builders()[this.builderWindowStart() + slotIndex];
  }

  /** First builder index of the Row-1 window: the page (of `builderWindowSize`, the
   *  placed-key count) that contains the current selection. */
  private builderWindowStart(): number {
    const size = Math.max(1, this.builderWindowSize);
    return Math.floor(this.cursor.builder / size) * size;
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

  /** Blocked builders (a pending gate); the Zoom dial surfaces the count. */
  pendingGates(): OverviewBuilder[] {
    return this.builders().filter((b) => b.blocked);
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
