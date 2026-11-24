import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import type { TowerFleetCache } from './tower-cache.js';
import type { OverviewCache } from './overview-data.js';
import type { BuilderDiffCache } from './builder-diff-cache.js';
import { orderFleet, type LabelledEntry, type OrderedFleet } from './fleet-order.js';
import { dormantGroupRow, targetOf, workspaceRow, type WorkspaceTarget } from './tower.js';
import { ArchitectTreeBuilder, type AgentTarget } from './architect-tree.js';
import { architectGrouping } from './builder-grouping.js';
import { BuilderGroupTreeItem, BuilderTreeItem, IdleArchitectsGroupTreeItem } from './builder-tree-item.js';
import type { ActingRows } from './agent-tree-hosts.js';

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

export interface CockpitProviderOptions {
  connectionManager: Pick<ConnectionManager, 'getState' | 'getWorkspacePath' | 'onStateChange'>;
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
 * Re-renders on the overview, the fleet and the connection state.
 */
export class CockpitProvider implements vscode.TreeDataProvider<CockpitNode>, ActingRows {
  private readonly changeEmitter = new vscode.EventEmitter<CockpitNode | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Row builders by scope, one per active workspace; pruned when a workspace leaves. */
  private readonly trees = new Map<string, WorkspaceTree>();
  /** True once a connection attempt has failed (or a connection dropped). */
  private attemptFailed: boolean;

  constructor(private readonly options: CockpitProviderOptions) {
    const { connectionManager, towerCache, overviewCache } = options;
    this.attemptFailed = connectionManager.getState() === 'reconnecting';
    this.subscriptions.push(
      overviewCache.onDidChange(() => this.refresh()),
      towerCache.onDidChange(() => this.refresh()),
      connectionManager.onStateChange((state) => {
        if (state === 'disconnected' || state === 'reconnecting') { this.attemptFailed = true; }
        this.refresh();
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
   * The acting row builder of this window's workspace, or `undefined` when nothing acts here: Tower
   * has not listed this workspace (yet), it is dormant, or the window is a builder-worktree or
   * no-workspace window.
   */
  private actTree(): ArchitectTreeBuilder | undefined {
    const ws = this.ordered().active.find(entry => this.actsHere(entry));
    if (!ws) { return undefined; }
    return this.treeFor(ws);
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

  /** Drop the row builders of workspaces no longer active in the fleet. */
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
