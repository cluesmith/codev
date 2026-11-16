# air-1900 — porch skip-phase: drop one plan phase after implement starts

**Protocol**: AIR (strict). Issue #1900. Worktree `.builders/air-1900`.

## Problem
Porch copies the plan's phases into `status.yaml` once, on entering `implement`, and never
re-reads them. An adopter's owner dropped the last plan phase after the earlier ones merged;
porch still listed it as pending, so review was unreachable. `porch rollback <id> implement`
re-extracts, but resets every phase.

## Decision: option 1 only (skip-phase), not the re-sync command
The issue said option 1 covers the reported case and is smaller. Re-sync (option 2) would need
reconciliation rules for reorder/rename. It also has to keep the human gate, because it too
changes an approved plan. Left out.

## Design
- New plan-phase status `skipped`, with `skip_reason` + `skipped_at` stored on the phase itself.
  The reason lives next to the phase it explains, not in the loose `context` map that
  `verify --skip` uses.
- `isPlanPhaseSettled()` (complete | skipped) drives navigation: `getCurrentPlanPhase`,
  `allPlanPhasesComplete`, `advancePlanPhase`.
- **Latent bug fixed along the way:** `advancePlanPhase` marked `phaseIndex + 1` in_progress
  blindly. With skip in the mix, that would resurrect a skipped middle phase. It now steps to
  the next *unsettled* phase after the current one.
- `porch skip-phase <id> <plan-phase> --reason "..." --a-human-explicitly-approved-this`:
  refuses without the flag (throws, writes nothing), without a reason, outside a
  per_plan_phase phase, on unknown/complete/already-skipped phases. Skipping the current
  phase resets iteration/build_complete (that in-flight cycle belonged to the dropped phase).
  Skipping the last unsettled phase moves to `review`, the same target as the normal
  all-phases-complete advance (see the surprise below for why not `getNextPhase`).
- No context-refresh boundary fires on a skip. It is a manual command, not a `porch next`
  transition, and a missed refresh costs context only (Spec 1470's asymmetric-cost rule).
- Tower overview progress counts skipped as settled.
- Skill docs updated in all four copies (`.claude`/`.codex` × instance/skeleton).

## Surprise: the unit tests passed, the real CLI run didn't
The first CLI run against a throwaway SPIR project left `phase: implement` after skipping the
last phase. `normalizePhase` maps a per_plan_phase phase's `transition.on_complete` (implement
itself) to `next` and drops `on_all_phases_complete`. So `getNextPhase('implement')` loops
back to implement, which is why `handleVerifyApproved` hardcodes `'review'`. My hand-written
fixture had `next: 'review'` and hid it. Fix: target `'review'` like handleVerifyApproved
(comment says change them together). The test now copies the real
`codev-skeleton/protocols/spir/protocol.json` so the fixture can't drift.

End to end, against the built `bin/porch.js` with a bare remote: skip → `implement → review`;
`porch next` emits review tasks; `porch status` shows `⊘ phase_3: UI (skipped: <reason>)`.

## Full-suite run (porch done #1)
One failure: `src/__tests__/skill-refresh.test.ts`. Editing a shipped skill (porch SKILL.md)
requires regenerating `src/lib/shipped-skill-hashes.ts`
(`pnpm --filter @cluesmith/codev generate-skill-hashes`). Regenerated. I found the failing
file in vitest's results cache (`node_modules/.vite/vitest/*/results.json`), not by
re-running the suite; porch's check output truncates to `...`. Porch's strict check re-runs
the full suite to advance, so that's a second full run, which can't be avoided without
bypassing a check.

## Full-suite run (porch done #2): load-induced failures, not mine
Build ✓. Tests ✗ in two files that passed in run #1 and don't touch porch:
`src/__tests__/bootstrap-docs.test.ts` (93s) and
`src/__tests__/bugfix-1113-integration-base.test.ts` (32s). Load average was ~20 during the
run. Run alone, both pass (65/65). A third full run is a load decision for the owner, so I
asked the architect instead of re-running or skip-annotating whole healthy files.
Architect ruled option (a): re-run porch done once. Never skip-annotate: the owner ruled
that flaky pre-existing tests are reported and left running. If it fails again on timeouts
only, stop and report; name the flaky files in the PR body.

