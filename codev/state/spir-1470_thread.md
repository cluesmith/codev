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
