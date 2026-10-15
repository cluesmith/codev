/**
 * Working-tree tripwire for consultation lanes (#1649).
 *
 * A reviewer is supposed to read the tree, never write to it. `consultant.md`
 * now says so explicitly, but instruction is a probabilistic control: the claude
 * lane runs with `permissionMode: 'bypassPermissions'`, so `Edit`/`Write`/`Bash`
 * remain *reachable* even though nothing asks for them. In #1649 a review lane
 * reverted three guards in a builder's worktree to check whether the tests were
 * vacuous, and the only reason anyone found out is that the builder happened to
 * diff against HEAD afterwards.
 *
 * This module is the detection half. It snapshots the tree before a lane runs
 * and again after, and reports what moved. It does not block anything — its job
 * is to turn a silent mutation into a loud one.
 *
 * ## Why not just diff `git status --porcelain` output
 *
 * Because the interesting case is a tree that was *already dirty*. A builder
 * mid-phase has uncommitted work; porcelain reports ` M src/foo.ts` before the
 * review and ` M src/foo.ts` after it, identical strings, while the file's
 * contents changed underneath. So the snapshot pairs each path porcelain
 * reports with a hash of its contents on disk.
 *
 * ## What it cannot see
 *
 * Files git ignores. That is deliberate — `.consult/` and `codev/projects/​*​/*.txt`
 * are ignored, which is exactly why consult's own review output does not trip
 * its own wire — but it does mean a lane writing into an ignored path goes
 * unnoticed. Naming the tree under review is the goal here, not sandboxing.
 *
 * Edits *inside* a submodule, for the same reason: `git status` reports the
 * submodule as one directory entry, so a changed file within it moves nothing
 * this module can see.
 *
 * And an edit the lane restores byte-for-byte, which by construction leaves a
 * before/after comparison nothing to compare. `consultant.md` is the only
 * control for that case; there is a test asserting this silence, so the limit is
 * pinned rather than assumed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONSULT_OWNED_PREFIXES,
  diffSnapshotEntries,
  escapeControlChars,
  type IdentityChange,
  type TreeSnapshot,
} from '../../lib/tree-snapshot.js';

// The snapshot core lives in lib/tree-snapshot.ts (shared with `codev bootstrap-docs`);
// re-exported so consult callers and tests keep one import site. This module keeps what is
// consult's own: which paths a lane may write, and the warnings it prints.
export {
  CONSULT_OWNED_PREFIXES,
  snapshotTree,
  diffRepositoryIdentity,
  escapeControlChars,
  type RepositoryIdentity,
  type TreeSnapshot,
  type IdentityChange,
} from '../../lib/tree-snapshot.js';

/**
 * Review files written by consultation lanes, which are not evidence either.
 *
 * `computePersistentOutputPath()` here and `getReviewFilePath()` in porch share
 * one naming convention — `<project>/<id>-<phase>-iter<N>-<lane>.txt` under
 * `codev/projects/` — and porch's verify step runs all three lanes in parallel
 * against the same worktree. Each lane can only exclude its *own* output path,
 * so without this every cmap round would have each lane reporting its two
 * siblings' review files as mutations.
 *
 * Invisible in this repo, again, because `.gitignore` here carries
 * `codev/projects/*​/*.txt` — but `CODEV_GITIGNORE_ENTRIES` does not ship that
 * rule, so every adopter would have got a red banner on every cmap round. Same
 * shape as the `.consult/history.log` false positive, and the reason this is a
 * rule in code rather than a line in someone's `.gitignore`.
 */
const LANE_REVIEW_FILE = /^codev\/projects\/[^/]+\/[^/]+-iter\d+-[^/]+\.txt$/;

/**
 * Resolve a lane's `--output` to a repo-relative path, or null if it lands
 * outside the workspace.
 *
 * `--output` arrives exactly as the user typed it, which may be relative
 * (`consult -o review.txt`), so a raw `startsWith(workspaceRoot)` test misses it
 * and the lane ends up reporting its own review file. Resolving first also kills
 * the opposite error: a plain prefix test counts `/repo-2/x` as living inside
 * `/repo`.
 *
 * The resolution base is **`cwd`, not `workspaceRoot`**, because that is where
 * the file actually lands: every lane writes with a bare
 * `fs.writeFileSync(outputPath, …)`, and `consult` never chdirs. Resolving
 * against the workspace root instead would agree with reality only when the two
 * happen to coincide — run `consult -o review.txt` from a subdirectory and the
 * file is written to `<subdir>/review.txt` while the exclusion names
 * `review.txt`, so the lane reports its own output as a mutation.
 */
