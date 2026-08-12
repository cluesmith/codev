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

## Plan revision 2 (2026-08-12) — scope expanded (owner-approved)

Owner (Amr) approved widening scope after reviewing a mockup: adopt VS Code's Builders-sidebar
TWO-AXIS model on the deck face.
- Colour = state severity (blocked=warning yellow #cca700, waiting=info blue #3794ff [optional
  fast-follow], active=green #73c991) — mirrors builder-row.ts BUILDER_STATE_GLYPH tokens.
- Icon = gate (blocked): book/checklist/code/git-pull-request/verified, mirrors gateIconFor;
  bolt otherwise. Codicon path data inlined (MIT), not a new dep.
- Labels now SHORT (Spec/Plan/Dev/PR/Verify; phases Specify..Verified) — colour+icon carry the
  blocked-vs-working distinction, so plan-approval (yellow checklist "Plan") ≠ plan phase (green
  bolt "Plan") with no qualifier word. This resolves the label-collision worry Amr raised.

Maps twinned in face.ts with sync-notes (apps can't cross-import; same pattern as overview.ts
GATE_LABELS). Boundaries intact: only BuilderAction.renderTo changes; press/rotate + #1429
resolveVerb untouched; no wire/types/server change.

Flagged to architect: (1) scope expansion for cohort awareness (air-1411 also on streamdeck);
(2) verify-approval press-path gap in phaseArtifactVerb (left untouched, out of scope).
Mockup: https://claude.ai/code/artifact/450b5b24-66d2-42e3-8db2-992cc09eda18
Recommitted; gate still plan-approval pending → Amr.

## Plan APPROVED by architect (2026-08-12)

Architect ratified: ship blocked/active in v1, defer waiting (strict-superset follow-up).
Two additions recorded in the REVIEW artifact (seeded now, not the plan):
1. Twinned-vocabulary maps (face.ts ↔ builder-row.ts) → candidate for a shared home
   (single-source-of-truth vs apps-can't-cross-import). Co-flagged by main. Humans to weigh; NOT
   implemented in #1428.
2. verify-approval press-path gap filed as #1431 (BUGFIX, after this merge) — referenced in
   review lessons.
Plan-approval gate now to Amr.
