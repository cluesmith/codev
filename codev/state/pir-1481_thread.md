# pir-1481 builder thread

## 2026-09-06 — Plan draft

Started strict PIR for #1481 from `08ec15122` (plus porch init commit). Read builder role, porch/afx skills, hot context, current mailbox architecture, issue comments and #1365 closure. No implementation edits made.

Confirmed the key semantic decision: existing delayed interrupt writes only Ctrl+C and retains the gate; immediate interrupt claim-first writes an ungated body. Plan proposes durable one-shot Ctrl+C followed by gated body, and explicitly requires human selection before coding because this is not a bounded body-delivery guarantee. Separate deadline from `not_before`; independently schedule due actions so terminal contention does not block global alarms. Fix second-operator wait using actual operator completion separate from combined delivery tails.

Read (read-only) #1477 owner-wiring and cleanup-invocation test references. PRs #1625 and #1634 remain open; no sibling work imported. Plan reuses seeded-registry testing pattern independently and requires integration reruns after maintainer landing. Contributor constraint recorded: maintainers merge; builder does not merge, close issues, or clean worktrees. Live Tower 4100 must remain untouched; test only isolated harness-owned instances.

Artifacts share `1481-afx-send-add-interrupt-after-s.md`; plan is the current deliverable, requirements note preserves issue authority. Awaiting human plan review after commit/push and porch completion.

## 2026-09-06 — Human-directed plan revision (no approval)

Architect relayed issue comment 5561508091: human selected existing immediate interrupt behavior after the patience budget (Ctrl+C + fixed settle + ungated body), and authorized PLAN REVISION ONLY. Supersedes the earlier gated-body recommendation. No code changes or gate transitions.

Revised plan shares the immediate writer, arms exact-deadline timers before initial-delivery awaits, and arbitrates same-row ownership inside the terminal write edge. Normal writes retain ownership through DB outcome; successful in-flight delivery cancels force, uncertain partial writes skip force to avoid a second timeout body. Force conditionally claims the original row before bytes, accepting existing loss-over-duplicate crash semantics; logs/inbox/notifications must not imply receipt.

Remaining lifecycle proposal, explicitly unapproved: body/deadline audit durable, force authority current-Tower-lifetime only; restart disarms, offline/unwritable at deadline skips, session replacement while waiting skips rather than late retargeting. Replacement before deadline follows current agent-addressed routing. No indefinite late-force retry. This minimizes surprise but sacrifices force across restart even before deadline; human can choose future-only rearm through another revision.

Will commit/push revised plan + requirements snapshot + this thread and report SHA/path, then remain at existing plan-approval. Maintainer-only merge/no closure/no worktree cleanup constraints unchanged.

## 2026-09-06 — Claude COMMENT dispositions, plan-only refinement

Read architect dispositions in issue comment 5561637175 before the raw Claude review. Verified delay validator integer-only check, 48-KiB API cap, current dropped/preempted re-hold behavior, terminal tail cleanup/try-lock decline, and mailbox broadcast→activity / held-change→overview wiring. Raw F1 numeric example is not a reproduced duplicate; plan uses valid paired ordering traces and does not claim the already-preempted delivery was clean.

Refined plan: actual write-edge unfinished predecessor state plus real bytes governs degradation; operator-only tails settle through rejection/no-op and evict by identity. Explicit event fanout prevents direct/helper duplicates; composite force outcomes preserve degraded+failed; dedicated finite fractional timeout validator shares only the existing ceiling. Document separate patience/submission clocks, unbounded operator wait, overtaking older held mail, and short-line duration risk within the already-enforced 48-KiB cap.

F3 narrowed proposal supersedes permanent partial-write cancellation: keep force armed after an uncertain ordinary attempt, wait for active ownership plus DB outcome, then allow a sequential force only if still held. Success/cancellation still wins; uncertainty may mean duplicate prior effects and must be surfaced via persistent prior-partial flag, inbox/API and warnings. This is a proposed risk tradeoff, not exactly-once or a human-approved policy. Restart/offline/replacement proposals unchanged and unapproved. No implementation, consultation hand-run, or porch gate advancement.

## 2026-09-06 — Session resumed, still at plan-approval

