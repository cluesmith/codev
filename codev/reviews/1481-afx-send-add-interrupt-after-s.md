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
- `codev-skeleton/resources/commands/agent-farm.md` (+56 / -1)
- `codev/plans/1481-afx-send-add-interrupt-after-s.md` (+139 / -0)
- `codev/projects/1481-afx-send-add-interrupt-after-s/status.yaml` (+27 / -0)
- `codev/resources/arch-critical.md` (+1 / -1)
- `codev/resources/arch.md` (+11 / -3)
- `codev/resources/commands/agent-farm.md` (+56 / -1)
- `codev/resources/lessons-learned.md` (+14 / -0)
- `codev/reviews/1481-afx-send-add-interrupt-after-s.md` (+369 / -0)
- `codev/specs/1481-afx-send-add-interrupt-after-s.md` (+13 / -0)
- `codev/state/pir-1481_thread.md` (+135 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-force-wiring.test.ts` (+176 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-interrupt-after.e2e.test.ts` (+417 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-interrupt-after.test.ts` (+896 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-migration.test.ts` (+211 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1481-owner-wiring.test.ts` (+279 / -0)
- `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts` (+5 / -4)
- `packages/codev/src/agent-farm/__tests__/send.test.ts` (+90 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1313-migration.test.ts` (+7 / -2)
- `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts` (+227 / -3)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+192 / -0)
- `packages/codev/src/agent-farm/cli.ts` (+21 / -0)
- `packages/codev/src/agent-farm/commands/inbox.ts` (+100 / -0)
- `packages/codev/src/agent-farm/commands/send.ts` (+32 / -4)
- `packages/codev/src/agent-farm/db/mailbox.ts` (+204 / -5)
- `packages/codev/src/agent-farm/db/migrations.ts` (+41 / -1)
- `packages/codev/src/agent-farm/db/schema.ts` (+4 / -0)
- `packages/codev/src/agent-farm/db/types.ts` (+53 / -0)
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+82 / -6)
- `packages/codev/src/agent-farm/servers/mailbox-interrupt.ts` (+588 / -0)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+138 / -3)
- `packages/codev/src/agent-farm/servers/message-write.ts` (+40 / -0)
- `packages/codev/src/agent-farm/servers/row-write-ownership.ts` (+131 / -0)
- `packages/codev/src/agent-farm/servers/session-submit.ts` (+172 / -75)
- `packages/codev/src/agent-farm/servers/tower-messages.ts` (+16 / -1)
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
- `1f0319f93` [PIR #1481] Review + retrospective
- `55fa8c332` chore(porch): 1481 record PR #1640
- `4c8511beb` chore(porch): 1481 review build-complete

(The review commit and the consultation-fix commit that follow it are not listed above.)

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
- `packages/codev` tests: ✓ pass — **288 files / 5814 tests pass, 0 fail** (3 files / 48 tests
  skipped, all pre-existing skips). Before the consultation fixes: 287 files / 5797 tests.
- `packages/sdk` tests: ✓ pass — **11 files / 135 tests pass**
- `tsc --noEmit`: ✓ clean in both packages
- New test files: `pir-1481-migration` (v19 up/idempotence/back-compat), `pir-1481-interrupt-after`
  (36 — coordinator, claim guard, skips, outcomes, alarm suppression, contention give-up),
  `pir-1481-owner-wiring` (15 — real drainer against a seeded registry),
  `pir-1481-force-wiring` (16 — the production feed/notification binding, added for the
  consultation findings), `pir-1481-interrupt-after.e2e` (4)
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
  showing the flag, and the four invalid values (`0`, `-5`, `abc`, `3601`) rejected with exit 1. Those exit before any network
  call, which is why they were safe to run here — the CLI has no port override, so a real CLI send
  would necessarily target the live Tower on 4100. Every send-path observation above therefore goes
  over HTTP against the isolated child Tower instead.

**Against the REAL `claude` CLI** (`capture-real-agent.mjs` → `real-agent-capture.log`, added for
the consultation's fifth finding — the plan asks for clean/busy behaviour on an actual supported
agent, and everything above this point uses a fixture composer). Child Tower on port **14622**, its
own `CODEV_AGENT_FARM_DIR`/DB and a throwaway workspace; the terminal runs `claude
--permission-mode plan`, answers its own trust-folder prompt, and renders its own composer.

- **Clean real composer** — the render gate has no read-only endpoint, so the honest probe is an
  ordinary flagless send, whose `delivered`/`held` **is** the classifier's verdict on that screen.
  `probe 0: delivered=true`. The classifier was validated against a prompt nobody in this repo
  painted.
- **Real half-typed draft** (typed into the real composer, no Enter) — held **`busy` /
  `user-text`**, the classifier reading an actual draft. At the 5 s deadline the escalation fired:
  `interruptClaimedAt` equals `interruptAt` to the millisecond, outcome `written-unverified`, row
  `delivered`, and the `^C` precedes the body in the ring.
- **Mid-turn** (a real prompt submitted, the agent generating) — held **`busy`**, and then the
  agent reached a clean prompt *inside* the 5 s window, so the ordinary gated delivery won: row
  `delivered` with **`interruptClaimedAt: null`** and outcome still `armed`. That is the designed
  cancellation — row `status` is authoritative, the coordinator wrote nothing, and no `^C` fired.
  It is also the clean-before-deadline path demonstrated against a live agent.

**One honest limitation, worth knowing before reading that log.** A real TUI does not echo injected
bytes into its output ring the way the `cat` fixture does, and it redraws — so in this capture the
body string appears twice for a single delivery and the injected `^C` does not appear as a new byte
at all. **Occurrence counts in a real agent's ring are not write counts.** The mailbox row
(`interruptClaimedAt`, `interruptOutcome`, `status`) is the authoritative record for a real agent;
the byte-exact `^C count: 1 / body count: 1` evidence comes from the `cat` fixture, which echoes
verbatim, and that is why both instruments are kept rather than one. The first two runs of this
script are worth a glance for what they cost: `claude` opened on its trust-folder prompt, an ESC
sent to "clear the composer" **exited the CLI**, and every subsequent send honestly reported
`no-live-pty` — no false evidence was produced, but no useful evidence was either.

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
- **`MAX_FORCE_DISPATCHES = 4`** is a loop guard on how many times one row's force may enter the
  submission lock without writing. On exhaustion the row is now retired with the terminal outcome
  `skipped-contended` (see *Consultation findings* below — the original shape left a durable
  `armed` that nothing was armed for).
- **The coordinator leaves `interrupt_outcome = 'armed'` on a row another path delivered.** Row
  `status` is authoritative for cancellation, per the plan; the outcome column is audit of what the
  *coordinator* did, and it did nothing. Reviewers expecting a `cancelled` outcome should read it
  that way.
- **Alarm suppression is membership-only.** Verify that an armed row still counts toward held-mail
  visibility and inbox listings — the intent is "not stuck", not "not there".
- **Migration v19 back-compat**: `GLOBAL_CURRENT_VERSION` moves 18 → 19; `pir-1481-migration.test.ts`
  covers up-migration, idempotence, and rows written by v18.

## Consultation Findings (3-way pass, iteration 1)

PIR runs the consultation **once** (`max_iterations: 1`), so nothing below was independently
re-reviewed after the fixes. Each finding was checked against the actual files before acting on
it, and the disposition is stated honestly.

- **Gemini** — not scheduled by porch for this project (the verify block produced a 2-way task
  list; only Codex and Claude were requested).
- **Codex (`gpt-5.6-sol`) — REQUEST_CHANGES, HIGH confidence.** Five of six findings were real and
  are fixed below; the sixth was an environment limitation, not a defect.
- **Claude (`claude-opus-5`) — no verdict, after four attempts.** Attempts 1 and 2 aborted with
  `Prompt is too long` before producing any review. Attempt 3 got well into reading the
  implementation and then died on a usage limit. Attempt 4 got furthest of all — it read the
  review, verified the code against its claims, reached "the highest-risk hunk — the serializer
  changes", and reported it was *"verifying the two potential issues I spotted before
  finalizing"* — then exhausted its context with `Prompt is too long`. **Those two potential
  issues were never named**, and no output file was written on any attempt.

  The failure is structural, not transient: this diff is large enough (~4.7k lines across 41
  files, several of them long) that the model cannot read what it needs and still have room to
  write a verdict. **This PR therefore carries one model's opinion, not two** — and one of the
  two knew of something it never got to state. A human reviewer should treat
  `servers/session-submit.ts` (§3) with the extra care that missing second opinion would have
  provided.

### What was fixed

1. **The force audit was dropped at the feed boundary.** `mailbox-wiring.ts`'s
   `broadcastForcedDelivery` converted the coordinator's frame for the message bus and hardcoded
   `metadata: { source: 'mailbox' }`, discarding `outcome` and `priorPartial` — so a **`failed`**
   force reached every feed client indistinguishable from a clean gated delivery. Two comments in
   the code asserted the opposite ("the outcome travels as metadata so the frame can never imply
   receipt"), which is precisely the kind of claim that stops being checked. Fixed by threading an
   optional `extraMetadata` through the shared `broadcastDelivered` conversion and widening
   `MessageFrame.metadata` with `forcedOutcome` / `forcedPriorPartial`.
2. **A failed force was described as delivered.** `surfaceForceOutcome`'s body said the message
   "was force-delivered … That records what was WRITTEN" for every non-skipped outcome, including
   one the terminal rejected. `failed` now gets its own wording: the write was REJECTED, the row is
   already claimed, and the message will not be delivered or retried.
3. **The dispatch ceiling left a false durable state.** Exhausting `MAX_FORCE_DISPATCHES` dropped
   the in-memory entry but left `interrupt_outcome = 'armed'` in the database — an escalation
   `afx inbox` kept promising for the rest of the Tower's lifetime, with nothing left to fire it.
   The ceiling now records the terminal outcome **`skipped-contended`** (nothing claimed, nothing
   written, body stays ordinary held mail), and the ceiling check moved after the row/cancellation
   read so the row is in hand when it fires.
4. **No production-wiring coverage.** The coordinator suite asserted the frame handed *to* the
   port and never ran the conversion, which is why (1) was invisible. New
   `pir-1481-force-wiring.test.ts` (16 tests) drives the real `makeInterruptPorts` with the bus and
   the SSE broadcaster captured, over the whole outcome matrix — written, degraded, failed,
   claimed, prior-partial, and all four `skipped-*` — plus a gated frame that must stay free of
   force metadata. **9 of its 16 fail without fixes (1) and (2).** The contention give-up has its
   own regression test in `pir-1481-interrupt-after.test.ts`, which fails against the old shape.
5. **Documentation contradicted the feature.** `agent-farm.md` still said a held message is "never
   force-injected" and named `--interrupt` as the only bypass — corrected in **both** trees to the
   precise rule (the system never forces on its own; two per-message sender-chosen bypasses). This
   review's own test instructions claimed non-integer values are rejected: **fractional seconds are
   valid on purpose**, and the bullet now says so and explains why the validator is deliberately
   not `validateDelaySeconds`. The Tower-restart bullet now states that it must be done against an
   isolated child Tower — following it against the shared Tower on 4100 would kill every running
   builder.
6. **"Focused tests could not be rerun"** — a read-only filesystem in the reviewer's sandbox, not a
   finding. The full suite runs clean here: see Test Results.

### What a reviewer should still weigh

The `skipped-contended` outcome is a **new value in a persisted vocabulary**. There is no CHECK
constraint on `interrupt_outcome` (deliberate — SQLite cannot `ALTER` one in, so a fresh install
would diverge from an upgraded one), so this needed no migration; the value set is enforced in
TypeScript. A consumer switching exhaustively on the outcome must handle it — `afx inbox` does.

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
  - Non-numeric (`abc`), zero, negative and over-ceiling (`3601`) values are rejected with exit 1
    before any network call. **Fractional seconds are accepted on purpose** — `--interrupt-after 1.5`
    is valid. `validateInterruptAfterSeconds` is deliberately not `validateDelaySeconds`: a patience
    budget can meaningfully be sub-second, a scheduled delivery cannot, so only the one-hour ceiling
    is shared.
  - Restart Tower while a row is armed: the row stays `held`, records `skipped-restart`, and later
    delivers through the gate with no `^C`. **Do this only against an isolated child Tower** — its
    own port (never 4100), its own `CODEV_AGENT_FARM_DIR`/DB, throwaway workspaces, exactly as
    `pir-1481-interrupt-after.e2e.test.ts` sets one up. Restarting the shared Tower on 4100 kills
    every running builder, so it is never the way to check this.
  - An armed pre-deadline row does not trip the held-mail starvation owner-notice; ordinary held mail
    for the same agent still does.
  - `afx inbox` shows the deadline, the outcome, and the prior-partial duplicate-risk warning.
