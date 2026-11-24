import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import type { ResolvedWorktreeConfig } from '../load-worktree-config.js';
import type { TowerFleetCache } from './tower-cache.js';
import type { OverviewCache } from './overview-data.js';
import type { BuilderDiffCache } from './builder-diff-cache.js';
import { orderFleet, type LabelledEntry, type OrderedFleet } from './fleet-order.js';
import { dormantGroupRow, targetOf, workspaceRow, type WorkspaceTarget } from './tower.js';
import { ArchitectTreeBuilder, type AgentTarget } from './architect-tree.js';
import { architectGrouping } from './builder-grouping.js';
import { BuilderGroupTreeItem, BuilderTreeItem, IdleArchitectsGroupTreeItem } from './builder-tree-item.js';
import type { ActingRows } from './agent-tree-hosts.js';
import { workspaceDevSlot, type WorkspaceDevSlot } from './workspace.js';

/** The Cockpit's tree view id (Spec 1963). */
export const COCKPIT_VIEW_ID = 'codev.cockpit';

/** Stable ids of the Cockpit's own rows, so expansion survives a refresh and `reveal` can match them. */
export const COCKPIT_IDS = {
  tower: 'cockpit-tower',
  dormant: 'cockpit-dormant',
  workspace: (path: string) => `cockpit-ws:${path}`,
  loading: (path: string) => `cockpit-loading:${path}`,
} as const;

/** The id prefix of every architect and builder row under one workspace. */
export function cockpitScope(path: string): string {
  return `ws:${path}|`;
}

/**
 * The Cockpit's own nodes. Architect, builder and changed-file rows under a workspace are the
 * `vscode.TreeItem`s its `ArchitectTreeBuilder` makes. A workspace node has the Tower view's
 * `{ kind: 'workspace', ws }` shape, so the Tower view's Open / Deactivate handlers accept it.
 */
export type CockpitOwnNode =
  | { kind: 'tower-root' }
  | { kind: 'message'; text: string; icon: string; command?: vscode.Command; tooltip?: string }
  | { kind: 'workspace'; ws: LabelledEntry }
  | { kind: 'dormant-group'; rows: LabelledEntry[] }
  | { kind: 'loading'; ws: LabelledEntry };

export type CockpitNode = CockpitOwnNode | vscode.TreeItem;

/**
 * Whose row this window's workspace row is:
 * - `current`: this window's workspace, which acts here (Spawn Builder, New Shell, Add Architect,
 *   Open Web Interface, dev, dev URLs);
 * - `parent`: the parent workspace of a builder-worktree window (#1809). It carries only the
 *   worktree-scoped actions the Workspace view shows there: Open Web Interface, dev, dev URLs.
 */
export type CockpitWorkspaceRole = 'current' | 'parent';

/** The `contextValue` suffix of each dev slot; `none` offers no dev action. */
const DEV_SLOT_SUFFIX: Record<WorkspaceDevSlot['kind'], string> = {
  stop: '-dev-stop',
  'stop-other': '-dev-stop-other',
  start: '-dev-start',
  none: '',
};

/** Every dev-slot kind, for callers that enumerate the context values. */
export const DEV_SLOT_KINDS = Object.keys(DEV_SLOT_SUFFIX) as Array<WorkspaceDevSlot['kind']>;

/**
 * The `contextValue` of this window's workspace row, encoding what the Workspace view decides for
 * this window, so the menus can offer exactly that:
 * `cockpit-workspace-<role>`, then the dev slot (`-dev-start`, `-dev-stop`, `-dev-stop-other`, or
 * nothing), then `-devurls` when `worktree.devUrls` is non-empty. Every other workspace row keeps
 * the Tower view's `tower-workspace-*` value, so the Tower menus' `viewItem` patterns apply as-is.
 */
export function cockpitWorkspaceContext(role: CockpitWorkspaceRole, devSlot: WorkspaceDevSlot['kind'], hasDevUrls: boolean): string {
  let value = `cockpit-workspace-${role}${DEV_SLOT_SUFFIX[devSlot]}`;
  if (hasDevUrls) { value += '-devurls'; }
  return value;
}

