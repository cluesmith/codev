/**
 * Builder-worktree path recognition (#1809), shared by the VS Code extension
 * and Tower so the two sides cannot drift.
 *
 * `afx spawn` creates every builder worktree at `<workspaceRoot>/.builders/<id>`.
 * A worktree is a full checkout (it carries its own `codev/`), so anything that
 * asks "is this folder a codev workspace?" by looking for markers matches it.
 * The owner's ruling is that Codev never activates inside a builder worktree;
 * this module is the single path predicate both sides apply.
 *
 * Detection is by path segment, deliberately not by `git rev-parse
 * --git-common-dir`: the `.builders/<id>` layout is the invariant `afx spawn`
 * creates, and a git probe would add a process spawn to activation.
 *
 * Pure string logic: no `node:*`, no I/O, zero dependencies (the sdk's
 * environment-agnostic graph, #1189). Both `/` and `\` separators are accepted.
 */

/** Where a path sits relative to the builder worktree that contains it. */
export interface BuilderWorktreeLocation {
  /** The parent workspace root: the prefix before the final `.builders` segment. */
  workspaceRoot: string;
  /** The builder id: the segment directly after `.builders`. */
  builderId: string;
  /** The worktree itself: `<workspaceRoot>/.builders/<builderId>`. */
  worktreePath: string;
}

const BUILDERS_SEGMENT = /[\\/]\.builders[\\/]([^\\/]+)/g;

/**
 * Locate the builder worktree containing `p` (the worktree itself or any path
 * beneath it), or null when `p` is not inside one.
 *
 * The FINAL `.builders/<id>` segment wins, matching `deriveWorkspaceFromWorktree`
 * in agent-farm's state.ts, so a worktree nested under another resolves to its
 * immediate parent workspace.
 */
export function parseBuilderWorktreePath(p: string): BuilderWorktreeLocation | null {
  let last: RegExpExecArray | null = null;
  for (const match of p.matchAll(BUILDERS_SEGMENT)) {
    last = match;
  }
  if (!last || last.index === undefined) {
    return null;
  }
  let workspaceRoot = p.slice(0, last.index);
  if (workspaceRoot === '') {
    workspaceRoot = p[0];
  }
  return {
    workspaceRoot,
    builderId: last[1],
    worktreePath: p.slice(0, last.index + last[0].length),
  };
}

/** Whether `p` is a builder worktree or a path inside one. */
export function isBuilderWorktreePath(p: string): boolean {
  return parseBuilderWorktreePath(p) !== null;
}
