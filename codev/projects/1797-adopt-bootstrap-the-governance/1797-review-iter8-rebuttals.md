# 1797 review iter8: rebuttals (head 7b3f9457d)

Gemini APPROVE, Codex REQUEST_CHANGES, Claude REQUEST_CHANGES.

## Codex

1. **Branch behind `main`.** Changed: `origin/main` merged (28 commits, no conflicts, no shipped-skill changes, so the hash table is unchanged).
2. **Final-head test evidence.** Changed: full suite and `tsc` re-run after the merge; the numbers are in the review doc.

## Claude

- **Blocker: a symlinked draft was still sent to the reviewers.** Accepted and changed. `validateDrafts` flagged it, but it stayed in the `written` set, so `renderDrafts` read through the link into the review prompt. Drafts carrying a `not-regular` violation are now left out of the review. The existing test also asserts that the review prompt carries neither the draft heading nor the target's content.
- **No size bound on the review prompt:** not changed. The drafts it embeds are bounded by the validator's caps (hot files at 35 lines, at most 12 cold sections), and the CLI hands it to consult as a file (`--prompt-file`), not on argv. How each lane passes it to its model is consult's concern. Listed as a follow-up should the cold docs grow.
- **`HARNESS_SCRATCH_PATHS` lists only Claude's file:** not changed. No Codex session in our runs wrote a project-local scratch file. An unknown path is still reported, just without the "usually benign" note.
- **#1809 and #1802 lessons contradict each other on the cloud-config umask fix:** changed. Each entry now notes in one clause that this PR set the precondition with `chmodSync`.
- **Uncommitted `codev/team/messages.md`:** confirmed out of the PR. It is Tower's message log in this worktree, never staged.
