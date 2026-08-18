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