Resumed builder session; no context loss. Verified: `porch next 1481` → `gate_pending` (phase `plan`, iteration 1, gate `plan-approval`); HEAD `e6d2799af` matches `origin/builder/pir-1481`; worktree clean apart from untracked spawn scaffolding. Re-read the latest issue comment (architect verification of the Claude follow-up) — no approval, no new revision instruction, no reviewer edits in the diff.

Two human policy decisions remain open and unanswered: (1) no catch-up force after Tower restart / unwritable target at deadline / session replacement while queued; (2) one sequential forced retry after a possibly partial normal write, with duplicate-effect warnings. No implementation, no gate advancement. Holding.

## 2026-09-06 — Implement phase

Plan `e6d2799af` approved by the human (both lifecycle decisions accepted as proposed: no
catch-up force after restart / unavailable target / session replacement; one sequential forced
retry after an *uncertain* partial write). `porch approve 1481 plan-approval` recorded, phase is
`implement`.

**What was built.** Migration v19 adds four mailbox columns (`interrupt_at`,
`interrupt_claimed_at`, `interrupt_outcome`, `interrupt_prior_partial`). Two new modules:
`servers/mailbox-interrupt.ts` (the deadline coordinator — absolute-deadline timers armed
*before* the first gated await, guarded claim at the write edge, skip/outcome recording, restart
sweep) and `servers/row-write-ownership.ts` (a synchronous non-blocking per-ROW token both body
paths take immediately before their first byte). `message-write.ts` now owns the one shared
`writeInterruptToSession` — `^C`, a 100 ms settle, the paced body — used by BOTH the immediate
`--interrupt` route and the timed escalation, so there is exactly one force writer in the system.

**Two deliberate changes to #1365's semantics**, both mandated by the plan's §3:

1. The enqueue-time `behindOperator` decision is replaced by an operator-only completion chain
   (`operatorTails`). An operator now always arms its ceiling — measured from *its own* enqueue —
   and runs when *preceding operators have finished* AND (*predecessors finished OR the ceiling
   expired*). That is what stops a second operator queued behind a first operator and a long
   delivery from inheriting an unbounded wait.
2. Degradation became a **write-edge fact** read from a new per-session `activeWrites` counter,
   not a latched timer. `onCeilingExpired` and the bypass counter now fire only when bytes
   actually went out. This deliberately changed one existing #1365 assertion (a degraded write
   that writes NOTHING is now neither counted *nor announced*) — renamed in place rather than
   added, because the old assertion asserted the behaviour the plan replaces. Timed forces
   decline to write far more often than they write, so the old latch would have produced a
   steady stream of "proceeded UNSERIALIZED" warnings about submissions that wrote nothing.

**Tests.** New: `pir-1481-migration`, `pir-1481-interrupt-after` (35), `pir-1481-owner-wiring`
(15, real drainer + seeded registry), `pir-1481-interrupt-after.e2e`. Extended: route-level
`--interrupt-after` boundary tests in `tower-routes.test.ts` (131 pass), CLI forwarding + force
warnings in `send.test.ts` (40), the SDK wire contract in `packages/sdk` (13), and the §3
operator-chain traces in `spec-1365-serializer-convergence.test.ts` (35), including the plan's
F1 trace and its companion where the delivery really is still running.

**Baseline, verified rather than asserted.** Mid-implementation the suite showed 15 failing
files. Twelve were environmental — `packages/codev/skeleton` and `dist` do not exist until a full
build, and those tests say so themselves. `pnpm --filter @cluesmith/codev build` was run in the
worktree and **all twelve went green**, confirming the diagnosis instead of leaving it a claim.
The other three (`spec-1313-migration`, `send-architect-identity`,
`spec-1365-serializer-convergence`) were genuinely this change's and are fixed. Final state:
`packages/codev` **287 files / 5797 tests pass, 0 fail** (3 files, 48 tests skipped — pre-existing
skips), `packages/sdk` **11 files / 135 tests pass**, `tsc --noEmit` clean in both, build clean.

