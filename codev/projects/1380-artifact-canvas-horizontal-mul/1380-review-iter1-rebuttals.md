# PR review (review phase) — iteration 1 rebuttals

## Both reviewers — branch conflicting with main, CI never ran

**Addressed.** Merged `origin/main` into the branch (one conflict, in
`.github/workflows/test.yml`: main's streamdeck steps + this PR's `canvas-browser` job —
both kept), reinstalled to confirm zero lockfile drift, and re-ran everything on the merge
result: 146 canvas jsdom + 31 browser + 751 VS Code + repo-wide green. The PR is now
MERGEABLE and all CI checks (including the new `canvas-browser` job) are running on it. The
plan's "rebase at phase boundaries" discipline was neglected mid-flight — noted in the
review's lessons; the merge preserves all phase commits per the repo's no-squash convention.

## Codex

1. **Spec/plan lack approval frontmatter.** Addressed — both artifacts now carry
   `approved: 2026-08-10` / `validated: [claude, codex]`, reflecting the human gate
   approvals porch recorded (`spec-approval`, `plan-approval`).
2. **Gemini consultation omitted despite the 3-reviewer default.** Rebutted as a builder
   action item: porch emitted 2-way consultation commands (claude + codex) at every round,
   and strict mode forbids the builder hand-running consultations porch didn't ask for. The
   lane configuration is project-level; flagged to the architect rather than worked around.

## Claude

1. **PR body test-file count wrong (13 → 18; actually 16 files).** Addressed — corrected to
   "146 package jsdom tests across 16 files".
2. **Conditional `test.skip` can silently retire the fragmented-host assertion.** Addressed
   — now a hard `expect(probe).not.toBeNull()` at the pinned viewport.
3. **`wheelDeltaPx` page-mode uses viewport height; a horizontal page is a column step.**
   Addressed — page-mode deltas now use the measured column step (clientWidth fallback);
   still a dead path on Chromium, kept correct for engine robustness.
4. **`onReadingModeChange` outbound typing.** Addressed — the webview callback is typed
   `(mode: ReadingMode)`.
