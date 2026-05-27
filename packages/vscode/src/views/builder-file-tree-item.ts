import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ChangeEntry, ChangeStatus, ResourcePlan } from '../commands/view-diff.js';

/**
 * Second-level tree row: one changed file under a builder in the Builders
 * view. Carries the typed fields the `codev.openBuilderFileDiff` handler
 * needs (it receives the item itself, like the backlog/builder rows, and
 * narrows via `instanceof`).
 *
 * `plan` (left/right `SideSpec`) feeds `diffUrisForChange`; `change`
 * carries the git status (used for the tooltip + rename source). The
 * status *icon* is deliberately NOT set here — `resourceUri` lets the
 * file-type icon show, and `BuilderFileDecorationProvider` adds the
 * SCM-style colored status-letter badge, mirroring VSCode's Git decorator.
 *
 * Used by views/builders.ts.
 */

/**
 * Scheme for builder changed-file `resourceUri`s. Deliberately NOT `file:`
 * so VSCode's built-in Git FileDecorationProvider — which fires for every
 * `file:` URI rendered in the editor — does not also decorate these rows.
 * With a `file:` URI, Git sees the gitignored `.builders/<id>/…` path and
 * tints the label with `gitDecoration.ignoredResourceForeground` (grey),
 * winning the color merge over our SCM-style status colors (#799). The
 * file-type icon still resolves because `IFileIconTheme` keys off
 * basename, not scheme.
 *
 * No TextDocumentContentProvider is registered for this scheme — these
 * URIs are markers for the tree row only; the diff is opened via
 * `codev.openBuilderFileDiff`, which builds explicit left/right URIs.
 */
export const BUILDER_FILE_SCHEME = 'codev-builder-diff';

/**
 * Build the `resourceUri` for a builder changed-file row. Used by both
 * `BuilderFileTreeItem` (the tree item shown to the user) and
 * `BuilderDiffCache` (when firing decoration-change events) so the two
 * URIs match exactly — VSCode keys decoration cache entries by URI, so a
 * mismatch would leave stale decorations on screen.
 */
export function builderFileResourceUri(worktreePath: string, rel: string): vscode.Uri {
  return vscode.Uri.file(path.join(worktreePath, rel)).with({ scheme: BUILDER_FILE_SCHEME });
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  M: 'Modified',
  T: 'Type changed',
  U: 'Unmerged',
};

export class BuilderFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly builderId: string,
    public readonly worktreePath: string,
    public readonly baseRef: string,
    public readonly change: ChangeEntry,
    public readonly plan: ResourcePlan,
  ) {
    const rel = plan.resourcePath;
    super(path.basename(rel));

    const dir = path.dirname(rel);
    const dirLabel = dir === '.' ? '' : dir;
    this.description =
      change.status === 'R' && change.oldPath
        ? `${dirLabel ? dirLabel + '  ' : ''}↤ ${change.oldPath}`
        : dirLabel;

    // resourceUri → native file-type icon + our decoration-provider badge.
    // Custom scheme keeps the built-in Git decorator from firing on the
    // gitignored worktree path and tinting the label grey (#799).
    this.resourceUri = builderFileResourceUri(worktreePath, rel);
    this.tooltip = `${STATUS_LABEL[change.status] ?? 'Changed'} · ${rel}`;
    this.contextValue = 'builder-file';
    this.command = {
      command: 'codev.openBuilderFileDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }
}
