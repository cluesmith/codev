# PIR Review: `afx send --interrupt-after <seconds>` — bounded patience

Fixes #1481

## Summary

`afx send --interrupt-after <s>` adds the missing middle between "force now" (`--interrupt`) and
"wait forever" (the default gated hold): the message is persisted as ordinary held mail and is
eligible for a clean-prompt delivery from the instant it lands, but if it is **still held** at
`now + s`, a coordinator escalates that same row to the existing forced write (`^C`, a 100 ms
settle, the ungated body, Enter). It is an opt-in, per-message, exactly-one-force exception to
the Spec 1313 no-force principle — the system never decides to force on its own — and it routes
through the one shared interrupt writer that `--interrupt` already uses, so there remains exactly
one place in the system that writes past the render gate.

The change also lands the plan's §3: `submitToSession`'s enqueue-time `behindOperator` bound (from
#1365) is replaced with explicit predecessor-completion tracking, because a timed force queued
behind a long paced delivery must not inherit an unbounded wait.

## Files Changed

- `.claude/skills/afx/SKILL.md` (+23 / -0)
- `.codex/skills/afx/SKILL.md` (+23 / -0)
- `codev-skeleton/.claude/skills/afx/SKILL.md` (+23 / -0)
- `codev-skeleton/.codex/skills/afx/SKILL.md` (+23 / -0)
- `codev-skeleton/resources/commands/agent-farm.md` (+53 / -0)
- `codev/plans/1481-afx-send-add-interrupt-after-s.md` (+139 / -0)
- `codev/projects/1481-afx-send-add-interrupt-after-s/status.yaml` (+22 / -0)
- `codev/resources/arch-critical.md` (+1 / -1)
- `codev/resources/arch.md` (+11 / -3)
- `codev/resources/commands/agent-farm.md` (+53 / -0)
- `codev/specs/1481-afx-send-add-interrupt-after-s.md` (+13 / -0)
- `codev/state/pir-1481_thread.md` (+135 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-interrupt-after.e2e.test.ts` (+417 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-interrupt-after.test.ts` (+845 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-migration.test.ts` (+211 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-owner-wiring.test.ts` (+279 / -0)
- `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts` (+5 / -4)
- `packages/codev/src/agent-farm/__tests__/send.test.ts` (+90 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1313-migration.test.ts` (+7 / -2)
- `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts` (+227 / -3)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+192 / -0)
- `packages/codev/src/agent-farm/cli.ts` (+21 / -0)
- `packages/codev/src/agent-farm/commands/inbox.ts` (+98 / -0)
- `packages/codev/src/agent-farm/commands/send.ts` (+32 / -4)
- `packages/codev/src/agent-farm/db/mailbox.ts` (+204 / -5)
- `packages/codev/src/agent-farm/db/migrations.ts` (+40 / -1)
- `packages/codev/src/agent-farm/db/schema.ts` (+4 / -0)
- `packages/codev/src/agent-farm/db/types.ts` (+50 / -0)
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+82 / -6)
- `packages/codev/src/agent-farm/servers/mailbox-interrupt.ts` (+586 / -0)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+103 / -0)
- `packages/codev/src/agent-farm/servers/message-write.ts` (+40 / -0)
- `packages/codev/src/agent-farm/servers/row-write-ownership.ts` (+131 / -0)
- `packages/codev/src/agent-farm/servers/session-submit.ts` (+172 / -75)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+88 / -6)
- `packages/codev/src/agent-farm/types.ts` (+20 / -0)
- `packages/sdk/src/__tests__/tower-client-send.test.ts` (+77 / -0)
- `packages/sdk/src/tower-client.ts` (+26 / -0)
- `packages/types/src/api.ts` (+22 / -0)

## Commits

- `15bc0933c` chore(porch): 1481 init pir
- `21bed9b14` [PIR #1481] Plan bounded-patience send and surface timeout contract decision
- `2f1c866e4` chore(porch): 1481 plan-approval gate-requested
- `697c15a16` [PIR #1481] Revise plan to force original body after interrupt deadline
- `e6d2799af` [PIR #1481] Refine plan ownership retries and review accounting details
- `c074b1108` [PIR #1481] Log resumed session holding at plan-approval
- `eecf97513` chore(porch): 1481 plan-approval gate-approved
- `b7ba7ff57` chore(porch): 1481 implement phase-transition
- `df324b185` [PIR #1481] Persist the bounded-patience deadline and its force audit
- `cf82a9da7` [PIR #1481] Escalate a still-held message to a forced delivery at its deadline
- `5685493ad` [PIR #1481] Cover the escalation, same-row ownership, and alarm suppression
- `3267d9b24` [PIR #1481] Cover the flag boundary, the wire contract, and the operator chain
- `dd0fb12dc` [PIR #1481] Document bounded patience as an opt-in exception, not a valve
- `66fd17675` [PIR #1481] Prove the escalation against a real PTY, and log the phase
- `286b8c404` chore(porch): 1481 dev-approval gate-requested
- `b0e6d86c4` [PIR #1481] Record the resume and the state re-verified at the gate
- `1e3fe4a21` chore(porch): 1481 dev-approval gate-approved
- `6e818c6a4` chore(porch): 1481 review phase-transition

## What Was Built

**Schema (migration v19).** Four `mailbox` columns: `interrupt_at` (the absolute deadline, held
*separately* from `not_before` — `not_before` is a delivery-*eligibility* lower bound, so reusing
it would have defeated the immediate clean delivery that is the whole point), `interrupt_claimed_at`,
`interrupt_outcome`, `interrupt_prior_partial`.

**`servers/mailbox-interrupt.ts`** — the deadline coordinator. Arms an absolute-deadline timer at
persist time, **before** the first gated await, so a slow classify cannot silently extend the
operator's budget. At the deadline it re-resolves the agent's live session, re-checks row status,
lifecycle and session identity *inside* the per-terminal submission lock, atomically claims
`held → delivered` in one guarded UPDATE, and only then writes. Owned by `mailbox-wiring.ts`'s
start/stop lifecycle, with a restart sweep that runs before any writer starts.

**`servers/row-write-ownership.ts`** — a synchronous, non-blocking per-**row** token that both body
paths take immediately before their first byte. The per-terminal lock alone is not sufficient: a
gated delivery's row still reads `held` while its paced write is on the wire, so "is someone writing
this row right now?" must never be inferred from `status`. A force that finds a gated writer holding
the row declines completely — writes nothing, claims nothing, counts no bypass — and re-enters once
that attempt's outcome is committed.

**`servers/message-write.ts`** — one shared `writeInterruptToSession` (`^C` → 100 ms settle → paced
body → Enter unless `noEnter`), now used by *both* the immediate `--interrupt` route and the timed
escalation. There is exactly one force writer in the system.

**Force authority is scoped to the current Tower lifetime** (both human decisions, accepted as
proposed at the plan gate): a restart retires leftover `armed` rows as `skipped-restart`; an offline
or replaced session at the deadline records `skipped-offline` / `skipped-session-replaced`. In every
skip the body survives as ordinary held mail and delivers through the gate. The deliberate
consequence is that a restart cannot ambush an unrelated later turn with an interrupt nobody is
waiting for any more.

**Claim-before-bytes matches immediate `--interrupt`'s loss-over-duplicate choice**, so
`claimed`/`claimed-degraded` means *unknown write outcome, never receipt*. The outcome vocabulary
keeps `written-unverified`, `failed` and the `skipped-*` reasons distinct rather than collapsing
them into a lossy "done", and `afx inbox` surfaces `interrupt_prior_partial` as an explicit
duplicate-effect risk rather than pretending exactly-once.

**Alarm interaction.** An *armed, pre-deadline* row is excluded from starvation aggregation and
owner-notice membership only — it is "will self-resolve", not stuck. Ordinary held mail for the same
agent still alarms, and after the deadline (or after any skip) the row participates normally on an
escalation clock started at `max(created_at, not_before, interrupt_at)`.

**Two deliberate changes to #1365's semantics**, both mandated by the approved plan's §3:

1. The enqueue-time `behindOperator` decision is replaced by an operator-only completion chain
   (`operatorTails`). An operator always arms its ceiling — measured from *its own* enqueue — and
   runs when preceding operators have finished AND (predecessors finished OR the ceiling expired).
2. Degradation is now a **write-edge fact** read from a per-session `activeWrites` counter, not a
   latched timer: `onCeilingExpired` and the bypass counter fire only when bytes actually went out.
   This changed one existing #1365 assertion (a degraded write that writes *nothing* is now neither
   counted nor announced) — renamed in place, because the old assertion asserted exactly the
   behaviour the plan replaces. Timed forces decline far more often than they write, so the old
   latch would have produced a steady stream of "proceeded UNSERIALIZED" warnings about submissions
   that wrote nothing.

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass (also green via porch's `build` check at the
  dev-approval gate, 13.8s)
- `packages/codev` tests: ✓ pass — **287 files / 5797 tests pass, 0 fail** (3 files / 48 tests
  skipped, all pre-existing skips)
- `packages/sdk` tests: ✓ pass — **11 files / 135 tests pass**
- `tsc --noEmit`: ✓ clean in both packages
- New test files: `pir-1481-migration` (v19 up/idempotence/back-compat), `pir-1481-interrupt-after`
  (35 — coordinator, claim guard, skips, outcomes, alarm suppression), `pir-1481-owner-wiring`
  (15 — real drainer against a seeded registry), `pir-1481-interrupt-after.e2e` (4)
- Extended: `tower-routes.test.ts` (131 pass — route-level flag boundary and refused combinations),
  `send.test.ts` (40 — CLI forwarding + force warnings), `packages/sdk` wire contract (13),
  `spec-1365-serializer-convergence.test.ts` (35 — the §3 operator chain, including the plan's F1
  trace and its companion where the delivery really is still running)

**Baseline verified, not asserted.** Mid-implementation the suite showed 15 failing files. Twelve
were environmental (`packages/codev/skeleton` and `dist` do not exist before a full build, and those
tests say so themselves); running the build in the worktree turned all twelve green, which confirmed
the diagnosis instead of leaving it a claim. The other three (`spec-1313-migration`,
`send-architect-identity`, `spec-1365-serializer-convergence`) were genuinely this change's and are
fixed.

### Manual verification (the human's dev-approval evidence)

Fake-clock proofs and real-PTY observations were deliberately kept separate; everything below is the
latter, from live shellper PTYs on an isolated, harness-owned child Tower. The live Tower on 4100 was
never stopped, restarted or written to, and no other builder's worktree was read or modified.

- **`pir-1481-interrupt-after.e2e.test.ts`** — child Tower on port **14620** (never 4100), its own
  `CODEV_AGENT_FARM_DIR`/DB, throwaway workspaces, real shellper `stty raw -echo; cat` terminals
  painted with the exact claude-composer bytes the render gate classifies. 4/4 pass in 19.4s:
  clean-before-deadline (delivers normally, then **no `^C` and no second body** after the deadline
  passes); busy-through-deadline (**exactly one `^C`, immediately preceding exactly one body**); flag
  validation plus the three refused combinations and an unchanged ordinary send; and a real Tower
  **restart** that leaves the row `held` with `skipped-restart`, keeping the deadline as audit and
  then delivering through the gate with no `^C` at all.
- **`capture-raw-pty.mjs` → `raw-pty-capture.log`** — the same busy-through-deadline path on port
  **14621**, dumping the terminal's actual output ring with control bytes escaped. Observed: the ring
  is unchanged 1.2 s into the window (no body, no `^C`); after the deadline it holds `⟪^C⟫`
  immediately followed by the formatted body; `^C count: 1, body count: 1`; the row reads
  `status: delivered`, `interruptClaimedAt` 1 ms after `interruptAt`, outcome `written-unverified`,
  `interruptPriorPartial: false`.
- **`cli-flag-capture.log`** — the worktree-**built** CLI (`packages/codev/bin/afx.js`): `send --help`
  showing the flag, and all four invalid values rejected with exit 1. Those exit before any network
  call, which is why they were safe to run here — the CLI has no port override, so a real CLI send
  would necessarily target the live Tower on 4100. Every send-path observation above therefore goes
  over HTTP against the isolated child Tower instead.

## Architecture Updates

Routed to **both** tiers, and already applied in commit `dd0fb12dc` (not deferred to this commit):

- **HOT — `codev/resources/arch-critical.md`**: the existing mailbox invariant was *amended in
  place*, not added alongside. It previously read "never force-inject"; that is now false as an
  absolute, and a stale hot fact is worse than a missing one. It now states the precise rule — the
  system never adds a force it decides on its own; the only ungated writes are per-message and
  sender-requested (`--interrupt` now, `--interrupt-after <s>` only if still held at its deadline),
  both through one shared interrupt writer; a force outcome is audit, never receipt; and every
  message writer takes the per-terminal `submitToSession` lock plus the new per-row write-ownership
  token before its first byte. **No new hot fact, no displacement, cap unchanged** (10 facts).
- **COLD — `codev/resources/arch.md` §7 (Message Delivery)**: the section's `Location` list gained
  the new modules; the opening invariant was corrected the same way as the hot line; and item 7
  became "two bypasses, both per-message and both opt-in" with four new sub-paragraphs — bounded
  patience mechanics (v19 columns, arm-before-await, claim inside the lock, the shared writer), *why
  a per-row ownership token exists* (status cannot answer "is a write in flight"), force authority
  scoped to the Tower lifetime (the three skip reasons and `interrupt_prior_partial`), and the alarm
  interaction.

`CLAUDE.md` / `AGENTS.md` include the hot file by `@` reference, so neither needed editing and the
two stay byte-identical. The user-facing docs are mirrored in both trees: `codev/resources/commands/
agent-farm.md` + its `codev-skeleton/` twin, and all four `afx` `SKILL.md` files (kept byte-identical
in their `.claude`/`.codex` pairs, in both trees).

## Lessons Learned Updates

Two lessons routed to **COLD** `codev/resources/lessons-learned.md` (Architecture and Testing).
Neither displaces a hot lesson: the hot file is at its 10-lesson cap, and both of these are
narrower than every entry currently there — the first is a specific concurrency-modelling recipe,
the second a specific evidence-hygiene recipe. Nothing here qualifies for the always-on tier.

1. **Architecture** — a persisted row's `status` is not a "write in progress" signal; a second
   writer contending for the *same row* needs an explicit ownership token taken before the first
   byte. This is the generalizable form of the bug the per-row token exists to prevent.
2. **Testing** — when the deliverable *is* a force against a real terminal, fake-clock proofs and
   real-PTY observations must be reported as separate evidence classes, and the PTY's raw output
   ring (control bytes escaped, `^C`s and bodies counted) is the artifact that actually settles
   "exactly one interrupt, immediately before exactly one body."

## Things to Look At During PR Review

- **`session-submit.ts` §3 is the highest-risk hunk in the PR** (+172 / -75). It revises the
  `submitToSession` bound that PR #1492 stabilized. Two behaviour changes are intentional and worth
  independent scrutiny: the operator-only completion chain replacing the enqueue-time `behindOperator`
  snapshot, and degradation becoming a write-edge fact gated on `activeWrites`. The second one
  *changed an existing #1365 assertion* — see `spec-1365-serializer-convergence.test.ts`, where the
  old assertion was renamed in place rather than deleted or duplicated. If the reviewer disagrees
  that a zero-byte degraded write should be silent, that is the assertion to argue with.
- **The claim/write ordering in `mailbox-interrupt.ts`.** The force claims the row *before* writing
  bytes, inheriting immediate `--interrupt`'s existing loss-over-duplicate crash semantics. That is a
  deliberate consistency choice, not an oversight; the cost is that a crash between claim and write
  loses the body. Check that nothing in the logs, `afx inbox`, or the API response reads as receipt.
- **`MAX_FORCE_DISPATCHES = 4`** is a loop guard, and an exhausted row is deliberately left `armed`
  (truthful — it was never claimed) for the next restart sweep to retire. Judgement call, flagged
  rather than buried.
- **The coordinator leaves `interrupt_outcome = 'armed'` on a row another path delivered.** Row
  `status` is authoritative for cancellation, per the plan; the outcome column is audit of what the
  *coordinator* did, and it did nothing. Reviewers expecting a `cancelled` outcome should read it
  that way.
- **Alarm suppression is membership-only.** Verify that an armed row still counts toward held-mail
  visibility and inbox listings — the intent is "not stuck", not "not there".
- **Migration v19 back-compat**: `GLOBAL_CURRENT_VERSION` moves 18 → 19; `pir-1481-migration.test.ts`
  covers up-migration, idempotence, and rows written by v18.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1481` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1481`
- **What to verify**:
  - `afx send <agent> "msg" --interrupt-after 5` against a *busy* agent: nothing lands for 5 s, then
    exactly one `^C` immediately followed by exactly one body.
  - The same against an agent that reaches a clean prompt inside the window: the body lands normally
    and **no** `^C` ever fires, even after the deadline passes.
  - `--interrupt-after` combined with `--interrupt` (and the other two refused combinations) is
    rejected at the CLI and at the route.
  - Non-integer, zero, negative and over-ceiling values are rejected with exit 1 before any network
    call.
  - Restart Tower while a row is armed: the row stays `held`, records `skipped-restart`, and later
    delivers through the gate with no `^C`.
  - An armed pre-deadline row does not trip the held-mail starvation owner-notice; ordinary held mail
    for the same agent still does.
  - `afx inbox` shows the deadline, the outcome, and the prior-partial duplicate-risk warning.