**Docs.** `codev/resources/commands/agent-farm.md` + skeleton twin; all four `afx` SKILL.md files
(kept byte-identical in pairs); `codev/resources/arch.md` (mailbox section 7 rewritten: two
bypasses, coordinator mechanics, the per-row ownership rationale, lifetime-scoped force
authority, alarm interaction) and the hot mailbox invariant in `arch-critical.md` — amended in
place, no new hot fact, cap unchanged. CLAUDE.md/AGENTS.md include the hot file by `@` reference,
so neither needed editing.

**Judgement calls worth naming in the review** (not re-litigating): `MAX_FORCE_DISPATCHES = 4` as
a loop guard, with an exhausted row left `armed` (truthful — it was never claimed) for the next
restart to retire; the coordinator leaves `interrupt_outcome = 'armed'` on a row another path
delivered, because row `status` is authoritative for cancellation.

### Running-worktree evidence (real PTY, isolated child Tower)

Captured under `.builder-evidence/` (untracked; the review file will carry the transcripts).
**Fake-clock proofs and real-PTY observations are kept separate** — everything below is the
latter, from a live shellper PTY.

- `pir-1481-interrupt-after.e2e.test.ts` — child Tower on **14620** (never 4100), its own
  `CODEV_AGENT_FARM_DIR`/DB, throwaway workspaces, real shellper `stty raw -echo; cat` terminals
  painted with the exact claude composer bytes the render gate classifies. 4/4 pass in 19.4s:
  clean-before-deadline (delivers normally, then **no ^C and no second body** after the deadline
  passes); busy-through-deadline (**exactly one ^C, preceding exactly one body**); flag validation
  + the three refused combinations + an unchanged ordinary send; and a real Tower **restart** that
  leaves the row `held` with `skipped-restart`, keeping the deadline as audit and then delivering
  it through the gate with no ^C at all.
- `capture-raw-pty.mjs` → `raw-pty-capture.log` — the same busy-through-deadline path on port
  **14621**, dumping the terminal's actual output ring with control bytes escaped. Observed:
  ring is unchanged 1.2 s into the window (no body, no ^C); after the deadline the ring holds
  `⟪^C⟫` immediately followed by the formatted body; `^C count: 1  body count: 1`; the row reads
  `status: delivered`, `interruptClaimedAt` **1 ms** after `interruptAt`, outcome
  `written-unverified`, `interruptPriorPartial: false`.
- `cli-flag-capture.log` — the worktree-**built** CLI (`packages/codev/bin/afx.js`): `send --help`
  showing the flag, and all four invalid values rejected with exit 1. These exit before any
  network call, which is why they are safe to run here: the CLI has no port override, so a CLI
  send would necessarily target the live Tower on 4100. Every send-path observation above
  therefore goes through HTTP against the isolated child Tower instead.

Only harness-owned child processes were stopped; the live Tower on 4100 was never touched, and no
other builder's worktree was read or modified.

## Resume — parked at dev-approval (2026-09-07)

Resumed session; no context loss and no work outstanding. Verified rather than assumed:
`porch next 1481` → `gate_pending` (phase `implement`, iteration 1, gate `dev-approval`);
HEAD `286b8c404` equals `origin/builder/pir-1481` after a fetch, so every implementation,
test, docs and evidence commit is pushed; working tree clean apart from untracked spawn
scaffolding. Re-read the issue — the newest comment is still the architect's plan-approval
record, so no reviewer edits, revision instructions or new dispositions have arrived.
Re-notified the architect that the gate is ready (held for a busy prompt, delivers on clear).
Standing orders unchanged: no `porch approve` without an explicit relayed human approval,
no merge, no issue closure, no cleanup. Waiting.

## Review phase + consultation fixes (2026-09-07)

Approved `dev-approval` on the architect's relay, wrote the retrospective, routed two cold
lessons, opened **PR #1640**, recorded it with porch, and ran the consultation porch scheduled.

**Porch scheduled a 2-way pass, not 3** — the verify task listed only codex and claude; gemini
was never requested. **Claude produced no verdict**: both the first run and a retry aborted with
`Prompt is too long` before any review text, and no output file was written. So this diff carries
**one** model's opinion. Flagged to the architect at the gate rather than presented as "2 of 3
approve".

**Codex: REQUEST_CHANGES (HIGH).** Six findings; I checked every one against the actual files
before acting, per the standing lesson about reviewer claims. Five were real:

