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

Next: PR phase (porch runs the gemini+codex consultation there). Will note here when the PR is
up for the architect's streamdeck-link hardware check.
