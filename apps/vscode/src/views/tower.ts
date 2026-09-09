import * as vscode from 'vscode';
import { compareAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import type { ConnectionManager } from '../connection-manager.js';
import type { FleetEntry, TowerFleetCache } from './tower-cache.js';
import { disambiguateLabels } from './workspace-label.js';
import { ageSince, describeAttention } from './attention-format.js';

/** Command a Tower workspace row runs on click — switch to it, or activate-then-open if dormant. */
export const OPEN_WORKSPACE_COMMAND = 'codev.tower.openWorkspace';

/** A labelled fleet entry, resolved once per render so the tree and its rows agree on the label. */
interface LabelledEntry {
  entry: FleetEntry;
  label: string;
  isCurrent: boolean;
}

type TowerNode =
  | { kind: 'message'; text: string; icon: string }
  | { kind: 'workspace'; ws: LabelledEntry }
  | { kind: 'dormant-group'; rows: LabelledEntry[] }
  | { kind: 'attention'; label: string; description: string; icon: string; color?: string };

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

  constructor(
    private cache: TowerFleetCache,
    private connectionManager: ConnectionManager,
  ) {
    this.cache.onDidChange(() => this.changeEmitter.fire());
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

    const currentPath = this.connectionManager.getWorkspacePath();
    const labels = disambiguateLabels(fleet.map((e) => e.workspace));
    const label = (entry: FleetEntry): LabelledEntry => ({
      entry,
      label: labels.get(entry.workspace.path) ?? entry.workspace.name,
      isCurrent: entry.workspace.path === currentPath,
    });

    const active = fleet.filter((e) => e.workspace.active).map(label);
    const dormant = fleet.filter((e) => !e.workspace.active).map(label);

    // Label order first, then a STABLE sort by urgency: equal-attention workspaces keep label order
    // (the secondary tie-break compareAttention leaves to the caller).
    active.sort((a, b) => a.label.localeCompare(b.label));
    active.sort((a, b) => compareAttention(a.entry.attention, b.entry.attention));
    dormant.sort((a, b) => a.label.localeCompare(b.label));

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

    const item = new vscode.TreeItem(
      label,
      hasDetail ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

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

    // contextValue gates the row's inline menu (switch / activate / deactivate) in package.json.
    const scope = entry.workspace.active ? 'active' : 'dormant';
    const current = isCurrent ? '-current' : '';
    item.contextValue = `tower-workspace-${scope}${current}`;

    item.command = {
      command: OPEN_WORKSPACE_COMMAND,
      title: 'Open Workspace',
      arguments: [{ path: entry.workspace.path, active: entry.workspace.active, name: label }],
    };
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
