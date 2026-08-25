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

## Dev-approval — APPROVED (2026-08-24)

Amr approved via VS Code ("Approve the dev review gate for 1534, please pass it to the builder").
Honest evidence note (per architect): unit + source verification done; deck script handed to
owner 5 days ago, NO deck-run result relayed back; gate approved on his word — do NOT write
"deck-verified" anywhere. Recorded that framing in the review's Test Results section.

## Review phase (2026-08-24)

Rebase check (architect flagged 5-day drift): origin/main advanced 10 commits since branch cut,
ZERO overlap with my files (main touched other projects' state, codev/resources/arch.md,
codev/reviews, README). Rebased onto origin/main cleanly, no conflicts. Reported trivial to
architect.

Wrote `codev/reviews/1534-vscode-forward-hunk-press-erro.md` (Summary / Files / Commits / Test
Results / Architecture Updates / Lessons Learned Updates / Follow-ups). Arch: no changes (local
bug fix, no boundary/contract/system-shape fact). Lessons: routed ONE cold entry to
lessons-learned.md Debugging section ("misleading instrument = stale/parallel model" +
two-models-drift + deletion-only structural mismatch + the textEditorDiffInformation proposed-API
ceiling on direction c). Next: commit review+lesson, push, gh pr create (body = review file),
porch done --pr, then porch runs CMAP once → pr gate.

## CMAP iter1 → REQUEST_CHANGES ×2 (Codex, Claude); Gemini APPROVE

Real finding (HIGH confidence, both): routing BOTH the press verbs and Cmd+K H through
symbol-first `resolveCursorRef` silently broadened `forward-hunk` from the exact hunk to the
whole enclosing symbol on an ordinary in-function edit (the most common press path), contradicting
the plan's explicit regression promise. Also: review missing template-required "How to Test
Locally"; minor rename-edge note.

Resolved (this is genuinely correct + realigns with the plan's own promise, so fixed rather than
just disclosed):
- Split precedence: new pure `resolveHunkFirstRef` (hunk → symbol → file) for the two press verbs
  (`resolvePressCursorRef`); Cmd+K H keeps symbol-first via `resolveCursorContextRef`
  (`resolveCursorRef`). Both share the fresh re-parse. Deletion-only fix unaffected (no hunk →
  degrades).
- This departs from the architect kickoff's literal "symbol→hunk→file" shorthand for direction
  (a) — disclosed prominently in the review's "Things to Look At During PR Review" + flagged to
  the architect for Amr's confirmation; one-line flip if he wanted symbol-first.
- Pinned both directions with tests (press-cursor-ref + diff-inject-ref). Added "How to Test
  Locally" section; strengthened rename-edge note. Suite now 887 passed (was 882), tsc clean.
Re-running CMAP on the fixed code before the gate.

## CMAP iter2 (fixed code) → Gemini APPROVE, Codex APPROVE, Claude COMMENT

Precedence split cleared both REQUEST_CHANGES. Claude COMMENT flagged two stale doc comments
(module header + hunkAnchor still said "symbol→hunk→file") — fixed, comment-only. porch next →
pr gate pending with all-approve/comment.

## pr gate — APPROVED (2026-08-25) & MERGED

Amr approved via VS Code ("Approve the PR review gate for 1534"). Approved AS-IS — hunk-first
precedence for the press verbs stands; he was shown the concrete example (3-line change vs the
1,416-line activate()) and did not take the flip. Ran `porch approve 1534 pr` (last branch write),
then FULL FREEZE per architect (shared-GH-identity branch protection → main architect admin-merges
on attested provenance; I do not merge / --admin).

Merge landed: PR #1550 MERGED at 02:05:37Z, merge commit 93874894d, two parents (ca4e4ce +
cafc1a1) — true merge, not squash. Verified via `gh pr view 1550`. Ran `porch done 1534 --merged
1550`; porch status = complete. Skipped porch's residual "merge the PR" task (already merged).
Issue-close and cleanup are the architect's, not mine.

Deck confirmation: never relayed; evidence record stayed honest end-to-end (unit + source
verified, deck script handed to owner, NO "deck-verified" claim). PROJECT COMPLETE.
