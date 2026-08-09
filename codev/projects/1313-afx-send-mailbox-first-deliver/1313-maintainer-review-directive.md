# Spec 1313 / PR #1330 — Architect directive: maintainer-review round

**Context.** The maintainer (waleedkadous) reviewed PR #1330 and asked for **three changes
before merge** plus four take-or-file follow-ups. The architect independently verified every
claim against the PR head (`e8070fb6`) — **all are real**. The human has adjudicated the one
open design question (change 1): **go with the durable `not_before` design**. This file is
the authoritative work order for this round; feedback is deliberately NOT posted as a PR
comment.

**Porch-state note (do not skip).** The `pr` gate's recorded approval
(2026-08-06T23:06Z) PREDATES the maintainer's review and is superseded by it — treat merge
authorization as withdrawn. Porch's phase label has advanced to `verify`; that is ahead of
reality. Do NOT merge PR #1330, do NOT run `porch done 1313`, and do NOT act on verify-phase
instructions. This directive is the active work regardless of the phase label; verify resumes
for real only after this round lands, architect + maintainer re-review, and the human
re-confirms the merge.

---

## Required change 1 — `--delay` must survive the hold path: persist `not_before` (DECIDED)

**Verified defect.** `deliverAfter` is parsed at `tower-routes.ts:1620-1637` but honored only
on the live-writable path (`:1783`). All three hold paths — the NOT_FOUND→registry hold
(`:1653-1672`), dead session (`:1693-1717`), unwritable session (`:1723-1748`) — enqueue the
row delay-less; no `not_before` concept exists anywhere (`schema.ts:257-277`; repo-wide grep
is empty), so the drainer can deliver arbitrarily earlier than requested. The CLI never tells
the sender the delay was discarded (`send.ts:377-379`). This is a regression introduced by the
mailbox re-homing (the old #1335 timer failed loudly on unresolvable targets) and it breaks
the `/arch-save` clear→re-init sequencing `--delay` exists for.

**Decided design — durable delays, one mechanism:**

- Add `not_before INTEGER` (nullable, epoch-ms) to the mailbox table: in the base
  `CREATE TABLE` in `schema.ts` (fresh installs) AND a new migration — recommend **v17**,
  `PRAGMA table_info`-gated `ADD COLUMN`, mirroring v16's idempotent pattern. Do NOT edit v15
  in place: dev machines running this branch have already applied it.
- **All** delayed sends (live or held target) persist their row at REQUEST time with
  `not_before = now + deliverAfter*1000`. Resolution, authz (builder-spoofing), and formatting
  stay at request time — preserve the security property documented at `tower-routes.ts:1775-1779`.
  This makes live/registry/dead/unwritable targets uniform.
- **Drain eligibility:** a row is deliverable only when
  `status='held' AND (not_before IS NULL OR not_before <= now)`. Deliver the oldest ELIGIBLE
  row; a pre-due row must not block later normal mail (documented semantics: "`--delay 30`
  then `--delay 5` delivers the 5-second one first"). Update `findHeldForAgent` / `listHeld` /
  `deliverAgentMail` accordingly. The 1.5s backstop tick is acceptable due-time granularity —
  the delay is a lower bound.
- **Escalation:** pre-due rows must NOT escalate (they are scheduled, not stuck). Measure
  escalation age from `max(created_at, not_before)` so a row escalates only after being
  deliverable-but-stuck for the window.
- **Retire the in-memory delayed-send registry for the message body** (see change 2 for the
  one thing that remains of it). `--delay` becomes durable across Tower restarts. This is a
  **conscious reversal of Spec 1307's drop-on-restart semantics** (the rationale at
  `delayed-send.ts:17-28`), approved by architect + maintainer — document the reversal
  explicitly in the review artifact (and a spec delta note). The render gate now provides the
  protection that rationale wanted: a post-restart delivery still only lands on a
  render-verified empty prompt, and a stale pending message is visible and cancellable in
  `afx inbox`.
- **Response/CLI contract:** delayed sends keep `scheduled: true`, now also returning
  `mailboxId` (the row exists at request time) and `notBefore`. Remove/replace both
  "Pending delayed sends are dropped if Tower restarts." messages in `send.ts`. Bonus this
  design unlocks (mention it in the review): pending delayed sends become listable in
  `afx inbox` and cancellable via `afx inbox dismiss` — render the due time for pre-due rows.
  Keep the 3600s ceiling and the `escape`+delay rejection unchanged.
- **Docs — BOTH trees** (`codev/resources/commands/agent-farm.md` AND
  `codev-skeleton/resources/commands/agent-farm.md`): rewrite the `--delay` section's
  "**Not persisted.**" bullet (it now IS persisted and durable) and re-true the "Ordering"
  bullet (see follow-up C).

## Required change 2 — close the delayed-interrupt seam

**Verified defect** (`tower-routes.ts:1796-1827`): the due callback checks `isStillLive()` at
timer time only (`:1797`); `markMailboxDelivered` runs BEFORE the write (`:1808`); the
`submitToSession` callback (`:1809-1811`) never re-checks the predicate inside the lock —
despite `delayed-send.ts:112-118` and `:142-144` documenting exactly that contract, and
`spec-1307-send-delay.test.ts:216-235` testing only the predicate via a synthetic callback.
Worse: this branch writes via `writeMessageToSession` (no drop detection) rather than
`writeMessagePaced`, so a #1198 dead-socket drop is completely silent — the row stays
`delivered` with no log at all.

**Preferred shape under change 1 (recommended): stop writing the message body on this path.**

- At request time the row is already persisted with `not_before` (change 1).
- Keep a small in-memory timer ONLY to fire the Ctrl+C at due time. Inside `submitToSession`:
  re-check `isStillLive()` and re-fetch the session + check `writable` BEFORE writing the ^C;
  bail cleanly otherwise. No `markMailboxDelivered` anywhere on this path.
- The message body then delivers through the normal gated drainer (the ^C ends the turn →
  quiescence trigger → gate-verified delivery), inheriting all the drainer's correctness:
  written-boolean gating `markDelivered`, re-hold on drop, no double delivery (only the
  drainer writes the body).
- Degradation matches the precedent already documented at `:1802-1804` ("only the interrupt
  semantics gracefully degrade"): a restart during the wait loses the ^C nudge, never the
  message. Document the behavioral delta: the delayed message now lands via the gate after
  the ^C rather than atomically with it; if the post-^C screen isn't clean it holds (and
  escalates per change 3) instead of force-injecting — more aligned with the spec's no-force
  principle. The **immediate** `--interrupt` path keeps its documented claim-first tradeoff
  (`:1861-1871`) — do not change it.

**Fallback (only if the reshape hits a blocking problem):** keep claim-first, add the
inside-the-lock `isStillLive()` + writability re-check with a compensating re-hold BEFORE any
byte is written (safe: nothing on the wire yet), thread `writeMessagePaced`-style drop
detection, log drops loudly, keep the documented loss-over-duplication tradeoff for mid-write
drops. Do NOT naively flip to mark-after-write — that reopens the drainer double-delivery
race the claim-first ordering exists to close (`:1861-1865`; the per-agent serializer and
`submitToSession` are disjoint locks).

**Either way:** add the ROUTE-LEVEL test the maintainer asked for — drive `handleSend`'s
delayed-interrupt branch through a shutdown during lock-wait; assert nothing is written and
nothing is falsely `delivered`.

## Required change 3 — a reachable alarm for residue starvation

**Verified gap.** One stray visible character on an autonomous builder's composer classifies
`busy`/`user-text` → all its mail holds, including cron nudges (cron rows ride the same
mailbox). `busy` streaks are deliberately excluded from liveness telemetry
(`mailbox-delivery.ts:193-198`, `:665-671` — correct, keep that); escalation is SSE-only
(dashboard badge + VSCode toast) plus Tower log; `afx status` has zero mailbox awareness. So
headless/autonomous flows starve silently, and nothing tells anyone to run the remedy
(`afx interrupt`). Implement BOTH minimum pieces:

1. **`afx status`:** surface per-builder `heldCount` and the escalated attention state, plus a
   workspace total. The data already exists in the overview payload (`overview.ts:822-847`,
   `:984`) — reuse it rather than re-deriving. When escalated, print the remedy hint (e.g.
   "N held — `afx inbox` to inspect; `afx interrupt <id>` clears a stuck composer").
2. **Architect-mailbox escalation notice:** when a held row addressed to a NON-architect agent
   crosses a held-age threshold, enqueue a normal (non-injecting, gate-delivered) mailbox row
   to that builder's `spawnedByArchitect` describing who is starving, why (reason/detail), for
   how long, and the remedy. When `spawnedByArchitect` is unrecorded, fall back to the
   workspace's `main` — else first-registered — architect, mirroring `afx send architect`
   resolution. (Rows addressed to an architect get no notice — the alarm would land in the
   same starved mailbox; the `afx status` surface covers that case.) Guards:
   - supersede key per (workspace, agent) so repeated escalations coalesce to ONE pending
     notice (cron-style — reuse the `cron-delivery.ts` supersede pattern);
   - never emit a notice about a notice (exclude notice rows — recognizable by their
     supersede-key prefix — from triggering further notices);
   - supersede/clear the pending notice when the agent's held set drains;
   - threshold derived from `escalationMs` (a small multiple; configurable alongside
     `mailbox.escalationSeconds` if trivial).

## Take-now follow-ups (same pass)

- **B — `afx cleanup` dismisses held rows.** Cleanup currently touches no mailbox state and
  the prune removes only terminal-status rows (`db/mailbox.ts:300`), so a removed agent's held
  rows pin `heldCount`/escalated forever. On cleanup of an agent, transition its held rows to
  `dismissed` (audit-preserving).
- **C — docs.** Fix `codev/resources/commands/agent-farm.md:528` (stale "typing-aware send
  buffer" — the skeleton copy is already clean; classic mirror-both-trees miss, re-grep BOTH
  trees when done); re-true the "Ordering" bullet against mailbox semantics; rewrite the
  "Not persisted" bullet per change 1 (both trees).
- **D — hot-tier displacement swap.** In `codev/resources/arch-critical.md`, RESTORE the
  Spec 987 tier-routing meta-rule and displace the `git add -A` line instead (that rule stays
  enforced by CLAUDE.md/AGENTS.md's Git Workflow banner in every session and survives in cold
  `arch.md`). Net hot-fact count unchanged.
- **Doc over-claims (two spots — this is the maintainer's "docs currently over-claim").**
  (i) `mailbox-delivery.ts`'s header claims "there is exactly one place a message body is
  ever written to a PTY" — false while immediate interrupt/escape write outside it. Reword to
  scope the claim (gated deliveries) and name the documented exceptions. (ii)
  `codev/resources/arch.md` §mailbox "How it works" item 5 ("**Per-PTY write serialization.**
  … so concurrent sends can't interleave/blob") over-claims twice: the serializer is keyed
  per-AGENT (`agentKey`), not per-PTY, and interrupt/escape ride the separate per-terminal
  submission lock — so a gated delivery CAN interleave with an interrupt (the documented
  accepted boundary at `session-submit.ts:44-68`). Reword to per-agent and name the
  exception. While there, item 5's "Held rows drain in `created_at` (enqueue) order per
  agent" gains the change-1 eligibility qualifier (oldest ELIGIBLE; pre-due rows excluded).

## File-as-issue (NOT this PR)

- **Serializer convergence:** route the mailbox write edge through `submitToSession` so gated
  deliveries serialize against interrupt/escape — already flagged in-code at
  `tower-routes.ts:1881-1886` and `session-submit.ts:44-68`. File a GitHub issue citing those
  pointers; note there is no lock-cycle hazard (the per-terminal lock would be taken as a leaf
  inside the per-agent serializer).

## Required tests (beyond the route-level one in change 2)

- Hold-path delay preservation: `--delay` to a dead / unwritable / registry-only target does
  not deliver before due; delivers after due once gate-clean.
- Durability: a pre-due row survives a drainer stop/start (Tower-restart analog) and still
  delivers not-before-due.
- Eligibility ordering: a pre-due row does not block later normal mail; due rows deliver
  oldest-first among eligible.
- Escalation: pre-due rows never escalate; a due row escalates only after `escalationMs` of
  deliverable-but-stuck.
- Migration v17 idempotency (fresh DB + already-migrated DB) — extend
  `spec-1313-migration.test.ts`.
- `afx status` held/escalated rendering.
- Architect notice: emitted once (coalesced), no notice-about-notice, cleared on drain.
- Cleanup dismisses held rows.

## Invariants (non-negotiable; re-verified at re-review)

1. A delayed message never delivers before its due time; a dropped/ignored delay is never
   silent.
2. No message body is written to a PTY after the shutdown decision for it; nothing is marked
   `delivered` unless the write settled successfully. Sole exception: the interrupt paths'
   documented claim-first tradeoff — always true of immediate `--interrupt`; true of delayed
   `--interrupt` ONLY if change 2's fallback is taken, in which case the deviation from the
   maintainer's "mark delivered only after the write settles" MUST be loudly logged,
   documented in the review artifact, and explicitly flagged to the maintainer at re-review.
   (The preferred reshape has no exception — prefer it.)
3. No double delivery of any row.
4. Escalation/alarms remain visibility-only — never a force path.
5. CLAUDE.md/AGENTS.md untouched (byte-identical to origin/main); both doc trees updated
   together.

## Process

Work on your branch as usual; commit this directive file alongside the changes. Update the
review artifact: document the Spec 1307 drop-on-restart reversal and the delayed-interrupt
reshape as explicit decisions with their rationale. Run the full agent-farm suites plus the
spec-1313 e2e. When the round is pushed, message the architect (`afx send architect "..."`) —
the `pr` gate stays held until architect + maintainer re-review. **Do not merge.**