## PR #1908 — CMAP round 1 (codex, claude): both REQUEST_CHANGES, same cause
Branch was 27 commits behind main, with conflicts in `porch/index.ts` and all four
porch SKILL.md copies. Consult project auto-detect failed first ("Multiple projects found");
re-ran with `--issue 1900`.
- Merged origin/main (merge commit, no rebase). Main (#1902) moved the CLI help into
  `printHelp()`, so my two help lines were re-added there; checked via
  `porch skip-phase --help`. Main rewrote SKILL.md, so I took main's version and re-applied my
  section and rule to its new structure (all four copies identical). Regenerated skill hashes.
- Non-blocking, fixed in place: `skipPlanPhase` now hands in_progress forward only (symmetric
  with `advancePlanPhase`); added an overview progress test for skipped-as-settled; the skill
  doc asks for a one-line reason (yaml folds long lines).
- Rebutted: firing an `enter:review` refresh on skip. Refresh is porch-chosen at `porch next`
  transitions, and builders must not self-invoke /builder-refresh. A human runs skip-phase.
- Not done (scope): surfacing `on_all_phases_complete` through `normalizePhase` so neither
  site hardcodes `'review'`. It would touch the working handleVerifyApproved refresh path.
Locally: typecheck clean; touched files 281/281. CI on GitHub runs the full suite (no local
full run after the merge, given the owner's load concern).

## CMAP round 2 (merged branch): codex APPROVE, claude APPROVE
Claude reported all 8 CI checks green on e02debe8. Its non-blocking polish, fixed in place:
- Skill doc: run skip-phase from the builder's worktree. Porch commits and pushes
  status.yaml in whatever checkout it runs from, so from the main root it could land on main.
- Guard: refuse (writing nothing) when the protocol has no `review` phase, instead of
  writing a phase `next` would read as "protocol complete".
- Skipping a *pending* current phase now hands in_progress forward too.
- The `porch status` "DO NOT start <next>" banner no longer names a skipped phase.
- A bare `porch skip-phase <id> <phase>` reports the missing human flag before the
  missing reason.
Not done: a unit test of the CLI arg branch (covered by the manual CLI run), and rejecting
newlines in --reason (the doc covers it; claude traced that folding is harmless).
Touched tests 65/65, typecheck clean, hashes regenerated.

## PR gate requested (porch gate, not porch done)
The architect directed `porch gate 1900`: no local e2e run, at the owner's request. Two
side effects worth knowing:
- `porch gate` doesn't set `pr_ready_for_human`; `porch done` does. So the dashboard's
  "PR waiting on a human" signal may not show this PR.
- Porch never reads a check's `optional` flag, and `approve()` runs every check in the
  current phase. So `porch approve 1900 pr` will run `npm run test:e2e || echo skipped`
  locally: it can't fail, but it does load the machine. Flagged to the architect.
Waiting on the human pr-gate decision.

## Architect integration review (codex REQUEST_CHANGES, claude APPROVE): fold-ins
1. `porch status` after skipping the last phase: the plan list is no longer hidden once the
   project leaves implement if any phase was skipped. `⊘ phase_3: UI (skipped: <reason>)`
   shows in review. Checked with the real CLI.
2. Context-refresh boundaries: **chose the printed line, not recording.** A refresh TASK can
   only come from `porch next` at the transition. Recording the boundary in skip-phase would
   mark it consumed with no task emitted, and the next normal-path `porch next` would
   acknowledge it, silently swallowing the refresh. Emitting it properly needs new
   pending-refresh state plus a hook in `next()`, a change to Spec 1470's transition-keyed,
   at-most-once design, which is not small. So skip-phase computes the boundary it crossed
   (`enter:review`, or `plan-phase:<next>` when the current phase was skipped). When
   `shouldRefresh` says it's due, it prints: run /builder-refresh, then porch next.
3. `getNextPlanPhase` is now skip-aware via a shared `nextUnsettledIndex`, used by
   getNextPlanPhase, advancePlanPhase and skipPlanPhase (one rule, three call sites). The
   status banner uses getNextPlanPhase.
4. Card label vs progress: both now treat a skipped phase as **dropped from the plan**,
   counted in neither n/m nor progress numerator/denominator. That is more truthful than
   "settled": [in_progress, pending, skipped] reads 50%, not 63%. Changed overview progress
   and BuilderCard.
5. Removed the unused `isPlanPhaseComplete` import; added skip-phase to arch.md's porch
   command list; the skill says the builder runs it after the architect relays the human's
   decision (matching `approve`).
6. Hardcoded 'review': left as is, for the architect to file. The schema makes
   `on_all_phases_complete` optional with no default, and next.test.ts fixtures omit it, so
   reading it means either inventing a default (a fallback) or throwing (breaks fixtures).
   That's a design decision, not a few lines.
Targeted tests only: porch/overview/skill-refresh/1470-status/1902-help 310/310, web
BuilderCard 13/13, both typechecks clean. No local e2e.
