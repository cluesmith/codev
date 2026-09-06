# PIR Plan: Bounded-patience send

## Understanding

Issue #1481 adds `afx send --interrupt-after <seconds>`: attempt ordinary gated delivery immediately, hold while busy, and interrupt only if the message remains held at the deadline. Normal sends remain hold-only; `--interrupt` remains urgent/force-now; `--delay` remains delayed eligibility.

**Human decision required before implementation:** “force-deliver” in the issue and the suggested delayed-interrupt reuse describe different contracts. This plan recommends **one deadline-triggered Ctrl+C attempt, followed by gated body delivery**, not an ungated body write. If Ctrl+C does not produce a verifiably clean prompt, the body remains held and eventually alarms. This bounds patience before interruption, **not time to body delivery**. Approval must explicitly settle this distinction; an ungated force-body requirement requires revising this plan, not silently weakening that requirement during implementation.

Investigation at branch base `08ec15122`:

- `packages/codev/src/agent-farm/cli.ts:452-488` exposes interrupt/delay but no bounded-patience option.
- `db/mailbox.ts:148-161` separates eligibility (`not_before`) from escalation age. Setting `not_before` to the interruption deadline would incorrectly prevent early clean delivery.
- `servers/tower-routes.ts:1812-1863` implements delayed interruption as an in-memory, original-terminal-bound Ctrl+C nudge. Its body stays gated and its nudge is lost on restart. Immediate interruption at `:2145-2225` instead claims the row before an ungated body write, preferring possible loss over duplicates.
- `servers/session-submit.ts:350-435` serializes writers, but computes bounded waiting once at enqueue. A second operator queued behind a first operator and a long delivery becomes unbounded even after the first operator finishes.
- `servers/mailbox-delivery.ts:1012-1065` awaits agents sequentially before alarms. Deadline work must not add operator-lock waits to that loop.
- `db/mailbox.ts:373-387` supplies both owner-alarm age and episode-clearing membership. Merely skipping an entire recipient because one row has a deadline would hide unrelated starving mail.

All shortened source paths above are under `packages/codev/src/agent-farm/`.

## Proposed Change

### 1. Public contract and persistence

- Accept `interruptAfter` seconds in the CLI send options, SDK `sendMessage`, and Tower `/api/send`. Accept finite numbers greater than zero and at most 3600 seconds, including fractions; use the existing delay bound/validation semantics without delay-specific error wording. Reject invalid input before persistence in both CLI and server.
- Reject combination with `--interrupt`, `--delay` (including explicit API `deliverAfter: 0`), or API `escape`; none has an unambiguous combined contract. Preserve `--raw`, `--no-enter`, `--file`, `--all`, named/cross-workspace addressing, and existing authorization checks. Each broadcast recipient receives its own deadline when persisted.
- Add nullable `interrupt_at` and `interrupt_attempted_at` epoch-ms columns. New ordinary rows default to null. New bounded-patience rows have `not_before = NULL`, `interrupt_at = enqueueTime + seconds*1000`, and no attempt timestamp. Keep the deadline for audit after resolution/attempt.
- Add the next migration (currently v19 after v18), using the real `runGlobalMigrations` runner, with fresh schema/upgrade convergence and idempotency tests. Never change a historical migration in place.
- Persist before the initial gated attempt, including offline/registry-only/dead/unwritable targets. Return the real `delivered`/`held` outcome plus deadline metadata, never `scheduled` solely because an interrupt is armed. Show deadline/attempt metadata in inbox detail and truthful CLI hold output. A send response cannot retrospectively claim the later interruption succeeded.

### 2. Durable interruption coordinator; reuse the serialized write edge

Introduce a small injected-port coordinator (`servers/mailbox-interrupt.ts`), owned by mailbox wiring and its start/stop lifecycle. Its durable source is held rows with a due, unattempted deadline; it is not a second body-delivery queue.

- An independent bounded polling pass (existing backstop cadence, currently 1.5 seconds) schedules due work without awaiting terminal lock acquisition in the global drainer/alarms loop. Coalesce pending work by mailbox row ID and release bookkeeping on both success and failure. One blocked terminal cannot block another agent's deadline or alarms.
- At enqueue the body is immediately eligible; ordinary gate delivery can win until the interruption write actually begins. A deadline is a lower bound, with tick/lock latency, not a hard real-time guarantee.
- Resolve the canonical recipient's current session when scheduling. Inside `submitToSession`, re-read the row, deadline, attempt state, lifecycle generation, and current session identity/writability. If delivered, dismissed, superseded, stopped, or replaced while queued: write nothing. Retry a replaced/offline target on a subsequent tick with its current session; never write to a captured obsolete session.
- At a valid write edge synchronously claim the one interrupt attempt before Ctrl+C, with a conditional DB update (`held`, due, not attempted). Send only Ctrl+C through `submitToSession`, using the existing operator ceiling and degraded-write diagnostics/counting (`wroteBytes` must reflect a real write). Do not mark the message delivered. Nudge the gated drainer only after leaving the terminal critical section; never take an agent lock inside the terminal lock.
- This is agent-addressed durable intent: restart before the deadline preserves both body and future interrupt; restart after the deadline retries an unattempted interruption against the current live session. Offline recipients retain the armed action until they return or the message is cancelled/delivered. This can interrupt a later turn, so document it prominently and expose cancellation through `afx inbox dismiss`.
- One-shot crash tradeoff: persisting the attempt immediately before a nontransactional PTY write can lose the nudge if Tower crashes there. Do not replay a claimed attempt after restart or loop Ctrl+C on a stubborn prompt. The body remains held, survives restart, and can alarm. A returned write failure is logged, with the attempt retained rather than blindly retried.
- Dismiss/supersede/deliver before the in-lock check cancels the nudge. Once Ctrl+C is written it cannot be recalled. A gated write already in progress may be interrupted by the existing degraded-ceiling path; preserve its interference detection and do not invent a second body writer. Test this explicitly; do not claim exactly-once PTY effects across a crash/partial write.