export interface CockpitProviderOptions {
  connectionManager: Pick<ConnectionManager, 'getState' | 'getWorkspacePath' | 'getWindowRoot' | 'onStateChange' | 'onSSEEvent'>;
  /** The dev slot (*Start Dev* / *Stop Dev*) follows the dev terminals, as in the Workspace view. */
  terminalManager: Pick<TerminalManager, 'listDevTerminals' | 'onDidChangeDevTerminals'>;
  /** This window's resolved worktree config (`loadWorktreeConfig`); the Cockpit holds the result. */
  loadWorktreeConfig: () => Promise<ResolvedWorktreeConfig | null>;
  towerCache: Pick<TowerFleetCache, 'getFleet' | 'isLoaded' | 'getOverview' | 'onDidChange'>;
  overviewCache: Pick<OverviewCache, 'getData' | 'onDidChange'>;
  diffCache: BuilderDiffCache;
  /**
   * A builder-worktree window (#1809): the parent workspace is marked current, but its rows act on
   * nothing here, so every workspace navigates.
   */
  builderWorktreeWindow: boolean;
  /**
   * How this window connects to Tower, decided at activation:
   * - `auto`: `ConnectionManager.initialize()` makes the first attempt by itself;
   * - `manual`: `codev.autoConnect` is off, so no attempt starts until *Reconnect*;
   * - `none`: a dormant window (guest mode, no Codev workspace, #1144) never connects.
   *
   * Only `auto` may say *Connecting…* before any attempt has started; the others would say it
   * forever.
   */
  connection: CockpitConnectionMode;
}

/** See `CockpitProviderOptions.connection`. */
export type CockpitConnectionMode = 'auto' | 'manual' | 'none';

/**
 * The window's connection mode, from the activation policy's `initializeConnection` and the
 * `codev.autoConnect` setting `ConnectionManager.initialize()` reads at the same moment.
 */
export function cockpitConnectionMode(initializeConnection: boolean, autoConnect: boolean): CockpitConnectionMode {
  if (!initializeConnection) { return 'none'; }
  return autoConnect ? 'auto' : 'manual';
}

/** One workspace's row builder, and the workspace as it was last listed. */
interface WorkspaceTree {
  tree: ArchitectTreeBuilder;
  ws: LabelledEntry;
}

/** The worktree config fetched for one workspace path: the request, then its result. */
interface HeldWorktreeConfig {
  path: string | null;
  request: Promise<ResolvedWorktreeConfig | null>;
  value: ResolvedWorktreeConfig | null;
}

/** The type inside one of Tower's SSE envelopes, or `undefined` for a malformed one. */
function envelopeType(data: string): unknown {
  try {
    return (JSON.parse(data) as { type?: unknown }).type;
  } catch {
    return undefined;
  }
}

const ARCHITECT_AXIS = architectGrouping();

/**
 * The Codev Cockpit (Spec 1963): one tree with one hierarchy, *Tower → workspaces → architects →
 * builders → (this window's workspace only) changed files*.
 *
 * - **Tower root.** While there is nothing to list it holds one state row that follows the
 *   connection: *Connecting to Tower…* until an attempt fails, then *Not connected to Tower*
 *   (click: *Reconnect*), or *No workspaces registered*.
 * - **Workspaces.** The Tower view's set, labels, urgency order, *current* marker and *Dormant (N)*
 *   group (`orderFleet`, rows from `workspaceRow`). Every active workspace has children, so a click
 *   toggles it; dormant rows keep click-to-open.
 * - **Architects → builders.** One `ArchitectTreeBuilder` per active workspace, on the architect
 *   axis whatever `codev.buildersGroupBy` says. This window's workspace acts, reading
 *   `OverviewCache` as the Agents view does; every other workspace navigates, reading the overview
 *   `TowerFleetCache` already fetched for it. No request of its own.
 *
 * - **This window's workspace row** carries the Workspace view's actions for this window
 *   (`cockpitWorkspaceContext`). Its dev slot and dev URLs come from the worktree config, which the
 *   Cockpit fetches once and holds: it re-renders on every fleet and overview change, including
 *   the fleet's 20 s fallback poll, so fetching per render would add requests the Workspace view
 *   does not make. The held config is dropped on `codev-config-updated`, a connection-state change
 *   or a workspace change, and the next render fetches it again.
 *
 * Re-renders on the overview, the fleet and the connection state, and on the Workspace view's own
 * signals: the dev terminals, `codev-config-updated` and `architects-updated`.
 */
