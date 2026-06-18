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
 * Scheme for builder changed-file `resourceUri`s. Deliberately NOT `file:`,
 * though — as #799 proved — the scheme alone is not what keeps VSCode's
 * built-in Git decorator off these rows. See `builderFileResourceUri`.
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
 *
 * The path is **synthetic** (`/` + the worktree-relative path), NOT the real
 * worktree fs path. This is the crux of the #799 fix: VSCode's built-in Git
 * decorators (`GitDecorationProvider`, `GitIgnoreDecorationProvider`) do NOT
 * gate on `uri.scheme` — they resolve a repository by *path* and run
 * `git check-ignore` on it. With the real `.builders/<id>/…` path, Git
 * resolves the repo (main repo → path is gitignored; or the worktree's own
 * repo → tracked) and contributes a decoration that competes with ours. At
 * equal weight (the extension API exposes no weight; VSCode pins every
 * extension decoration to `weight: 10`), the color merge winner is
 * non-deterministic, and Git's grey `ignoredResourceForeground` — resolved
 * on a ~500ms debounce, after our synchronous decoration paints — overrides
 * our SCM color (the "correct color flashes, then grey" symptom; cf.
 * microsoft/vscode#187756). A path that resolves into *no* open repository
 * makes `getRepository(uri)` return undefined, so Git never fires and our
 * decoration is the sole (winning) color.
 *
 * The real worktree path rides in the query so our own provider / handlers
 * can recover it, and it keeps `uri.toString()` distinct per builder (two
 * builders can share the same relative path) so the decoration cache — keyed
 * by `uri.toString()` — doesn't collide. The file-type icon still resolves
 * because `IFileIconTheme` keys off the basename at the path tail.
 */
export function builderFileResourceUri(worktreePath: string, rel: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BUILDER_FILE_SCHEME,
    path: '/' + rel,
    query: `wt=${encodeURIComponent(worktreePath)}`,
  });
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

    // Stable, unique id so the Builders tree can `reveal` this row when the
    // active builder-diff editor changes (#1066). `reveal` matches recreated
    // elements by id; without one a file row can't be located. The `builderId`
    // prefix keeps two builders that changed the same relative path distinct
    // (same reason `resourceUri` carries the worktree path, above). Distinct
    // from folder ids (`<builderId>::folder::<...>`) and builder-row ids
    // (`<builderId>#<version>`).
    this.id = `${builderId}::${rel}`;

    const dir = path.dirname(rel);
    const dirLabel = dir === '.' ? '' : dir;
    this.description =
      change.status === 'R' && change.oldPath
        ? `${dirLabel ? dirLabel + '  ' : ''}↤ ${change.oldPath}`
        : dirLabel;

    // resourceUri → native file-type icon + our decoration-provider badge.
    // Synthetic path (see builderFileResourceUri) keeps the built-in Git
    // decorator from path-resolving these rows and tinting the label grey (#799).
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