### 3. Fix the queued-operator corner in the shared primitive

Replace the enqueue-time `behindOperator` decision with explicit predecessor completion tracking:

- Keep an operator-only completion chain separate from the combined submission tail.
- An operator must await all preceding operators' **actual writes**, never their delivery-containing combined tails. Against non-operator predecessors it races its configured ceiling; measure the delivery budget from enqueue, so a budget already expired is not reset when a preceding operator drains.
- Run only once both conditions hold: preceding operators finished, and combined predecessors finished OR the delivery ceiling expired. Thus operator-vs-operator remains serialized, while operator 2 need not wait for the entire original long delivery after operator 1 finishes.
- The public combined tail still covers predecessors plus the current write, preventing later delivery writers from slipping past unfinished work. Preserve error isolation, no-op bypass accounting, cleanup/reset hooks, and ordinary uncontended behavior.
- Update boundary comments and regression tests for two/three operators, interspersed deliveries, failure, and no-op writers. Reuse this primitive for the new coordinator rather than creating a competing serializer.

### 4. Alarm treatment

- Give bounded-patience rows an escalation start of `max(created_at, not_before, interrupt_at)` (nulls fall back to creation). This grants the normal escalation and owner-notice grace periods after the deadline even if the one-shot nudge fails. Existing rows retain existing clocks.
- Exclude **only predeadline rows** from owner-starvation aggregation/membership; include ordinary held rows for the same agent. After the deadline the bounded row participates normally, including if offline or already attempted.
- Use the same start calculation for SQL queries and emitted `ageMs`. Keep ordinary eligible held counts/inbox visibility unchanged: bounded-patience mail is held, not future-scheduled mail.
- Test clearing a prior owner notice when its ordinary starving rows resolve and only predeadline rows remain; after the deadline a genuinely stuck row can create a new episode.

## Files to Change

- `packages/codev/src/agent-farm/{cli.ts,types.ts,commands/send.ts}` — flag validation, forwarding, hold guidance.
- `packages/sdk/src/tower-client.ts`, `packages/types/src/api.ts` — request/response and inbox metadata; maintain server/client package isolation.
- `packages/codev/src/agent-farm/db/{schema.ts,migrations.ts,types.ts,mailbox.ts}` — columns, real migration, atomic attempt claim, due-row query, alarm age/membership.
- `packages/codev/src/agent-farm/servers/{tower-routes.ts,mailbox-wiring.ts,mailbox-delivery.ts,session-submit.ts}` — persist policy, lifecycle, shared operator fix, diagnostics and age reporting.
- `packages/codev/src/agent-farm/servers/mailbox-interrupt.ts` — new independently scheduled coordinator with testable time/session/write ports.
- `packages/codev/src/agent-farm/commands/inbox.ts` — show deadline/attempt state without changing held/scheduled grouping.
- Focused additions to `__tests__/{mailbox.test.ts,mailbox-owner-notice.test.ts,send.test.ts,tower-routes.test.ts,spec-1365-serializer-convergence.test.ts,spec-1273-submission-lock.test.ts}` plus new `pir-1481-{migration,interrupt-after,owner-wiring}.test.ts` and `pir-1481-interrupt-after.e2e.test.ts` under the same agent-farm test directory. Add SDK serialization coverage in its existing test tree.
- `codev/resources/commands/agent-farm.md` and its `codev-skeleton/` twin; `.codex/skills/afx/SKILL.md`, `.claude/skills/afx/SKILL.md` and both skeleton twins — usage, force-now vs time-sensitive, durability/cancellation/limitations.
- `codev/resources/arch.md` — settled write-edge and timeout contract (use the arch-doc skill); review/thread artifacts record evidence and limitations. No dashboard UI changes are proposed.

## Risks & Alternatives Considered