export class CockpitProvider implements vscode.TreeDataProvider<CockpitNode>, ActingRows {
  private readonly changeEmitter = new vscode.EventEmitter<CockpitNode | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Row builders by scope, one per active workspace; pruned when a workspace leaves. */
  private readonly trees = new Map<string, WorkspaceTree>();
  /** True once a connection attempt has failed (or a connection dropped). */
  private attemptFailed: boolean;
  /** See `resolveWorktreeConfig`; `undefined` until fetched, and again once dropped. */
  private worktreeConfig: HeldWorktreeConfig | undefined;

  constructor(private readonly options: CockpitProviderOptions) {
    const { connectionManager, terminalManager, towerCache, overviewCache } = options;
    this.attemptFailed = connectionManager.getState() === 'reconnecting';
    this.subscriptions.push(
      overviewCache.onDidChange(() => this.refresh()),
      towerCache.onDidChange(() => this.refresh()),
      connectionManager.onStateChange((state) => {
        if (state === 'disconnected' || state === 'reconnecting') { this.attemptFailed = true; }
        this.worktreeConfig = undefined;
        this.refresh();
      }),
      // Start / Stop Dev stays honest across every start, stop and cleanup path.
      terminalManager.onDidChangeDevTerminals(() => this.refresh()),
      // Tower sends each event as a JSON envelope with no SSE `event:` name, so the type is inside.
      connectionManager.onSSEEvent(({ data }) => {
        const type = envelopeType(data);
        if (type === 'codev-config-updated') {
          this.worktreeConfig = undefined;
          this.refresh();
        } else if (type === 'architects-updated') {
          this.refresh();
        }
      }),
    );
  }

  dispose(): void {
    for (const sub of this.subscriptions) { sub.dispose(); }
    this.changeEmitter.dispose();
  }

  /** Redraw the whole tree. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(node: CockpitNode): vscode.TreeItem {
    if (node instanceof vscode.TreeItem) { return node; }
    switch (node.kind) {
      case 'tower-root': {
        const item = new vscode.TreeItem('Tower', vscode.TreeItemCollapsibleState.Expanded);
        item.id = COCKPIT_IDS.tower;
        item.iconPath = new vscode.ThemeIcon('radio-tower');
        item.tooltip = "This machine's Tower and the workspaces it serves";
        item.contextValue = 'cockpit-tower';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command) { item.command = node.command; }
        if (node.tooltip) { item.tooltip = node.tooltip; }
        return item;
      }
      case 'workspace': {
        const item = workspaceRow(node.ws, this.workspaceChildren(node.ws));
        item.id = COCKPIT_IDS.workspace(node.ws.entry.workspace.path);
        const role = this.workspaceRole(node.ws);
        if (role) { item.contextValue = this.ownWorkspaceContext(role); }
        return item;
      }
      case 'dormant-group': {
        const item = dormantGroupRow(node.rows.length);
        item.id = COCKPIT_IDS.dormant;
        return item;
      }
      case 'loading': {
        const item = new vscode.TreeItem('Loading…');
        item.id = COCKPIT_IDS.loading(node.ws.entry.workspace.path);
        item.iconPath = new vscode.ThemeIcon('sync~spin');
        return item;
      }
    }
  }

  async getChildren(node?: CockpitNode): Promise<CockpitNode[]> {
    if (node === undefined) { return [{ kind: 'tower-root' }]; }
    if (node instanceof vscode.TreeItem) {
      const tree = this.treeOfRow(node);
      if (!tree) { return []; }
      return tree.getChildren(node);
    }
    switch (node.kind) {
      case 'tower-root':
        await this.resolveWorktreeConfig();
        return this.towerChildren();
      case 'workspace':
        return this.workspaceNodeChildren(node.ws);
      case 'dormant-group':
        return node.rows.map((ws): CockpitNode => ({ kind: 'workspace', ws }));
      case 'message':
      case 'loading':
        return [];
    }
  }

  /**
   * The parent of any row, up to the Tower root: file → folder(s) → builder → architect →
   * (*Idle Architects*) → workspace → (*Dormant*) → Tower. The row builder answers within its
   * workspace; the Cockpit bridges its top rows to the workspace node.
   */
  async getParent(node: CockpitNode): Promise<CockpitNode | undefined> {
    if (node instanceof vscode.TreeItem) {
      const entry = this.entryOfRow(node);
      if (!entry) { return undefined; }
      const parent = await entry.tree.getParent(node);
      if (parent) { return parent; }
      if (node instanceof BuilderGroupTreeItem || node instanceof IdleArchitectsGroupTreeItem) {
        const ws = this.findWorkspace(entry.ws.entry.workspace.path);
        if (!ws) { return undefined; }
        return { kind: 'workspace', ws };
      }
      return undefined;
    }
    switch (node.kind) {
      case 'tower-root':
        return undefined;
      case 'message':
      case 'dormant-group':
        return { kind: 'tower-root' };
      case 'workspace': {
        if (node.ws.entry.workspace.active) { return { kind: 'tower-root' }; }
        return { kind: 'dormant-group', rows: this.ordered().dormant };
      }
      case 'loading':
        return { kind: 'workspace', ws: node.ws };
    }
  }