1. **Real bug.** `broadcastForcedDelivery` dropped `outcome`/`priorPartial` converting the frame
   for the message bus — a `failed` force reached the feed as an ordinary delivery. Two code
   comments asserted the opposite, which is exactly how it survived. Fixed by threading optional
   metadata through the shared `broadcastDelivered` and widening `MessageFrame.metadata`.
2. **Real bug.** `surfaceForceOutcome` told the human a `failed` force "was force-delivered".
   Failed now gets its own wording (write REJECTED, row already claimed, will not be retried).
3. **Real bug, and I had flagged it as a mere judgement call in the review.** Exhausting
   `MAX_FORCE_DISPATCHES` left `interrupt_outcome = 'armed'` durably with nothing armed — the
   inbox would promise an escalation for the rest of the Tower lifetime. New terminal outcome
   `skipped-contended`; ceiling check moved after the row/cancellation read so the row is in hand.
   No migration needed (no CHECK on the column, deliberately).
4. **Real gap.** The coordinator suite asserted the frame handed *to* the port and never ran the
   conversion, which is why (1) was invisible. New `pir-1481-force-wiring.test.ts` drives the real
   `makeInterruptPorts` over the whole outcome matrix — **9 of its 16 fail without (1) and (2)**.
   The contention give-up has its own test, which fails against the old shape.
5. **Real doc defects.** `agent-farm.md` still said held mail is "never force-injected" (fixed in
   both trees); my own review claimed non-integer values are rejected when **fractions are valid
   on purpose**; and my "How to Test Locally" said to restart Tower without saying *which* Tower —
   following it against 4100 would kill every running builder. All corrected.
6. Not a finding: their sandbox was read-only and could not run tests.

**Real-agent evidence (Codex's fifth point, and a genuine plan requirement I had missed).** The
plan asks for clean/busy behaviour against an actual supported agent CLI; my dev-approval evidence
was all fixture composers. Added `capture-real-agent.mjs` — child Tower on **14622**, real `claude
--permission-mode plan` in a shellper PTY, throwaway workspace. Results: an ordinary probe against
the real composer returns `delivered=true` (classifier validated on a screen nobody here painted);
a **real half-typed draft** holds `busy`/`user-text` and then forces at the deadline with
`interruptClaimedAt == interruptAt`, outcome `written-unverified`; **mid-turn**, the agent reached
a clean prompt inside the window and the ordinary gated delivery won — row `delivered`,
`interruptClaimedAt: null`, nothing forced.

Two failed attempts before that one, both recorded rather than hidden: `claude` opens on a
trust-folder prompt, and the ESC I used to "clear the composer" **exits the CLI**, so every send
honestly reported `no-live-pty`. Also learned that the trust prompt cannot be detected by its
phrase — the TUI interleaves cursor-position escapes between words.

**One honest limitation now written into the review:** a real TUI does not echo injected bytes into
its output ring and it redraws, so occurrence counts there are not write counts. The mailbox row is
authoritative for a real agent; the byte-exact `^C count: 1 / body count: 1` proof stays with the
`cat` fixture. Both instruments are kept for that reason.

**Suite after the fixes:** `packages/codev` **288 files / 5814 tests pass, 0 fail** (was 287/5797).

Standing orders unchanged: not maintainers — no merge, no issue closure, no cleanup. Waiting at
the `pr` gate.

### Blocked: the Claude consultation cannot complete on this diff

Four attempts, three failure modes, none producing an output file — so porch will not leave the
review phase:

1. `Prompt is too long`, before any review text.
2. Same.
3. Read well into the implementation, then died on a **usage limit**.
4. Got furthest: read the review, verified the code against its claims, reached the serializer
   hunk, said it was *"verifying the two potential issues I spotted before finalizing"* — then
   `Prompt is too long`. **Those two issues were never named.**

Attempt 4 is the informative one: the model can start, but ~4.7k lines across 41 files leaves it
no room to write a verdict. Structural, not transient — a fifth identical attempt is not a plan.

Recorded in the review honestly (one verdict, not two; and one reviewer knew of something it
never got to state, so `session-submit.ts` §3 deserves the extra human care that missing second
opinion would have given). Asked the architect for the call: retry, manual override to proceed on
Codex's verdict alone, or something else. Not merging, not closing the issue. Waiting.