- **Ungated body at deadline:** closest to literal “force-deliver,” but permits draft/menu corruption and inherits claim-before-write loss. It also needs row ownership coordination with an already-running gated write to avoid writing the same body twice. Not selected in this proposal. Human selection of that contract requires a revised ownership/race design before implementation.
- **Reuse the existing in-memory delayed interrupt timer unchanged:** simpler, but loses timeout intent on restart, targets a captured PTY, and its existing callback does not cancel on body resolution. Reuse only the established serialized Ctrl+C/gated-body model, not its weaker lifecycle semantics. Existing `--delay --interrupt` behavior remains unchanged.
- Durable offline intent may interrupt a fresh session long after enqueue. This is a deliberate proposed contract, not an unnoticed side effect; cancellation and documentation are essential.
- Wall-clock deadlines follow existing epoch-ms eligibility conventions; a backward/forward system-clock jump postpones/advances the due pass. Fake-clock tests pin boundary behavior.
- Do not reopen #1365/#1476: both prerequisites are merged. #1477 PR #1625 and #1473 PR #1634 remain OPEN/unmerged at planning time.
- Read #1477's two reference tests under `/home/user/code/codev_root/codev/.builders/air-1477/packages/codev/src/agent-farm/__tests__/` without modifying them. Reuse its seeded-registry + real `makeDeliveryPorts` pattern in a separate #1481-specific test, not its branch or whole files. No cherry-pick/merge of either parked PR. Once maintainers land them, rerun their suites with ours and reconcile shared helper duplication if necessary.
- Do not assume #1473 input tracking exists: retain current output-token and serialized-write guards. Exercise no duplicate completed body write under normal cancellation/deadline races, while acknowledging the existing degraded partial-write boundary.

## Test Plan

### Deterministic automated coverage

1. CLI/API/SDK: positive fractions and bounds; zero, negative, nonfinite, string/null API input and conflicting flags rejected without rows; all send routes/broadcasts preserve the option and authorizations. Existing sends/delay/interrupt/escape remain unchanged.
2. Real migration runner: fresh DB, v18 upgrade with held/delivered rows, repeated runner invocation, reopen persisted DB; compare schema/defaults/indexes and preexisting values.
3. Fake clock/real DB: immediate clean delivery with no later Ctrl+C; hold then clean before deadline; busy at/exactly after deadline; one Ctrl+C then gated body; stubborn/no-profile prompt remains held and alarms; no repeated attempt.
4. Deferred-lock races: deliver/dismiss/supersede while queued, competing coordinator ticks, teardown/replacement, stop/start generation, thrown/dropped writes and claim/write crash window. Assert bytes, DB states, count/notice events, and cleanup—not merely timer callbacks.
5. File-backed restart/offline: preserve deadline before/after due; unattempted vs attempted restart; session replacement before/during lock wait; offline return resolves current canonical agent session.
6. Serializer: >2-second delivery with two operators queued during it; operator 2 runs after operator 1 finishes without awaiting the long delivery, but never overlaps operator 1. Third writer remains correctly chained. Verify unrelated agents' delivery/alarms progress.
7. Alarms: predeadline suppression, ordinary starving mail to the same recipient still alarms, deadline-based postdeadline grace, correct held counts, notice membership clearing/rearming, no notice-on-notice recursion. Seed real owner registry and invoke production wiring as in #1477.
8. Run focused suites, SDK/type builds, package build and complete non-watch unit suite. Run porch's required checks and consultations when porch requests them; do not hand-run its review cycle.

### Running worktree evidence before dev-approval / PR

Use the existing `send-integration.e2e.test.ts` child-Tower pattern: isolated `CODEV_AGENT_FARM_DIR`/DB and test workspace, separately allocated port (never 4100), real shellper/PTY, and the worktree-built CLI invoked from the test workspace root. Use a deterministic interactive PTY fixture rendering a supported composer and recording Ctrl+C/text/Enter; also demonstrate clean/busy behavior with a real supported agent CLI to validate the classifier against its actual prompt. Save timestamped transcripts and commands in the review.

Exercise clean-before-deadline/no later interrupt; busy-through-deadline; body resolution/cancellation during contention; offline/session replacement/restart; two queued operators behind a long paced write; starvation suppression alongside ordinary mail; one completed body delivery; unchanged flags and invalid combinations. Separate fake-clock proofs from real-PTY observations—do not claim fixture output is live-agent evidence. Never stop/restart the live Tower, signal architect/builder sessions, or clean up existing worktrees. Stop only harness-owned child processes after verifying ownership.

## Commit / Gate Sequence

1. Commit/push this plan and requirements/thread notes; stop at `plan-approval`, explicitly requesting the timeout-body semantic decision above.
2. After human approval: persistence/API changes; coordinator/operator/alarms changes; tests/docs/live evidence as logically separate commits in **one PR**. Let porch own phase transitions and 3-way review.
3. Stop at `dev-approval` with runnable evidence. Open PR only when porch permits; notify architect and record it with porch.
4. Contributor constraint: every PR needs maintainer/reviewer approval; **maintainer merges**. Do not merge, close issues, or clean up worktrees.