  // ── ActingRows (this window's workspace) ──────────────────────────────────

  actingScope(): string | undefined {
    return this.actTree()?.scope;
  }

  async findFileItem(builderId: string, relPath: string): Promise<vscode.TreeItem | undefined> {
    return this.actTree()?.findFileItem(builderId, relPath);
  }

  revealTargetForAgent(target: AgentTarget): vscode.TreeItem | undefined {
    return this.actTree()?.revealTargetForAgent(target);
  }

  collapseBuildersExcept(item: BuilderTreeItem): void {
    const tree = this.treeOfRow(item);
    if (!tree) { return; }
    tree.keepOnlyOpen(item);
    this.refresh();
  }

  /**
   * The agent-cycle roster in the Cockpit's own order: this window's architects, each followed by
   * its builders, top to bottom (#1563). Only this window's workspace: other workspaces' rows
   * navigate and never enter the cycle. Empty while nothing acts here.
   */
  agentCycleOrder(): AgentTarget[] {
    return this.actTree()?.agentCycleOrder() ?? [];
  }

  /**
   * The acting row builder of this window's workspace, or `undefined` when nothing acts here: Tower
   * has not listed this workspace (yet), it is dormant, or the window is a builder-worktree or
   * no-workspace window.
   */
  private actTree(): ArchitectTreeBuilder | undefined {
    const ws = this.ordered().active.find(entry => this.actsHere(entry));
    if (!ws) { return undefined; }
    return this.treeFor(ws);
  }

  // ── This window's workspace row ───────────────────────────────────────────

  /**
   * `ws`'s role when it is this window's workspace row: `current` when it acts here, `parent` in a
   * builder-worktree window. `undefined` for every other row, which keeps the Tower view's value.
   */
  private workspaceRole(ws: LabelledEntry): CockpitWorkspaceRole | undefined {
    if (!ws.isCurrent || !ws.entry.workspace.active) { return undefined; }
    if (this.options.builderWorktreeWindow) { return 'parent'; }
    return 'current';
  }

  private ownWorkspaceContext(role: CockpitWorkspaceRole): string {
    const config = this.worktreeConfig?.value ?? null;
    const slot = workspaceDevSlot(this.options.connectionManager, this.options.terminalManager, config);
    const hasDevUrls = (config?.devUrls ?? []).length > 0;
    return cockpitWorkspaceContext(role, slot.kind, hasDevUrls);
  }

