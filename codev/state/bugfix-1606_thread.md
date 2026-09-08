# bugfix-1606 — streamdeck: Review dials silently dead for BUGFIX/AIR phases

Issue #1606. Protocol: BUGFIX (strict). Branch: builder/bugfix-1606.

## INVESTIGATE — findings (root cause confirmed, no code written)

### Bug
Stream Deck **Review dials** (Files/Headings, Changes/Blocks) silently no-op for a
BUGFIX builder's whole working life (`investigate`, `fix`) and for AIR during the `pr`
phase (until the pr *gate* is requested). Reads as "diff dials sometimes work, sometimes
not" — the intermittency is protocol identity, not flakiness.

### Root cause
`phaseArtifactVerb` (`apps/streamdeck/src/actions.ts:527`) has a hardcoded phase/gate
vocabulary written against SPIR/PIR: phases `specify|plan|implement|review|verify`, gates
`spec-approval|plan-approval|dev-approval|pr|verify-approval`. `reviewMode`
(`actions.ts:558`) derives from it: `open-spec/open-plan → canvas`, `view-diff → diff`,
`undefined → none`.

Checked each bundled `protocol.json` (`phases[].id`):
- SPIR `specify/plan/implement/review/verify`, PIR `plan/implement/review` — covered.
- AIR `implement/pr` — the `pr` **phase** id is unrecognized → `none` until `blockedGate==='pr'`.
- BUGFIX `investigate/fix/pr` — `investigate`/`fix` unrecognized → `reviewMode==='none'`
  for the builder's whole working life; dials only revive when blocked at the pr gate.
- `init`/no-status (soft/shell/task) → `none` (genuinely nothing to review).

In `none` mode `ReviewNav.onDialRotate/onDialDown/onTouchTap` all no-op (actions.ts:918-944).

### Compounding "lie"
`ReviewNav.renderTo` label ternary (actions.ts:906-909) has only canvas vs diff branches;
`none` falls into the diff branch and renders `Files · send` while every gesture no-ops —
violates the dial's "a gesture is never a surprise" contract.

### Metadata-vs-list decision (issue's stated preference)
Issue prefers deriving mode from `protocol.json` phase metadata over extending a name list.
Verified: `protocol.json` phases carry only `id/name/type/steps/transition/gate` — **no field
expresses review mode**. The SDK's `packages/sdk/src/phase-grouping.ts` `PHASE_TO_STAGE`
folds `investigate → plan`, which for review-mode purposes would wrongly imply **canvas**
(BUGFIX has no spec/plan doc), and it's used by the VSCode Builders tree — can't repurpose
without blast radius. So per the issue's documented fallback ("if metadata can't express it,
extend the list and leave a registration note — the GATE_LABELS pattern"), I'll extend the
recognized diff-phase vocabulary with a registration note.

