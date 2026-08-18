# spir-1470 — builder thread

## 2026-08-17 — Specify phase, orientation

Project: #1470 — automatic builder context refresh at porch phase boundaries.
Protocol: SPIR, strict mode. Spec did not pre-exist; writing it from the issue.

### What I found in the codebase before writing the spec

- **`afx refresh`** (was `afx reset`; renamed in #1489) lives at
  `packages/codev/src/agent-farm/commands/reset.ts` + `reset/{index,receipt,reorient,context,constants}.ts`.
  It is a *state machine over injected ports* with four named invariants (R1–R4) and a step log
  that tests assert over. Defaults: nonce marker inside `.builder-state.md`, `DEFAULT_MIN_BYTES=1000`,
  2s stability window, 300s receipt timeout, 1.5s quiet window, one ESC escalation.
- **Critical finding**: `afx refresh` *cannot* be self-invoked. It sends a save request and then
  polls for the receipt — but a builder running it is mid-turn, so it would never answer itself.
  The receipt + quiescence gates structurally require an external driver. This is the single fact
  that shapes the whole design: the builder-side path must be the *tail* of that machine
  (verify already-written state → assemble reorient → clear → re-entry), not the whole of it.
- **`/arch-save`** (Spec 1307) is the proven in-harness self-clear: write state → `afx send
  architect:<name> --raw '/clear'` → `afx send --delay 15 --raw '/arch-init <name>'`. Order there
  is clear-then-schedule; I think the auto path should invert it (schedule-then-clear) so a failed
  schedule aborts before anything destructive is queued.
- **Porch** is a pure planner (`packages/codev/src/commands/porch/`). `next.ts:185` is the
  dispatcher; gate-approved phase transitions happen at `next.ts:~295`, plan-phase advance inside
  `handleBuildVerify`. Those are the natural boundary hooks.
- `protocol.json` has no context-refresh key; `status.yaml` (`types.ts:ProjectState`) has no
  refresh record. Both need extending.

### Functional probe

Ran `afx send spir-1470 "..."` from inside my own worktree: **delivered**, and it surfaced
inside my running turn as `### [ARCHITECT INSTRUCTION | ...] ###`. Two facts fall out:

1. A builder *can* address itself — the re-entry send in the design is viable with no Tower change.
2. Self-sent messages are framed as **architect instructions**. The re-entry frame must announce
   itself as a context-refresh re-entry, or a refreshed builder will read its own re-orientation
   as an order from the architect.

`afx send --delay <seconds>` exists (Tower-side; its own help text says "dropped if Tower restarts").

## 2026-08-17 — Specify, iteration 1 review

Both reviewers returned REQUEST_CHANGES. Both were right, and one caught a real factual error.

**Codex** (6 issues): undefined failure semantics; coincident boundaries (entering `implement`
IS entering plan phase 1); cold-review goal vs the cold-reader save request; the re-entry
mechanism has no adequate acceptance test; self-target authorization unspecified; protocol
scope (ASPIR) unstated.

**Claude** (verified claims against the tree, which is how it found this): my Constraint that
`afx send --delay` is "not persisted" was **false**. I sourced it from the CLI help text at
`cli.ts:455` and `arch-save/SKILL.md:110` — both stale. I verified independently before acting:
`servers/delayed-send.ts` says a plain `--delay` "keeps no timer at all and survives a Tower
restart by construction"; `handleDelayedSend` persists the body to the durable mailbox at
request time with `not_before`. Only the delayed-`--interrupt` ^C is dropped at shutdown. This
was the conscious reversal of Spec 1307's trade, per review 1313.

That correction *improves* the design rather than complicating it: the re-entry can ride the
durable mailbox, and Spec 1313's render gate delivers a body only onto a prompt proven empty —
so a busy terminal holds it instead of eating it. I did not overclaim, though: the gate covers
the window *before* turn-end; whether a queued `/clear` can consume a re-entry delivered just
after turn-end is an empirical harness property. So it is now an explicit live acceptance test
(scenario 37) plus an in-flight marker in `porch status`, not an assumption.

Also verified rather than trusted: porch has **no runtime schema validation** (`loadProtocol` =
JSON.parse + a hand-rolled `normalizeProtocol` checking only name/phases; no ajv/zod). So
"the schema validates the key" was wrong too — rejection is new code. Three `protocol-schema.json`
copies exist, not two. And `detectCurrentBuilderId` already throws rather than guessing (#1094),
so codex's self-target-authorization point is satisfiable by construction: the command takes no
target argument at all.

Decisions I made in the rewrite:
- **Failure semantics**: boundary consumed at emission, never retried, refresh never blocks,
  builder-side command never writes status.yaml. A failed refresh costs one refresh, nothing else.
- **Coincident boundaries**: per-plan-phase fires on *advance between* plan phases — excludes the
  first by definition, no special case.
- **ASPIR is in.** It has SPIR's exact phase shape and no spec/plan gates, i.e. it is *the*
  unattended case. Excluding it while the problem statement named it was incoherent.
- **Review-boundary save**: pointers, not persuasion. No self-assessment or defense of the
  implementation; deviations, flaky tests, deferred work are exactly what it should carry.
- **Min-bytes**: kept, but flagged that 1000 was calibrated on a *mid-phase* manual reset, not a
  clean boundary. Plan decides the number deliberately.

## 2026-08-17 — Spec approved; plan drafted

Human approved spec-approval (relayed by architect). Two architect notes carried forward:
ASPIR stays in scope; my reading of Baked Decision 1 (reuse the modules, since full
self-invocation is structurally impossible) is the accepted interpretation, and the structural
test pinning the shared modules must stay. Both are recorded in the plan's Executive Summary so
they survive a context refresh.

Frontmatter: `approved: 2026-08-18`, `validated: [codex, claude]`. Gemini is NOT listed — porch
ran a 2-way consultation, not 3-way, so claiming gemini would be false.

### Plan shape (8 phases)

Ordering is dependency-driven, and phases 3–5 (builder side) depend on nothing in 1–2 (porch
side), so the two halves could be split across builders if the architect ever wants to.

1. Boundary declaration + protocol validation — config surface; rejection is NEW CODE in
   `normalizeProtocol` (there is no runtime schema validation), 3 schema copies.
2. Porch trigger with at-most-once record — the key insight: all three transition sites already
   `writeStateAndCommit` then recurse into `next()`. So record the boundary and **return the
   refresh task instead of recursing**. At-most-once becomes a property of the control flow
   rather than a guard bolted on top.
3. Self-refresh orchestrator — port-injected, step-log-asserted, reusing receipt.ts +
   reorient.ts verbatim. Ordering: schedule re-entry FIRST, clear SECOND (inverts /arch-save).
4. `afx self-refresh` command — named as a distinct command, NOT a flag on `afx refresh`, and
   takes no positional argument at all. That makes "cannot target another session" structural:
   there is nothing to pass.
5. Skill + re-entry frame — incl. the pointers-not-persuasion constraint at the review boundary.
6. Stalled-refresh visibility in `porch status` — resolved the open question by DERIVING the
   stall (boundary recorded + no subsequent activity) rather than storing an in-flight flag. A
   stored flag would need a clearing writer, and the only candidate is the builder-side command,
   which the spec forbids from writing status.yaml.
7. Docs correction + parity — the stale `--delay` text in 4 places (it caused the error in my own
   spec), plus spir's broken `$schema` path.
8. End-to-end incl. the LIVE run — the only thing that tests the harness property the feature
   rests on. Delay constant gets set from that measurement, not inherited from arch-save's 15s.

If the live run in phase 8 shows the queued `/clear` CAN consume the re-entry, that is a finding
to report, not something to quietly work around.

## 2026-08-17 — Plan iteration 1 review

Both REQUEST_CHANGES. 13 points, all accepted. **Two were defects that would have shipped a
broken feature, not a rough one** — and both reviewers found the first one independently.

### Defect 1: the nonce could never exist (found by BOTH reviewers)

`verifyReceipt` requires the nonce to already be inside `.builder-state.md`. My plan had the
builder write that file BEFORE invoking `afx self-refresh`, which is where the nonce was minted.
Every self-refresh would have aborted `wrong-nonce`. Unit tests would have passed — they'd inject
the nonce on both sides.

Root cause worth remembering: the driven path works because the driver issues the nonce in the
save request and THEN polls. Removing the external driver removed the thing that made the
handshake possible, and I carried the mechanism over without noticing its precondition had gone.

Fix: real two-step handshake. `afx self-refresh --begin` mints the nonce and writes
`.builder-refresh-challenge`; builder writes its save; `afx self-refresh` verifies against that
nonce and executes, deleting the challenge. Bonus property: a stale `.builder-state.md` from an
earlier boundary now fails `wrong-nonce` instead of passing — replay protection the driven path
got free from being externally driven.

### Defect 2: a fourth transition site (found by Claude)

`next.ts:240-276` — the pre-approval path. Artifact carries `approved:` frontmatter →
`hasPreApproval` → auto-approve → transition → recurse. **This is the path CLAUDE.md documents as
normal.** My three sites would have left `enter:plan` and `enter:implement` dead for exactly the
projects most likely to use them. It also owns plan_phases extraction, so the
implement/first-plan-phase coincidence rule has to hold there too.

### Phase 6 was wrong for a checkable reason

I "derived" the stall from `updated_at` vs the boundary timestamp. Verified: the only two
`writeStateAndCommit` calls in the build-verify range are force-advance and re-iter — the normal
task-emission path writes NOTHING. So `updated_at` sits at the transition for a whole healthy
build and a busy builder is indistinguishable from a stalled one. Replaced with a porch-owned
`acknowledged_at`, set once on the first normal-path pass. Chose that over an untracked marker
file because it keeps the signal in the artifact porch already owns and commits.

### The live-run ownership problem (Claude)

**I cannot clear my own context to test self-clearing and still be there to report.** Phase 8 now
names the architect as driver on a separate subject builder; I prepare the runbook and analyse the
transcript. Flagged as a coordination dependency at the START of the phase. Blocked, not waived,
if it can't be scheduled.

### Also fixed
Min-bytes DECIDED (retain 1000, with Phase 8 measuring real boundary saves as evidence) instead of
left in the risks table where nothing would execute it. `buildBoundarySaveRequest` for ALL
boundaries, not just review — the existing request says "do not summarise", which contradicts the
bounded save everywhere. `on_plan_phase_advance` rejected on protocols with no per_plan_phase.
Phase 2 ordering stated unambiguously (mutate + append, ONE write, return without recursing).
Failed live test now BLOCKS rather than being documented. `release` protocol's missing skeleton
counterpart allowlisted in the parity test (pre-existing, not mine to fix).

### The pattern across two review rounds

Spec round: two false claims, both from reading docs instead of code. Plan round: three errors,
each one grep from being caught. I am reasoning about code I've read *around* rather than *read*.
Concretely for the rest of this project: before asserting any behavior of an existing function,
open it.

## 2026-08-18 — Implement Phase 1

Plan approved (human, relayed by architect). Architect confirmed: Phase 8 live runs are
architect-driven on a disposable subject builder — **flag them when the runbook is ready, not
before**; the Phase 2 no-chaining behavior change is accepted; tests 37/38 are blocking.

### Friction worth reporting: this repo has no `worktree` block

`.codev/config.json` has `porch.checks` but no `worktree` block, so builder worktrees spawn with
**no node_modules** and cannot run `npm run build` / `npm test` until someone runs an install by
hand. My first `vitest run` died with "Cannot find package 'vitest'". Ran `pnpm install
--frozen-lockfile` in the worktree to unblock.

Also worth flagging: that failing vitest run **exited with code 0** despite a startup error, so a
check that only inspects the exit code would have called it green. Porch's `tests` check runs
`npm test` with cwd `packages/codev`; if that inherits the same behavior, a worktree without
node_modules could pass the check while running nothing.

Candidate follow-up (not this project's scope): add a `worktree.postSpawn: ["pnpm install
--frozen-lockfile"]` to `.codev/config.json` so builders are runnable on spawn.

### Phase 1 as built

- `ContextRefreshConfig` on the `Protocol` type; `context_refresh?` optional so absent = no
  refreshes.
- `normalizeContextRefresh` in protocol.ts — validates and REJECTS, because there is no other
  layer that could. Rejects: unknown phase in `on_enter` (names it, and lists what IS available);
  `on_plan_phase_advance: true` with no per_plan_phase phase; wrong types; unknown keys.
- Unknown keys are rejected rather than ignored — a typo'd `on_entry` is indistinguishable from
  "declared nothing" if skipped, which is the exact silent no-op the validator exists to prevent.
- spir + aspir declare the four boundaries in BOTH trees.
- All three `protocol-schema.json` copies got the same block. Note: those three are **not**
  byte-identical to each other and never were — the skeleton root copy is draft 2020-12 with a
  different `required` set, the two `protocols/` copies are draft-07. Pre-existing, out of scope;
  the parity test asserts the `context_refresh` block agrees rather than whole-file equality, and
  says why inline.