  /**
   * Fetch this window's worktree config unless it is already held for this workspace path. The
   * rows are built synchronously in `getTreeItem`, so the root's async `getChildren` resolves the
   * config first. Concurrent renders share the one request.
   */
  private async resolveWorktreeConfig(): Promise<void> {
    const path = this.options.connectionManager.getWorkspacePath();
    let held = this.worktreeConfig;
    if (!held || held.path !== path) {
      held = { path, request: this.options.loadWorktreeConfig(), value: null };
      this.worktreeConfig = held;
    }
    held.value = await held.request;
  }

  // ── Levels ────────────────────────────────────────────────────────────────

  /** The Tower root's children: a state row while there is nothing to list, else the workspaces. */
  private towerChildren(): CockpitNode[] {
    if (!this.options.towerCache.isLoaded()) {
      return [this.connectionStateRow()];
    }
    if (this.options.towerCache.getFleet().length === 0) {
      return [{ kind: 'message', text: 'No workspaces registered', icon: 'info' }];
    }
    const { active, dormant } = this.ordered();
    this.pruneTrees(active);
    const nodes: CockpitNode[] = active.map((ws): CockpitNode => ({ kind: 'workspace', ws }));
    if (dormant.length > 0) {
      nodes.push({ kind: 'dormant-group', rows: dormant });
    }
    return nodes;
  }

  /**
   * *Connecting to Tower…* during the first attempt (also while connected but before the first
   * fleet load lands); *Not connected to Tower* once one has failed, with *Reconnect* on click.
   * `ConnectionManager` keeps retrying with backoff, so this never claims it gave up. With
   * `codev.autoConnect` off no attempt starts by itself, so the row is *Not connected* (with
   * *Reconnect*) until one does.
   */
  private connectionStateRow(): CockpitOwnNode {
    const { connectionManager, connection } = this.options;
    if (connection === 'none') {
      // A dormant window stays as inert as if Codev never activated (#1144): no connection, ever.
      // The row says why and offers the Agents view's welcome action for such a window.
      return {
        kind: 'message', text: 'Not connected to Tower', icon: 'debug-disconnect',
        tooltip: 'This window has no Codev workspace, so it does not connect to Tower. '
          + 'Click to open a folder containing a Codev project. '
          + 'To set up Codev in a project, run `codev init` in its root.',
        command: { command: 'workbench.action.files.openFolder', title: 'Open Folder' },
      };
    }
    const state = connectionManager.getState();
    // Connected but the fleet has not loaded yet; or the first attempt is under way (`auto` makes
    // one by itself; `manual` once *Reconnect* runs).
    const firstAttempt = !this.attemptFailed && (state === 'connecting' || connection === 'auto');
    if (state === 'connected' || firstAttempt) {
      return { kind: 'message', text: 'Connecting to Tower…', icon: 'sync~spin' };
    }
    const tooltip = this.attemptFailed
      ? 'Click to reconnect to Tower now. Codev keeps retrying in the background.'
      : 'Automatic connection is off (codev.autoConnect). Click to connect to Tower.';
    return {
      kind: 'message',
      text: 'Not connected to Tower',
      icon: 'debug-disconnect',
      tooltip,
      command: { command: 'codev.reconnect', title: 'Reconnect to Tower' },
    };
  }

  /**
   * How a workspace row starts: an active one always has children (expanded when it is this
   * window's own or needs attention, collapsed when quiet); a dormant one is a leaf that opens on
   * click.
   */
  private workspaceChildren(ws: LabelledEntry): 'none' | 'collapsed' | 'expanded' {
    if (!ws.entry.workspace.active) { return 'none'; }
    if (ws.isCurrent || !ws.entry.attention.isEmpty) { return 'expanded'; }
    return 'collapsed';
  }

  /** An active workspace's architects (with their builders), or *Loading…* until its overview lands. */
  private async workspaceNodeChildren(ws: LabelledEntry): Promise<CockpitNode[]> {
    if (!ws.entry.workspace.active) { return []; }
    const tree = this.treeFor(ws);
    if (this.dataFor(ws) === null) {
      return [{ kind: 'loading', ws }];
    }
    return tree.getChildren(undefined);
  }

  // ── Row builders ──────────────────────────────────────────────────────────

