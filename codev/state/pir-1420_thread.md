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
