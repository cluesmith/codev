import * as vscode from 'vscode';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import type { ConnectionManager } from '../connection-manager.js';
import type { TowerFleetCache } from './tower-cache.js';
import { orderFleet } from './fleet-order.js';
import type { LabelledEntry } from './fleet-order.js';
import { ageSince, describeAttention } from './attention-format.js';

/** Command a Tower workspace row runs — switch to it, or activate-then-open if dormant. */
export const OPEN_WORKSPACE_COMMAND = 'codev.tower.openWorkspace';

/**
 * The workspace a Tower action targets. The open/deactivate commands are invoked two ways — with
 * this object (a row's `command.arguments`) and with the tree node itself (an inline/context menu
 * button) — so handlers normalize their argument through `toWorkspaceTarget`.
 */
export interface WorkspaceTarget {
  path: string;
  active: boolean;
  name: string;
  /** True when this is the window's own workspace (opening it would just re-focus this window). */
  isCurrent: boolean;
}

type TowerNode =
  | { kind: 'message'; text: string; icon: string }
  | { kind: 'workspace'; ws: LabelledEntry }
  | { kind: 'dormant-group'; rows: LabelledEntry[] }
  | { kind: 'attention'; label: string; description: string; icon: string; color?: string };

/** The `WorkspaceTarget` for a labelled row. */
function targetOf(ws: LabelledEntry): WorkspaceTarget {
  return { path: ws.entry.workspace.path, active: ws.entry.workspace.active, name: ws.label, isCurrent: ws.isCurrent };
}

/**
 * Normalize whatever a Tower command was invoked with into a `WorkspaceTarget`. VS Code passes a
 * `command.arguments` value straight through (already a target), but a `view/item/context` menu
 * passes the tree **element** — here a workspace `TowerNode`. Anything else yields `undefined`.
 */
export function toWorkspaceTarget(arg: unknown): WorkspaceTarget | undefined {
  if (arg && typeof arg === 'object') {
    const node = arg as { kind?: unknown; ws?: LabelledEntry; path?: unknown; active?: unknown; name?: unknown };
    if (node.kind === 'workspace' && node.ws) { return targetOf(node.ws); }
    if (typeof node.path === 'string' && typeof node.active === 'boolean' && typeof node.name === 'string') {
      return arg as WorkspaceTarget;
    }
  }
  return undefined;
}

/**
 * The Codev Tower tree: every workspace the machine's Tower knows, active ones urgency-ordered so
 * "needs a human" floats up, each expandable to what needs a human. Dormant (known-but-inactive)
 * workspaces sit in a secondary collapsible group. This window's own workspace is marked in place —
 * it keeps its urgency slot rather than being pinned first, so an urgent *other* workspace still
 * outranks it.
 *
 * Pure rendering over `TowerFleetCache`: the cache owns fetching and the single shared SSE
 * subscription; this provider only reads `getFleet()` and re-renders on `onDidChange`. Attention is
 * read from the SDK's `AttentionSummary`, never re-derived; ordering is the SDK's `compareAttention`
 * applied with a stable sort over label-ordered rows (so equal-attention workspaces stay in label
 * order — the tie-break `compareAttention` deliberately leaves to callers).
 */
