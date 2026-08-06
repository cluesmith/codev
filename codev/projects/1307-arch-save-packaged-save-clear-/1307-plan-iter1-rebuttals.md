# Plan 1307 — Rebuttals, Plan iteration 1

Both reviewers returned `REQUEST_CHANGES` (both HIGH confidence). **All findings
accepted**; nothing defended. Both reviewed the *descoped* plan, not the earlier
seven-phase version.

The headline: **the two reviewers independently found the same two defects**, and both are
outside the design's recoverability posture — that is, they are the failures a manual
re-send does *not* repair. Independent convergence on the same two items, out of ~14 total
findings, is the strongest signal either review produced.

---

## The two that matter

### P1. `SendBuffer` can invert `/clear` and `/arch-init` — both reviewers

**Accepted; verified against source.** `/api/send` already defers messages when the user
is typing: `shouldDefer = !interrupt && !session.isUserIdle(3000)`
(`servers/tower-routes.ts:1570`), buffering for up to 60s (`send-buffer.ts:32-33`).
`isUserIdle` reads `_lastInputAt` (`terminal/pty-session.ts:554`) — *user input*, not
output. The `/arch-save` flow is precisely the case that trips it: the owner has just
typed a direction, so input is recent and the `/clear` is buffered.

```
T+0    /clear sent → user typing → BUFFERED (up to 60s)
T+15   /arch-init due → direct write → LANDS FIRST
T+40   buffer flushes → /clear lands → wipes the recovered context
```

This inverts the single ordering the whole feature promises. **Worse, it is outside the
recoverability posture**: the damage is a clear landing *after* recovery, so re-sending
`/arch-init` just re-runs the race. My plan said the design "schedules only the terminal
write" — which is exactly the bypass that causes this.

**Changed**: a due message **re-enters the normal delivery path, buffering included**, so
per-session FIFO does the work and ordering stops depending on timing luck. Stated as the
phase's critical rule, with the inversion sequence written out, an acceptance criterion
that exercises it **with the buffer engaged**, and a risk row marking it
designed-out-not-accepted.

### P2. `afx send <self>` is unspecified and can clear the wrong architect — both reviewers

**Accepted; verified against source.** I wrote `<self>` as a placeholder and never
resolved it. For a non-builder sender, bare `architect` resolves to `main` or the
first-registered architect (`servers/tower-messages.ts:371-372`). So a **sibling
architect** running `/arch-save` would clear **main's** terminal.

This is the worst thing this feature could do: it destroys the context of a session whose
owner never invoked anything, and it is one word away from correct.

**Changed**: the skill addresses `architect:<name>` explicitly, with the reason stated in
both spec and plan, plus an acceptance criterion. The explicit form is safe for architect
senders — the spoofing check constrains builders, while architects have an open address
grammar.

---

## Codex

### X1. Phase 1 targets a re-export shim, not the implementation
**Accepted; verified.** `sendMessage` lives at `packages/core/src/tower-client.ts:655`;
`agent-farm/lib/tower-client.ts` only re-exports. **Changed**: core file named explicitly,
flagged as a cross-package change with core-first build ordering, and core-side test
coverage added to deliverables.

### X2. Delayed-target lifecycle undefined
**Accepted.** **Changed**: retain the *authorised terminal id*, re-fetch that exact session
at delivery, re-check writability, drop gracefully if gone. Explicitly do not close over a
`PtySession` — a 15-second-old reference may point at a dead or replaced session.

### X3. Shutdown wiring missing
**Accepted.** **Changed**: a delayed-send registry with a shutdown function wired into
`tower-server.ts`'s graceful-shutdown sequence. Codex's sharper point is that shutdown must
**drop** delayed sends rather than flush them — unlike `SendBuffer`, whose flush-on-shutdown
is right for messages already accepted for immediate delivery. A flushed delayed message
could land in a session that has moved on. Now an acceptance criterion.

### X4. `--escape` composition is unsatisfiable
**Accepted.** My spec required composition with `--escape`; `afx send` has no such flag
(`cli.ts:450-454`) — interrupts are `afx interrupt`, and `escape` exists only as a
client/route option. **Changed**: recorded **N/A** in the spec rather than silently
dropped, and the real flag set (`--all`, `--file`, `--interrupt`, `--raw`, `--no-enter`)
enumerated with a decision for each. `--interrupt` needed a real decision: it currently
writes Ctrl+C at request time, so with `--delay` it must be deferred *with* the message.

