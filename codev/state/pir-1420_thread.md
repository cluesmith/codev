# Builder thread — pir-1420

Issue #1420: Stream Deck hands-free comment submit/cancel (dictation). PIR protocol, strict mode.

## Scope (bridge-extension lane only)
This lane is the bridge half of the agreed main+streamdeck split: requirements 1 & 2 only —
add the `composer-open-or-submit` canvas command (canvas-side resolution from `composingLine`,
never discards a draft) to the closed vocabulary, allowlists, and action map. Deck remapping
(req 3) and touchstrip (req 4) are streamdeck's follow-on lane, after this merges. No
`apps/streamdeck/` change here.

## Plan phase (iter 1) — done, awaiting plan-approval gate
Wrote `codev/plans/1420-stream-deck-hands-free-comment.md`.

Key findings from codebase investigation:
- The empty-draft ruling is ALREADY satisfied: `CommentComposer.submit()` trims + returns early on
  empty (`CommentComposer.tsx:72-76`), leaving the composer mounted with draft intact. So routing
  the open case through `submit()` inherits the guard — never writes empty, never discards.
- Reading `composingLine` in the action is safe: `canvasActions` + `runCanvasCommandRef.current`
  rebuilt every render (`ArtifactCanvas.tsx:996-1001`); `composer-cancel` already reads it directly.
- **FOUR** allowlists guard the union, not the three the issue's req 2 names. The extra one is
  Tower's own relay validation `packages/codev/src/agent-farm/servers/canvas-relay.ts:68-83` —
  without it Tower answers `invalid-request` and the command never reaches the canvas. Flagged in
  the plan. All four are `satisfies`-guarded, so a miss is a compile error.
- Fifth touch: `packages/types/type-tests/canvas-command.type-test.ts` CLASSIFICATION map
  (`satisfies Record<CanvasCommand,…>`) needs the new member as 'non-traversal'.
- No codev-skeleton mirror (this is product code under packages/apps, not framework template).

Plan has a dedicated "Command semantics" section to route to the streamdeck architect for review
before the plan gate (per the process ruling in the issue comments).

Next: notify architect + streamdeck architect; wait at plan-approval gate.

## Implement phase (iter 1) — done, verifying
plan-approval approved by human. Implemented all five code locations + tests (commit 3c719dac6):
- types union + doc, type-test CLASSIFICATION map, Tower relay allowlist, host allowlist, canvas
  action map (`composer-open-or-submit`).
- Tests: canvas open/submit/empty-no-op via remote channel; relay round-trip + count-rejection.

Green: codev 4850 passed / 48 skipped; artifact-canvas 176; types build + type-tests; vscode
check-types. All exit 0.

CMAP (impl, pir): codex APPROVE, claude APPROVE, gemini REQUEST_CHANGES. Gemini's only blocker is
"missing review artifact" — a FALSE POSITIVE: PIR implement.md forbids writing the review file this
phase (it's the review phase's job). Claude flagged the same and confirmed it's not a defect.

Applied two non-blocking CMAP nits from claude:
- Strengthened the empty-draft test to assert NO re-anchor (block-next between presses, assert the
  composer aria-label still names the original line — the prior test would pass even under wrong
  branch resolution).
- Updated stale CommandAdapter.ts prose to mention the context-aware member (plan flagged optional).

Also confirmed (claude): the edit composer shares composingLine, so a press mid-edit routes to
submit-the-edit, never a draft-discarding re-anchor. Worth exercising at the dev gate.

Next: re-run canvas tests after nits, commit, `porch done`, wait at dev-approval gate.

## Review phase (iter 1) — writing retrospective, opening PR
dev-approval approved by human. Wrote codev/reviews/1420-stream-deck-hands-free-comment.md.
No arch/lessons governance-file changes (one member added to an already-guarded closed vocabulary;
the four satisfies-guards already enforce the invariant — nothing rises to hot-tier). Sections
explain why, per protocol.
Next: commit review, push, open PR, `porch done --pr`, then `porch done` (porch runs 3-way consult
once), notify architect, wait at pr gate.

PR #1424 opened (branch builder/pir-1420). Porch ran the single 3-way consult pass.
Verdicts: gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES.

Codex (REAL, accepted): `Fixes #1420` would auto-close the issue on merge, but this PR is only the
bridge lane (reqs 1,2,5) — reqs 3-4 (deck remap, touchstrip) remain for streamdeck's follow-on. Fixed:
review + PR body now `Refs #1420` (commit 1c14cb651). Escalated to human at pr gate: they decide
whether #1420 should close with this merge (if follow-on rides its own issue/#1410) or stay open.
Rebuttal written (1420-review-iter1-rebuttals.md, committed 2939886d8). Claude's non-blocking notes
addressed in rebuttal, no code change.

Now at PR GATE — waiting for human to merge on GitHub. Do NOT self-merge or self-approve.
