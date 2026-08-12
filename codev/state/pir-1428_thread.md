# pir-1428 thread — Stream Deck Builder Action key face

## Plan phase (2026-08-12)

Issue #1428: Builder Action key illegible — raw wire strings pushed through `setTitle`
paint over the full-bleed bolt PNG. Three symptoms, one root cause (two stacked layers).

**Root cause confirmed** at `apps/streamdeck/src/actions.ts:164-169`. `issueId` is a plain
`string` on the wire (`packages/types/src/api.ts:143`) — the "#1,414" comma is the bolt edge
bleeding through, not a formatter.

**Approach**: render the whole face in-plugin as an SVG string via `setImage` (SDK d.ts
confirms `setImage` accepts an SVG string — zero new deps, no canvas/native module, keeps the
single esbuild bundle). Icon in an upper zone, reserved text band below (number line + label).
Plus a plugin-local wire-id → display-label map keyed on canonical `blockedGate` /
`protocolPhase` (gate beats phase), NOT `b.blocked` (server human label). New pure module
`src/face.ts` (mirrors `nav/cursor.ts` — SDK-free, unit-testable).

**Only `BuilderAction.renderTo` changes** in actions.ts. Press/rotate (`resolveVerb`,
`phaseArtifactVerb`, #1429/#1404/#1414 logic) untouched. No wire/types/server change.

**Architect asks (satisfied in plan)**: full id→label table (9 ids) + face-layout mock both
in the plan. Routed to architect before plan-approval gate.

**Cautions honored**: not touching .builders/pir-1414 (live deck symlink) or sibling
worktrees; air-1411 touches streamdeck imports only — will re-resolve at merge if churn.

Plan written to `codev/plans/1428-stream-deck-builder-action-key.md`. Awaiting plan-approval.

## Plan revision 1 (2026-08-12) — architect review

Approved with two revisions, both applied:
1. Label map: porch's TERMINAL phase id is `verified` (next.ts:204; `complete` migrates to it,
   state.ts:135-140) — the exact state the owner's photo showed. Added `verified`→'Verified' and
   `complete`→'Verified'; changed `verify`→'Verify' (in-progress, not done). Map is now 11 rows.
   Verified the porch source myself before editing.
2. Added risk + hardware pre-flight: a profile-pinned custom image makes `setImage` a silent
   no-op (SDK: "image can only be set … when the user has not specified a custom image"). Check
   the #1404-revved profile first if the face doesn't render.

Rest approved as written (face.ts pure module, SVG non-overlap, canonical-id keying, setTitle('')).
Recommitted; gate goes to Amr.