### X5. `adopt` coverage missing; `skill-parity.test.ts` exists
**Accepted; verified** (`adopt.test.ts:92`, `skill-parity.test.ts`). **Changed**: `adopt`
added to phase 2's deliverables, and the existing parity test acknowledged so it is not
duplicated.

---

## Claude

### C1. `arch-init`'s SKILL.md still documents the manual loop
**Accepted, and this one I would have shipped.** The four `arch-init` copies describe
save→suggest-`/clear`→human-clears in prose. Adding `/arch-save` without touching them
ships two contradictory procedures for the same task. **Changed**: updating the four
`arch-init` copies is now a phase-2 deliverable and acceptance criterion.

### C2. The delay budget starts at the wrong moment
**Accepted, and it reframes the calibration.** The delay begins when the send is issued,
but `/clear` cannot execute until the architect's turn ends — and the turn runs as long as
the skill takes. The interval that matters is **send → session-ready-after-clear**, not
send → clear-sent. **Changed**: phase 3 measures that interval and says which one it is. A
default calibrated against the wrong interval looks right in testing and misfires whenever
a turn runs long.

### C3. Line drift on the spoofing check; it only fires on `architect:<name>`
**Accepted; verified.** The check is at `tower-messages.ts:225-234` (213-218 is the
signature). The operationally useful half: it fires on the `architect:<name>` path — the
bare `architect` path has separate affinity logic — so the request-time authorisation test
must use `architect:<name>` or it proves nothing. **Changed** in both the implementation
notes and the acceptance criterion.

### C4. Say why `tower-cron.ts` is not reused
**Accepted.** `CronDeps.resolveTarget` takes no `sender`, so routing through it would drop
affinity and the spoofing check — a better reason than the tick interval I had given.
**Changed**: stated in phase 1 so reviewers do not re-litigate it.

### C5. "All four copies identical" needs precision
**Accepted.** The skeleton trees carry a *subset* of skills (no `forge`/`team`/
`skill-creator`), so the claim is parity for *this skill*, not tree parity. **Changed**,
with `skill-parity.test.ts` noted as already covering provider-tree byte parity.

### C6. CLI should say "scheduled", not "sent"; surface `deferred`
**Accepted.** The route already returns a `deferred` flag that `commands/send.ts`
discards. **Changed**: both are phase-1 deliverables. Reporting "sent" for a message that
has not been sent is the kind of small dishonesty that costs someone a debugging session.

---

## Summary

| # | Finding | Source | Disposition |
|---|---|---|---|
| P1 | `SendBuffer` inverts clear/re-init ordering | Both | **Designed out** — FIFO re-entry |
| P2 | Bare `architect` clears the wrong terminal | Both | **Designed out** — `architect:<name>` |
| X1 | Phase 1 targeted the re-export shim | Codex | Core file named; cross-package flagged |
| X2 | Delayed-target lifecycle undefined | Codex | Re-fetch by id; re-check writable |
| X3 | Shutdown wiring missing | Codex | Registry + shutdown; drops, not flushes |
| X4 | `--escape` composition unsatisfiable | Codex | Recorded N/A; real flag set decided |
| X5 | `adopt` coverage; parity test exists | Codex | Added; acknowledged |
| C1 | `arch-init` docs contradict `/arch-save` | Claude | Four copies updated |
| C2 | Delay budget measured from the wrong point | Claude | Phase 3 measures send→ready |
| C3 | Spoofing check line + `architect:<name>`-only | Claude | Corrected; test uses that form |
| C4 | Say why not `tower-cron` | Claude | Stated (no `sender` in `resolveTarget`) |
| C5 | "Four copies identical" imprecise | Claude | Scoped to this skill |
| C6 | "scheduled" not "sent"; surface `deferred` | Claude | Both added |

**What I take from this round.** The descope removed a great deal of machinery, and my
plan for the small design was correspondingly thin in the one place that still had real
risk: the interaction between a *new* delivery path and the *existing* one. Both defects
live in that seam. Making something smaller does not make it simpler to get right — it
concentrates the remaining risk into fewer places, and the review found both of them
sitting in the same seam.
