import type * as vscode from 'vscode';
import { BuilderTreeItem } from './builder-tree-item.js';
import { AccordionGate } from './builders.js';
import type { AgentTarget } from './architect-tree.js';

/**
 * What a provider offers for the rows of this window's workspace that act here (Spec 1963). The
 * Agents view's `BuildersProvider` and the Cockpit's `CockpitProvider` both implement it.
 */
export interface ActingRows {
  /**
   * The `scope` every acting row of this provider carries (`''` for the Agents view), or
   * `undefined` while the provider has none (the Cockpit before Tower lists this window's
   * workspace, and always in a builder-worktree or no-workspace window).
   */
  actingScope(): string | undefined;
  /** The changed-file row for `(builderId, relPath)`, for the active-file reveal (#1066). */
  findFileItem(builderId: string, relPath: string): Promise<vscode.TreeItem | undefined>;
  /** The row to select when the agent cycle lands on `target` (#1563). */
  revealTargetForAgent(target: AgentTarget): vscode.TreeItem | undefined;
  /** Accordion (#913): hold `item` open, collapse every other builder row, and redraw. */
  collapseBuildersExcept(item: BuilderTreeItem): void;
  /** Redraw the whole view (a setting the rows read changed). */
  refresh(): void;
}

/** The parts of a `vscode.TreeView` the hosts use, whatever the view's element type. */
export interface HostView {
  readonly visible: boolean;
  badge?: vscode.ViewBadge | undefined;
  reveal(element: vscode.TreeItem, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Thenable<void>;
  readonly onDidExpandElement: vscode.Event<{ readonly element: unknown }>;
  readonly onDidChangeSelection: vscode.Event<{ readonly selection: readonly unknown[] }>;
}

/** One tree view that renders this window's agents, and the provider behind it. */
export interface AgentTreeHost {
  readonly view: HostView;
  readonly rows: ActingRows;
  /**
   * Follow-reveals (active file, agent cycle) land here when no host is visible. Set on the Agents
   * view only, so with the Cockpit hidden the Agents view reveals exactly as it did before it.
   */
  readonly revealWhenNoneVisible?: boolean;
}

/** The `scope` a tree row carries, or `undefined` for a row that names none. */
function scopeOf(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') { return undefined; }
  const scope = (row as { scope?: unknown }).scope;
  if (typeof scope === 'string') { return scope; }
  return undefined;
}

/**
 * The tree behaviours the Agents view used to own alone — row-click expand, the accordion, the
 * active-file and agent-cycle reveals, the `builder-active` hook and the activity badge —
 * generalised over every view that renders this window's agents (Spec 1963): the Agents view and
 * the Cockpit.
 *
 * A row belongs to exactly one view. Its `scope` says which: each host's provider reports the
 * scope of its acting rows, and only those rows act. Another workspace's rows in the Cockpit
 * (navigate-only) never match, so they never expand, reveal, or fire `builder-active`.
 */
export class AgentTreeHosts {
  private readonly gates = new Map<AgentTreeHost, AccordionGate>();

  constructor(private readonly hosts: readonly AgentTreeHost[], accordionEnabled: boolean) {
    for (const host of hosts) {
      this.gates.set(host, new AccordionGate(accordionEnabled));
    }
  }

  /** The host whose acting rows include `row` (matched by `scope`), or `undefined`. */
  hostOf(row: unknown): AgentTreeHost | undefined {
    const scope = scopeOf(row);
    if (scope === undefined) { return undefined; }
    return this.hosts.find(host => host.rows.actingScope() === scope);
  }

  /**
   * Subscribe each view's own accordion (#913): expanding a builder row collapses the other builder
   * rows of the same view, gated by that view's own `AccordionGate`.
   */
  wireAccordion(): vscode.Disposable[] {
    return this.hosts.map(host => host.view.onDidExpandElement(e => this.onExpand(host, e.element)));
  }

  private onExpand(host: AgentTreeHost, element: unknown): void {
    if (!(element instanceof BuilderTreeItem)) { return; }
    if (this.hostOf(element) !== host) { return; }
    if (this.gates.get(host)!.shouldCollapseOthers(element.builderId)) {
      host.rows.collapseBuildersExcept(element);
    }
  }

  /** `codev.buildersAutoCollapse` changed: re-gate every view's accordion. */
  setAccordionEnabled(enabled: boolean): void {
    for (const gate of this.gates.values()) { gate.setEnabled(enabled); }
  }

  /** `codev.buildersFileViewAsTree` changed: redraw every view. */
  refreshAll(): void {
    for (const host of this.hosts) { host.rows.refresh(); }
  }

  /**
   * Publish `builder-active` when an acting builder row (or one of its file rows) is selected, in
   * whichever view it is selected.
   */
  wireSelection(onBuilderSelected: (builderId: string) => void): vscode.Disposable[] {
    return this.hosts.map(host => host.view.onDidChangeSelection((e) => {
      const selected = e.selection[0] as { builderId?: unknown } | undefined;
      if (typeof selected?.builderId !== 'string' || selected.builderId === '') { return; }
      if (this.hostOf(selected) !== host) { return; }
      onBuilderSelected(selected.builderId);
    }));
  }

  /**
   * The row-click expand (`codev.openBuilderRow`): reveal `item` expanded in its own view. A row
   * no host owns (its workspace left the Cockpit mid-click) has nothing to expand.
   */
  async expandRow(item: BuilderTreeItem): Promise<void> {
    const host = this.hostOf(item);
    if (!host) { return; }
    await host.view.reveal(item, { expand: true, select: false, focus: false });
  }

  /** The same badge on every view, so each one's activity-bar button carries it. */
  setBadge(badge: vscode.ViewBadge | undefined): void {
    for (const host of this.hosts) { host.view.badge = badge; }
  }

  /**
   * The hosts a follow-reveal lands in: every visible view with acting rows, or, when none is
   * visible, the view flagged `revealWhenNoneVisible` (the Agents view's behaviour before Spec 1963).
   */
  private followHosts(): AgentTreeHost[] {
    const withRows = this.hosts.filter(host => host.rows.actingScope() !== undefined);
    const visible = withRows.filter(host => host.view.visible);
    if (visible.length > 0) { return visible; }
    return withRows.filter(host => host.revealWhenNoneVisible === true);
  }

  /**
   * Active-file reveal (#1066): select the changed-file row of `(builderId, relPath)` in each
   * follow host. `stillCurrent` is re-checked after each lookup, so a slow lookup never overrides a
   * newer file's reveal.
   */
  async revealFile(builderId: string, relPath: string, stillCurrent: () => boolean): Promise<void> {
    for (const host of this.followHosts()) {
      const item = await host.rows.findFileItem(builderId, relPath);
      if (!item) { continue; }
      if (!stillCurrent()) { return; }
      try {
        await host.view.reveal(item, { select: true, expand: true, focus: false });
      } catch {
        // Benign if the row is no longer present (e.g. mid-cleanup).
      }
    }
  }

  /** Agent-cycle selection (#1563): select the agent's row in each follow host. */
  async revealAgent(target: AgentTarget): Promise<void> {
    for (const host of this.followHosts()) {
      const item = host.rows.revealTargetForAgent(target);
      if (!item) { continue; }
      try {
        await host.view.reveal(item, { select: true, focus: false });
      } catch {
        // Benign: the row may have changed between open and reveal.
      }
    }
  }
}
