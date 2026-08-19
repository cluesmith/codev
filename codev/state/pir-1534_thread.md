# Builder pir-1534 — vscode forward-hunk press error (#1534)

## Plan phase (2026-08-20)

Investigated all pointers in the issue + architect kickoff against source in this worktree.
Every pointer verified true on today's branch:

- Two press sites test the cursor against `entry.hunks` and error with "place the cursor in a
  changed hunk": `extension.ts:1296-1300` (forwardCurrentHunkToBuilder) and
  `feedback.ts:66-70` (hunkAnchor / feedbackHunk).
- `entry.hunks` is parsed once at diff-open — `view-diff.ts:388-402` (viewDiff) and
  `:467-478` (registerFileInjectSession) — no refresh hook exists (grep-confirmed the only
  parseHunkRanges/parseUnifiedDiff callers are those two).
- Rotation uses VS Code's live compare-editor model (`command-relay.ts:54-55`); press uses our
  git snapshot. Deletion-only hunks yield no new-side range in parseHunkRanges (documented at
  `diff-inject-ref.ts:78-84`) → rotate-to-deletion + press = guaranteed error.
- Keyboard path Cmd+K H already degrades symbol→hunk→file via `resolveCursorRef`
  (`diff-inject-ref.ts:289`, called `extension.ts:1324`) and never errors.

**Chosen approach:** combine architect directions (a) resolveCursorRef fallback + (b) fresh
re-parse at press time, behind one shared helper `commands/press-cursor-ref.ts`. Explicitly NOT
(c) full model unification — noted as residual/follow-up. Reasoning argued in the plan (a-alone
masks staleness, b-alone still errors on deletion-only, together they close the observed
failure). Entry gains `baseRef` + `worktreePath` (both in scope at all construction sites) so a
press can re-run `git diff -M --unified=3 <baseRef> -- <relPath>`.

**Scope confirmed clean:** `DiffInjectSessionEntry` is local to apps/vscode (NOT in codev-types)
— grep-confirmed no packages/ reference. No Tower, no apps/streamdeck. Package filter is
`codev-vscode` (not scoped).

Plan written to `codev/plans/1534-vscode-forward-hunk-press-erro.md`. Awaiting plan-approval
gate (Amr owns all 3 gates; architect relays, I run `porch approve`).
