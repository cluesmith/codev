# pir-1414 — SD+ Automatic diff press → builder's first file diff (dial-ready)

Issue #1414. PIR, strict mode. Builds on #1404 (merged, PR #1415).

## Plan phase (2026-08-12)

Investigated the diff/relay path end to end:
- `BuilderAction.resolveVerb` Automatic branch fires `phaseArtifactVerb(b)`, which
  returns `view-diff` for implement/review/verify + dev-approval/pr → aggregate editor.
- `codev.diffFirstFile` → `navigateDiffToFirst` opens the first per-file diff AND seeds
  dial nav, but takes no builder id (resolves builder from active editor / `lastPosition`);
  fired cold it no-ops.
- No verb today means "open builder X's first file diff".

Plan: add `codev.openBuilderDiffFirstFile` (builder-id-scoped) in vscode by teaching
`resolveDiffContext` an optional explicit seed + `navigateBuilderDiffToFirst`; expose relay
verb `open-diff-first`; remap the Automatic `view-diff` result to `open-diff-first` in
`BuilderAction.resolveVerb` only (leave `phaseArtifactVerb`/`zoomInVerb`/`reviewMode` intact).
Explicit View Diff PI option stays aggregate. No types/server change (verb is a free wire
string; server relay is a passthrough).

Architect scoping received: (1) plan explicitly for the unanswered "verify first" hardware
question at dev-approval; (2) scope = vscode verb + Automatic diff branch; (3) bridge/canvas
from #1420/#1424/#1425 NOT in scope; (4) route plan to architect before plan-approval; (5)
stay in my worktree (pir-1425 live deck symlink etc. protected).

The zoom-in touch-strip path likely shares the aggregate-open behavior — deferred as a
possible follow-up pending the hardware finding; will route to architect, not self-expand.

Plan written to `codev/plans/1414-stream-deck-sd-automatic-diff-.md`. Awaiting plan-approval.