export function relativeOutputPath(
  workspaceRoot: string,
  outputPath?: string,
  cwd: string = process.cwd(),
): string | null {
  if (!outputPath) return null;
  const rel = path.relative(workspaceRoot, path.resolve(cwd, outputPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Snapshot keys come from git, which always uses forward slashes.
  return rel.split(path.sep).join('/');
}

/**
 * Repo-relative paths that differ between two snapshots, sorted.
 *
 * `ignore` takes the extra paths this particular run owns — the lane's review
 * output file, whose location depends on the project and phase. A tripwire that
 * cries wolf about its own output would be trained away within a week.
 */
export function diffTreeSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
  ignore: string[] = [],
): string[] {
  const ignored = new Set(ignore);
  return diffSnapshotEntries(
    before,
    after,
    rel =>
      ignored.has(rel) ||
      CONSULT_OWNED_PREFIXES.some(prefix => rel.startsWith(prefix)) ||
      LANE_REVIEW_FILE.test(rel),
  );
}

/**
 * The warning for a repository that moved under the reviewer.
 *
 * Separate from the changed-files banner because it is a different fact with a
 * different remedy: no file need look any different, and `git status` will not
 * show you what happened — `git reflog` will.
 */
export function formatRepositoryMovedWarning(model: string, changes: IdentityChange[]): string {
  return [
    `REPOSITORY MOVED during the ${model} review (#1649).`,
    'A consultant reviews the commit in front of it; it must never commit, or switch refs.',
    ...changes.map(
      c => `  - ${c.field}: ${escapeControlChars(c.before)} -> ${escapeControlChars(c.after)}`,
    ),
    'The files on disk may look untouched and still not be the ones this review describes.',
    'Check `git reflog` and `git status` before trusting this review or shipping the branch.',
  ].join('\n');
}

/** Cap the file list so a lane that touched hundreds of paths stays readable. */
const MAX_LISTED = 20;

/**
 * The warning text, shared by the stderr banner and the review-output footer.
 *
 * Deliberately says the tree changed *while the lane ran*, not that the lane
 * changed it. Under `cmap` all three lanes run as concurrent processes in one
 * worktree, so each one sees the others' writes; asserting a culprit we cannot
 * identify would be a claim the evidence does not support.
 */
export function formatTreeChangeWarning(model: string, files: string[]): string {
  const listed = files.slice(0, MAX_LISTED);
  const rest = files.length - listed.length;
  const lines = [
    `WORKING TREE CHANGED during the ${model} review (#1649).`,
    `A consultant reviews the tree; it must never write to it. ${files.length} path${files.length === 1 ? '' : 's'} changed while this lane was running:`,
    ...listed.map(f => `  - ${escapeControlChars(f)}`),
  ];
  if (rest > 0) lines.push(`  … and ${rest} more`);
  lines.push(
    'Check `git status` and `git diff` before trusting this review or shipping the branch.',
    'Note: under cmap the lanes run concurrently in one worktree, so another lane — or you —',
    'may be the writer. This warning names what moved, not who moved it.',
  );
  return lines.join('\n');
}

/**
 * The warning for a post-review snapshot that could not be taken at all.
 *
 * Distinct from "the tree changed" because the failure is different in kind: we
 * know something happened, and we cannot say what. Reported rather than
 * swallowed — a comparison that silently returns "no changes" when it could not
 * look is the failure mode this whole module exists to avoid.
 */
export function formatSnapshotLostWarning(model: string, reason?: string): string {
  return [
    `WORKING TREE UNREADABLE after the ${model} review (#1649).`,
    'The tree was readable before this lane ran and `git status` fails now, so the tripwire',
    'cannot say whether anything changed. This is not the same as "nothing changed".',
    `Reason: ${escapeControlChars(reason ?? 'unknown')}`,
    'Check `git status` and `git diff` before trusting this review or shipping the branch.',
  ].join('\n');
}

/**
 * Append the warning to a lane's review output so it survives into the file
 * porch and the builder actually read — stderr scrolls past, review files don't.
 *
 * Written as a plain paragraph with no `VERDICT:` line, so `parseVerdict()`
 * (which scans last→first for that prefix) still finds the reviewer's own
 * verdict above it.
 */
export function appendTreeChangeWarningToOutput(
  outputPath: string | undefined,
  warning: string,
): void {
  if (!outputPath || !fs.existsSync(outputPath)) return;
  try {
    fs.appendFileSync(outputPath, `\n\n---\n\n## ⚠️ ${warning}\n`);
  } catch {
    // The stderr banner already carried the warning; failing to annotate the
    // file must not turn a successful review into a failed command.
  }
}