export class TowerProvider implements vscode.TreeDataProvider<TowerNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly cacheSubscription: vscode.Disposable;

  constructor(
    private cache: TowerFleetCache,
    private connectionManager: ConnectionManager,
  ) {
    this.cacheSubscription = this.cache.onDidChange(() => this.changeEmitter.fire());
  }

  dispose(): void {
    this.cacheSubscription.dispose();
    this.changeEmitter.dispose();
  }

  getTreeItem(node: TowerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case 'dormant-group': {
        const item = new vscode.TreeItem(`Dormant (${node.rows.length})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('archive');
        item.contextValue = 'tower-dormant-group';
        return item;
      }
      case 'workspace':
        return this.workspaceItem(node.ws);
      case 'attention': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = iconFor(node.icon, node.color);
        return item;
      }
    }
  }

  getChildren(node?: TowerNode): TowerNode[] {
    if (!node) { return this.roots(); }
    if (node.kind === 'dormant-group') {
      return node.rows.map((ws) => ({ kind: 'workspace', ws }));
    }
    if (node.kind === 'workspace') {
      return attentionRows(node.ws.entry.attention);
    }
    return [];
  }

  /** Root level: a loading/empty message, else active rows (in place) plus a dormant group. */
  private roots(): TowerNode[] {
    if (!this.cache.isLoaded()) {
      return [{ kind: 'message', text: 'Connecting to Tower…', icon: 'sync~spin' }];
    }
    const fleet = this.cache.getFleet();
    if (fleet.length === 0) {
      return [{ kind: 'message', text: 'No workspaces registered', icon: 'info' }];
    }

    const { active, dormant } = orderFleet(fleet, this.connectionManager.getWorkspacePath());
    const nodes: TowerNode[] = active.map((ws) => ({ kind: 'workspace', ws }));
    if (dormant.length > 0) {
      nodes.push({ kind: 'dormant-group', rows: dormant });
    }
    return nodes;
  }

  private workspaceItem(ws: LabelledEntry): vscode.TreeItem {
    const { entry, label, isCurrent } = ws;
    const state = describeAttention(entry.attention);
    const hasDetail = !entry.attention.isEmpty && entry.workspace.active;

    let collapsibleState = vscode.TreeItemCollapsibleState.None;
    if (hasDetail) { collapsibleState = vscode.TreeItemCollapsibleState.Collapsed; }
    const item = new vscode.TreeItem(label, collapsibleState);

    const descriptionParts: string[] = [];
    if (isCurrent) { descriptionParts.push('current'); }
    if (state) { descriptionParts.push(state.text); }
    item.description = descriptionParts.join(' · ');

    if (entry.workspace.active) {
      if (state) { item.iconPath = iconFor(state.icon, state.color); }
      else if (isCurrent) { item.iconPath = new vscode.ThemeIcon('location'); }
      else { item.iconPath = new vscode.ThemeIcon('folder'); }
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    item.tooltip = `${label}\n${entry.workspace.path}`;

    // contextValue gates the row's inline menu (open / deactivate) in package.json.
    let contextValue = 'tower-workspace-dormant';
    if (entry.workspace.active) {
      contextValue = 'tower-workspace-active';
      if (isCurrent) { contextValue = 'tower-workspace-active-current'; }
    }
    item.contextValue = contextValue;

    // Click-to-open ONLY on rows with nothing to expand — otherwise a single click that means
    // "expand this" would also fire openFolder. Expandable rows open via the inline button instead.
    if (!hasDetail) {
      item.command = { command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace', arguments: [targetOf(ws)] };
    }
    return item;
  }
}

/** The expanded per-workspace attention rows, in the summary's own order. */
function attentionRows(a: AttentionSummary): TowerNode[] {
  const rows: TowerNode[] = [];
  for (const gate of a.pendingGates) {
    const age = ageSince(gate.since);
    let description = gate.gate;
    if (age) { description = `${gate.gate} · ${age}`; }
    let icon = 'warning';
    if (gate.gate === 'PR review') { icon = 'git-pull-request'; }
    rows.push({ kind: 'attention', label: builderLabel(gate), description, icon, color: 'list.warningForeground' });
  }
  for (const wait of a.waiting) {
    const age = ageSince(wait.since);
    let description = 'waiting';
    if (age) { description = `waiting ${age}`; }
    rows.push({ kind: 'attention', label: builderLabel(wait), description, icon: 'clock' });
  }
  for (const held of a.heldMail) {
    rows.push({ kind: 'attention', label: builderLabel(held), description: `${held.count} held`, icon: 'mail' });
  }
  for (const queued of a.queuedFeedback) {
    rows.push({ kind: 'attention', label: builderLabel(queued), description: `${queued.count} queued`, icon: 'comment' });
  }
  return rows;
}

/** A builder's row label — its issue title when known, else the builder id. */
function builderLabel(ref: { builderId: string; issueTitle: string | null }): string {
  if (ref.issueTitle) { return `${ref.builderId} · ${ref.issueTitle}`; }
  return ref.builderId;
}

/** A `ThemeIcon`, optionally tinted with a `ThemeColor` id. */
function iconFor(icon: string, color?: string): vscode.ThemeIcon {
  if (color) { return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color)); }
  return new vscode.ThemeIcon(icon);
}