  /**
   * Whether `ws`'s rows act in this window: it is this window's workspace, and this window is not
   * a builder worktree (whose parent is marked current but acts on nothing here, #1809).
   */
  private actsHere(ws: LabelledEntry): boolean {
    return ws.isCurrent && ws.entry.workspace.active && !this.options.builderWorktreeWindow;
  }

  /**
   * The overview `ws`'s rows are built from: `OverviewCache` for this window's workspace (as the
   * Agents view, so the two never disagree), the fleet's retained copy for any other.
   */
  private dataFor(ws: LabelledEntry): OverviewData | null {
    if (this.actsHere(ws)) { return this.options.overviewCache.getData(); }
    return this.options.towerCache.getOverview(ws.entry.workspace.path);
  }

  /** The row builder for `ws`, made on first use and remade if `ws` changes between act and navigate. */
  private treeFor(ws: LabelledEntry): ArchitectTreeBuilder {
    const path = ws.entry.workspace.path;
    const scope = cockpitScope(path);
    const mode = this.actsHere(ws) ? 'act' : 'navigate';
    const existing = this.trees.get(scope);
    if (existing && existing.tree.mode === mode) {
      existing.ws = ws;
      return existing.tree;
    }
    let tree: ArchitectTreeBuilder;
    if (mode === 'act') {
      tree = new ArchitectTreeBuilder({
        mode: 'act',
        scope,
        getData: () => this.options.overviewCache.getData(),
        grouping: () => ARCHITECT_AXIS,
        diffCache: this.options.diffCache,
        attention: true,
      });
    } else {
      tree = new ArchitectTreeBuilder({
        mode: 'navigate',
        scope,
        getData: () => this.options.towerCache.getOverview(path),
        target: () => this.navigateTarget(scope),
        attention: true,
      });
    }
    this.trees.set(scope, { tree, ws });
    return tree;
  }

  /**
   * What a navigate-only row opens: its workspace's window. `isCurrent` is always false, because a
   * navigating row's workspace is never this window's own: in a builder-worktree window the parent
   * is *marked* current, yet opening it must still reach the parent's window.
   */
  private navigateTarget(scope: string): WorkspaceTarget {
    // `treeFor` stores the entry before building any row, so a miss is a routing bug: say so.
    const entry = this.trees.get(scope);
    if (!entry) {
      throw new Error(`CockpitProvider: no workspace tree for scope '${scope}' while building a navigate row`);
    }
    return { ...targetOf(entry.ws), isCurrent: false };
  }

  /**
   * Drop the row builders of workspaces no longer active in the fleet. Runs only when the Tower
   * root's children are listed, so while the root is collapsed a departed workspace's builder
   * lingers until the next expand. That is bounded (one builder per workspace ever listed) and
   * harmless: nothing renders or routes to it, since no row of that workspace is shown.
   */
  private pruneTrees(active: readonly LabelledEntry[]): void {
    const live = new Set(active.map(ws => cockpitScope(ws.entry.workspace.path)));
    for (const scope of this.trees.keys()) {
      if (!live.has(scope)) { this.trees.delete(scope); }
    }
  }

  /** The row builder entry that made `row`, by its `scope`; `undefined` once its workspace left. */
  private entryOfRow(row: vscode.TreeItem): WorkspaceTree | undefined {
    const scope = (row as { scope?: unknown }).scope;
    if (typeof scope !== 'string' || scope === '') {
      throw new Error(`CockpitProvider: row '${String(row.label)}' carries no workspace scope`);
    }
    return this.trees.get(scope);
  }

  private treeOfRow(row: vscode.TreeItem): ArchitectTreeBuilder | undefined {
    return this.entryOfRow(row)?.tree;
  }

  /** The fleet in the Tower view's order, labelled, with this window's workspace marked. */
  private ordered(): OrderedFleet {
    return orderFleet(this.options.towerCache.getFleet(), this.options.connectionManager.getWorkspacePath());
  }

  /** The current listing of the workspace at `path` (Tower's spelling), if it is still listed. */
  private findWorkspace(path: string): LabelledEntry | undefined {
    const { active, dormant } = this.ordered();
    return [...active, ...dormant].find(ws => ws.entry.workspace.path === path);
  }
}
