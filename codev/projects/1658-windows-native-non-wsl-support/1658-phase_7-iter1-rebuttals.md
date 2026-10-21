# Phase 7 iter 1: responses

Gemini: skipped (agy exit 3, non-blocking). Codex: REQUEST_CHANGES. Claude: APPROVE with non-blocking notes.

## Codex

- **cleanup swallows `WorktreeRemovalError` and carries on.** Accepted, fixed. The spec criterion is "removes the worktree ... or fails with a clear error naming the blocking path". On Windows a removal that fails after its retries now ends cleanup through `fatal(...)` with the blocking path, BEFORE the prune, the branch deletion and the builder-state removal, so a re-run retries the removal with everything still tracked. Test: spec-1658-cleanup-worktree-removal.test.ts asserts the rejection names the path and that no `git branch -D`, no prune and no `removeBuilder` happened. POSIX keeps its existing warn-and-continue around `git worktree remove` (unchanged behaviour, out of this phase's scope).

## Claude

1. **Serial per-entry removal may be slow on a large `node_modules`.** Not changed in this phase: correctness (no traversal of reparse points, per-entry retry naming the path) is the requirement, and the measured Windows run removed the test worktree in ~3.1s, almost all of it waiting out the held handles. Recorded as a carry-forward for the review doc.
2. **Phase 7 limitations not yet in the review doc.** Recorded in the thread for the review phase: copies do not write through; a hard link decouples when the root file is replaced by write-then-rename; a failed Windows removal now stops cleanup (branch and state kept).
3. **Real-tree removal test makes a `dir` symlink with no win32 handling.** Fixed: it makes a junction on Windows (no privilege needed).
4. **`WorktreeRemovalError` wording implies a held handle for every code; no test of `reportLink`'s copy warning.** Fixed: the "a process may still have it open" suffix is added only for busy codes. New spec-1658-worktree-link-report.test.ts asserts a copy is a warning ("edits will not write through") and a junction logs as linked. `lstat` failures other than ENOENT are reported without retry on purpose: a busy entry fails at unlink/rmdir, not at lstat.
