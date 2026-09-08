/**
 * Pure canvas→builder resolution (#1410), vscode-free so it unit-tests without the
 * webview runtime (same precedent as `review-queue/queue.ts`).
 *
 * `viewPlanFile`/`viewSpecFile`/`viewReviewFile` open a builder's artifact inside
 * its worktree, so the owning builder is the one whose `worktreePath` is a path
 * prefix of the canvas file. Used by the canvas focus back-sync to announce which
 * builder became active when a spec/plan/review canvas is focused.
 */

/**
 * The builder that owns a canvas artifact: the one whose `worktreePath` is a path
 * prefix of `file`. A main-repo artifact (no owning worktree) resolves to
 * `undefined`. The separator boundary (`file === wt || file.startsWith(wt + sep)`)
 * prevents a sibling whose path is a mere string-prefix (`…/pir-1` vs `…/pir-12`)
 * from false-matching.
 */
export function builderIdForWorktreeFile(
  builders: ReadonlyArray<{ id: string; worktreePath?: string }>,
  file: string,
  sep: string,
): string | undefined {
  const match = builders.find(
    b => !!b.worktreePath && (file === b.worktreePath || file.startsWith(b.worktreePath + sep)),
  );
  return match?.id;
}