### Fix surface (well under 300 LOC; FIX phase)
1. Make the review dials resolve **diff** for phases `investigate`, `fix`, `pr`. Do it in
   `reviewMode` (the dial-specific resolver) — **not** in `phaseArtifactVerb** — so
   `zoomInVerb` (already `?? 'view-diff'`, so BUGFIX zoom already works) and `BuilderAction`
   auto-press (`?? 'open-terminal'`) are untouched. Keeping `phaseArtifactVerb` stable avoids
   changing the Builder Action key from open-terminal→open-diff-first during `investigate`
   (no diff yet) — out-of-scope blast radius the issue doesn't ask for. Add a registration note.
2. Honest `none` label: add a `none` branch in `renderTo` → `No review target` instead of
   the diff label.
3. Keep `init`/no-status → `none` (with the honest label).

Consumers verified: `reviewMode` also feeds `ScrollNav` (actions.ts:1080/1150) but those
only branch on `=== 'canvas'`; none→diff doesn't change ScrollNav behavior (both non-canvas).

### Regression test
`apps/streamdeck/src/__tests__/actions.test.ts`: BUGFIX `investigate` builder →
`reviewMode==='diff'` and dial gestures emit diff verbs (fails today: 'none', no verbs);
`fix`/`pr` phases → 'diff'; `none`-mode label renders `No review target` not `Files · send`.

### Shipping note
`apps/streamdeck` change → plugin version bump + Elgato resubmission (~4-10 working days).
Flagged in issue; batching decision is the architect's.

Signal: PHASE_COMPLETE.

## FIX — implemented

Architect approved the scoped approach (registered diff-phase set in `reviewMode`,
`phaseArtifactVerb` untouched, trade-off flagged in PR body). Release is HELD — no version
bump (fix merges to main, ships later in a batched Elgato resubmission).

Changes (2 files, ~89 lines incl. tests):
- `apps/streamdeck/src/actions.ts`:
  - Added `DIFF_REVIEW_PHASES = {investigate, fix, pr}` with a GATE_LABELS-style registration
    note; `reviewMode` now returns `diff` for these phases (after the existing verb-based
    canvas/diff resolution, so gates still win). `phaseArtifactVerb` untouched → Builder Action
    key (open-terminal) and Zoom (view-diff) behavior unchanged.
  - `ReviewNav.renderTo`: `none` mode now renders `No review target` instead of borrowing the
    diff label (`Files · send`). Converted the label ternary to if/else.
- `apps/streamdeck/src/__tests__/actions.test.ts`: added reviewMode coverage for
  investigate/fix/pr → diff and init/'' → none; a phaseArtifactVerb guard documenting the
  deliberate split; a behavioral test (BUGFIX investigate dials emit diff verbs); a legibility
  test (none-mode strip says `No review target`, not the lie).

Verification (from the worktree, apps/streamdeck):
- Full suite: 246 passed (10 files).
- Regression check: reverted both source edits → the 3 behavioral/mode/label tests FAIL
  (`none`→ expected `diff`; strip `Files · send`→ expected `No review target`); restored → pass.
- `tsc --noEmit` exit 0 (after building the codev-sdk workspace dep, which had no dist here),
  `npm run build` exit 0.

No skeleton mirror needed (apps/ is app code, single copy; not a codev/↔codev-skeleton framework file).

## PR — up

PR #1607 opened: https://github.com/cluesmith/codev/pull/1607 (Fixes #1606). Body carries the
metadata-vs-registered-list trade-off note per the architect's call.

CMAP dispatched (gemini/codex/claude, `--type pr`). Note: consult auto-detect failed with
"Multiple projects found" from this worktree — had to pass `--project-id bugfix-1606` explicitly.
Awaiting three verdicts before notifying the architect + running `porch done` (fires the pr gate).

**@architect: hardware check** — once you approve, this is ready for your streamdeck-link
verification: select a BUGFIX builder (investigate/fix) and confirm the Files/Changes dials now
step the diff and the strip no longer reads `Files · send` when there's nothing to review.

## CMAP verdicts (3/3)

- **gemini: APPROVE** (HIGH) — no issues.
- **codex: APPROVE** (HIGH) — no issues.
- **claude: COMMENT** (HIGH) — three points, all addressed or triaged:
  1. Plugin README stale on the dial vocabulary → **fixed** (commit f73e3f8): README now lists
     the BUGFIX/AIR investigate/fix/pr phases and the honest `No review target` state.
  2. `DIFF_REVIEW_PHASES` comment attributed `investigate` to BUGFIX alone (RESEARCH uses it
     too) → **fixed** (same commit): registered by name, note corrected.
  3. MAINTAIN `maintain` / EXPERIMENT `execute`,`analyze` / SPIKE `spike` still resolve to
     `none` (dead dials on a diff, though the honest label now stops them lying). Claude flags
     this as an **architect scope call, not a blocker** — out of #1606's investigate/fix/pr
     scope. **Raised to the architect** in the gate notification; recommend a follow-up issue
     rather than expanding this PR.

Non-substantial changes (docs + comment, zero behavior change), so CMAP was not re-run.
Sent the single gate notification with all three verdicts; ran `porch done` to fire the pr gate.

## At the pr gate — holding (2026-09-04)

Architect review of PR #1607: **APPROVE**. Rulings:
- **Scope call decided**: PR stays as-is. The MAINTAIN/EXPERIMENT/SPIKE phase registrations
  (Claude's point 3) are now **follow-up issue #1609** (architect's lane) — do NOT expand this PR.
- The `investigate`-by-id RESEARCH-nuance handling and the `phaseArtifactVerb` split note both
  confirmed correct.
- The **pr gate word rests with the owner** (a CMAP/architect APPROVE is not gate authorization).
  The owner's decision and the physical-deck hardware check (once he links the deck to this
  worktree build) are both in motion. Architect: "hold at the gate."

**Status: holding at the pr gate. Not running `porch approve` — awaiting the owner's explicit
gate decision.** Nothing actionable for me until then.

## Owner scope correction: pr-only (2026-09-04, at the gate)

Owner ruled directly: **only the `pr` phase should be diffable, NOT `investigate`/`fix`** — those
are work-in-progress (partial/no diff yet), so they are not a review target. This supersedes the
issue #1606 Fix text (which had listed investigate/fix) and the architect's earlier "as-is" ruling.

Narrowed the fix:
- `DIFF_REVIEW_PHASES` = `{pr}` only; rewrote the note to record investigate/fix as deliberately
  EXCLUDED (owner ruling), so no future reader re-adds them.
- investigate/fix now resolve to `none` → inert dials with the honest `No review target` label.
  The value of the fix there is the honest label, not live dials.
- Tests: `pr` phase → diff (behavioral + unit); investigate/fix → none (behavioral + unit);
  guard + none-label tests updated. 248 pass; tsc + build clean.
- README + PR #1607 body updated to pr-only.

This is a real behavior change from the CMAP'd version (investigate/fix diff→none), but it's a
scope REDUCTION on the same mechanism the reviewers blessed. Notifying the architect; will offer
to re-run CMAP if they want. Awaiting the owner's gate word on the corrected PR.

## pr gate APPROVED + protocol advanced (2026-09-04 09:18)

Amr approved the pr gate via VS Code at 09:18 on the pr-only code head **dbc1fcc87** (architect
relayed it as `porch approve`, human-approved). The approval landing on the pr-only head also
authenticates the pr-only scope ruling.

Ran `porch done` → **PROTOCOL COMPLETE** (advanced to the verified/terminal state). Branch in sync
with origin.

**MERGE IS NOT MINE.** Architect instruction: the merge still needs Amr's explicit per-PR word
plus his admin bypass (branch protection); the architect handles it when Amr's words land. So I am
NOT running `gh pr merge` and NOT running `porch done` again (the post-merge step). **Holding.**
