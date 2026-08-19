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

## Plan-approval — APPROVED (2026-08-20)

Amr approved verbatim ("approve 1534"), degrade-to-whole-file default + (c)-as-follow-up both
approved. Architect confirmed the (c2) API constraint: `textEditorDiffInformation` is
PROPOSED-only (sole consumer = built-in git extension), so a marketplace extension can command
compare-editor navigation but cannot enumerate the change model — (c) only becomes clean in an
IDE-bundled build with a product.json grant. Record that in the review's residual note so the
follow-up issue is actionable.

## Implement phase (2026-08-20) — COMPLETE, at dev-approval gate

Implemented exactly as planned:
- `diff-inject-codelens.ts` — `DiffInjectSessionEntry` gains `baseRef` + `worktreePath`.
- `commands/press-cursor-ref.ts` (NEW) — `resolvePressCursorRef`: fresh single-file
  `git diff -M --unified=3 <baseRef> -- <relPath>` (fallback to frozen `entry.hunks` on git
  failure) + document symbols → the existing pure `resolveCursorRef` (symbol→hunk→file).
- `extension.ts` — both `forwardCurrentHunkToBuilder` AND `forwardCursorContextToBuilder`
  (Cmd+K H) route through the helper; honest fallback message replaces the misleading error.
- `feedback.ts` — `hunkAnchor` async via the helper; `feedbackHunk` awaits it.
- `view-diff.ts` — 3 construction sites pass baseRef + worktreePath.
- Tests: new `press-cursor-ref.test.ts` (fresh-parse-catches-stale, deletion-only→symbol,
  no-coverage→file, git-fail→frozen-fallback); feedback.test.ts +staleness +whole-file-fallback,
  with a deterministic node:child_process mock; 4 fixture files updated for the new fields.

Verification (from the worktree): `check-types` clean (tsc); `porch check 1534` → build ✓ +
tests ✓; full vitest suite 882 passed. NOTE: `pnpm test` (vscode-test/Electron integration
harness) can't spawn Electron in this sandbox (ENOENT) — that's an environment limit, not a
code failure; the unit tests run under `test:unit` (vitest) and porch's `tests` check passed.

Deck/physical-dial confirmation is the part I can't drive from the builder shell → routes to
the streamdeck architect / Amr at dev-approval.
