/**
 * How a command resolves its target from the argument VS Code passes it. A row's click passes its
 * `command.arguments`; a `view/item/context` menu entry passes the tree element itself, whichever
 * view it is in (the Codev views, or the Cockpit's, Spec 1963). Pure over that argument, so each
 * resolution is unit-testable without activating the extension.
 */

import * as vscode from 'vscode';
import { BacklogTreeItem } from '../views/backlog-tree-item.js';
import { BuilderGroupTreeItem, BuilderTreeItem } from '../views/builder-tree-item.js';

/** A builder row's id (from the Agents view or the Cockpit), or a row click's id string. */
export function extractBuilderId(arg: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg instanceof BuilderTreeItem) { return arg.builderId; }
  return undefined;
}

/**
 * Argument shape accepted by the backlog issue commands. Beyond the sidebar's
 * `TreeItem` and the row-click `string`, the Search Backlog webview (#920)
 * passes a plain `{ issueId, issueTitle }` object so its inline "reference in
 * architect" action can carry the title (which a bare id string can't).
 */
export type IssueCommandArg =
  | vscode.TreeItem
  | string
  | { issueId: string; issueTitle?: string }
  | undefined;

/**
 * Resolve an issue number from a command argument.
 *
 * Backlog row-click passes the issue id as a string via
 * `item.command.arguments`; right-click context-menu invocations pass the
 * BacklogTreeItem itself; command-palette invocations pass nothing →
 * undefined → spawnBuilder falls back to its full quick-pick flow. So does a
 * Cockpit workspace row's *Spawn Builder* (a `{ kind: 'workspace' }` node).
 */
export function extractIssueId(arg: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg instanceof BacklogTreeItem) { return arg.issueId; }
  if (arg && typeof arg === 'object' && 'issueId' in arg && typeof arg.issueId === 'string') { return arg.issueId; }
  return undefined;
}

/**
 * Resolve an issue title from a command argument.
 *
 * Only `BacklogTreeItem` carries the title; string args (used by row-click
 * which only passes the id) and undefined return undefined so callers can
 * fall back. An empty title is normalised to undefined so the fallback
 * branch handles it identically to a missing title.
 */
export function extractIssueTitle(arg: IssueCommandArg): string | undefined {
  if (arg instanceof BacklogTreeItem) {
    return arg.issueTitle || undefined;
  }
  if (arg && typeof arg === 'object' && 'issueId' in arg) {
    return arg.issueTitle || undefined;
  }
  return undefined;
}

/**
 * The architect `codev.removeArchitect` acts on:
 * - a string is the name itself;
 * - a Cockpit architect row (Spec 1963) is a group row whose label is display text (`WEB (0)`), so
 *   the name is its `groupName`;
 * - a Workspace-view architect row's label is UPPERCASE display text (Issue 841 Gap 3), so the
 *   raw lowercase name comes from its id (`workspace-architect-<name>`), which that tree sets for
 *   exactly this reason, and only failing that from the label.
 */
export function architectNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg instanceof BuilderGroupTreeItem) { return arg.groupName; }
  if (arg instanceof vscode.TreeItem) {
    const id = arg.id;
    if (typeof id === 'string' && id.startsWith('workspace-architect-')) {
      return id.slice('workspace-architect-'.length);
    }
    if (typeof arg.label === 'string') { return arg.label; }
  }
  return undefined;
}
