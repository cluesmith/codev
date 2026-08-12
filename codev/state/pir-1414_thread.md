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

## Plan revised (main's addendum, no re-gate)

Pinned the empty-diff / no-worktree / falsy-id cases on the seeded path as a defined,
user-visible status-bar flash with explicit tests (not silent no-op / throw). Commit 0993d3a85.

## Plan-approval APPROVED (2026-08-12)

Streamdeck architect approved, no revisions. Amr typed the gate. Advanced to implement.

## Implement phase (2026-08-12)

Implemented exactly to plan:
- `apps/vscode/src/commands/diff-nav.ts`: `resolveDiffContext` gained an optional `seed`
  (replaces only step-1 editor resolution); new `navigateBuilderDiffToFirst(builderId, deps)`
  — falsy id / no-worktree / empty-list all flash; happy path opens file 0 + seeds anchor.
- `apps/vscode/src/extension.ts`: registered `codev.openBuilderDiffFirstFile` (extractBuilderId arg).
- `apps/vscode/src/command-relay.ts`: added `'open-diff-first' → codev.openBuilderDiffFirstFile`.
- `apps/streamdeck/src/actions.ts`: `BuilderAction.resolveVerb` remaps ONLY the Automatic
  `view-diff` result to `open-diff-first`; explicit View Diff PI verb still verbatim.
- Tests: diff-nav.test.ts (+4: happy/empty-flash/no-worktree-flash/falsy-id), command-relay.test.ts
  (+1 verb map), actions.test.ts (+2 Automatic→open-diff-first, explicit view-diff verbatim).

Verification (fresh worktree needed codev-types + codev-sdk built first):
- vscode check-types ✓; vscode test:unit ✓ 812/68 files.
- streamdeck check-types ✓; streamdeck test ✓ 86/5 files.

No types/server change (verb is a free wire string; server relay is a passthrough).
The verify-first hardware question + zoom-in follow-up decision happen at the dev-approval gate.
Awaiting dev-approval (hardware SD+ session).

## dev-approval session (2026-08-12)

Owner reported the aggregate still opened. Screenshot confirmed the aggregate editor
("Reviewing #1414 (main ↔ HEAD) (10 files)"). Root cause: `streamdeck list` showed the deck
linked to pir-1425's bundle (old actions.ts, no remap) → deck fired old `view-diff`. NOT a code
issue — this branch's built bundle contains open-diff-first (verified grep). So a clean hardware
confirmation of the NEW first-file behavior was NOT captured in-session; the verify-first
question + zoom-in follow-up remain open. Owner approved dev-approval anyway.

Captured this as a COLD lesson (dual-artifact hardware-testing trap; sibling worktree's live
streamdeck link serves stale behavior). Advanced to review.

## review phase (2026-08-12)

Wrote codev/reviews/1414-...md (Summary/Files/Commits/Tests/Arch=no HOT/Lessons=1 COLD/Things
to look at incl. residual hardware check + zoom-in follow-up/How to test). Opening PR, recording
with porch, then porch done → single 3-way consult → pr gate.

## pr gate (2026-08-12)

PR #1429 open + recorded. 3-way consult all APPROVE (gemini/codex/claude, zero KEY_ISSUES).
pr gate PENDING. Architect: DO NOT merge on CMAP alone — PR #1429 stays open until a short
hardware re-check with BOTH halves on-branch (deck bundle AND the branch's vscode extension;
with the OLD extension the new open-diff-first verb isn't in VERB_COMMANDS → press silently
no-ops, worse than the aggregate). Architect arranging the re-check with Amr. Holding. Merge
word comes AFTER hardware confirmation + porch gate_status: approved.

## MERGE AUTHORIZED (2026-08-12)

Hardware re-check PASSED (both halves on-branch): Automatic press → file 1 per-file mode,
dials step from there. Amr authorized merge (relayed by architect). Verify-first ANSWERED: old
build's dials DID navigate after aggregate open → polish, NOT broken-flow; NO zoom-in follow-up.
Recorded in review. Running porch approve (human flag, per architect's explicit instruction) →
gh pr merge 1429 --merge (report if review-required blocks; main admin-merges on authorized word).
Do NOT clean worktree post-merge — live deck symlink now points into .builders/pir-1414.
