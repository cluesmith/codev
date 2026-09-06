# PIR Plan: Bounded-patience send

## Understanding

Issue #1481 adds `afx send --interrupt-after <seconds>`: attempt ordinary gated delivery immediately, hold while busy, and interrupt only if the message remains held at the deadline. Normal sends remain hold-only; `--interrupt` remains urgent/force-now; `--delay` remains delayed eligibility.

**Human-directed contract (2026-09-06, issue comment 5561508091):** initially behave exactly like ordinary send; at the deadline initiate existing immediate `--interrupt` semantics for the **same still-held row**: Ctrl+C, existing 100 ms settle, **ungated** formatted body, and Enter unless `--no-enter`. A busy/unverifiable gate must not prevent this force-body transition. This supersedes the earlier Ctrl+C-only proposal. The budget bounds initiation of escalation, not event-loop/lock latency, completed writing, or agent acknowledgment. It does not guarantee receipt or exactly-once PTY effects.

**Remaining product choice for plan approval:** recommend **no catch-up force after Tower restart or an unavailable deadline target**. Persist the body and deadline/audit, but keep force authority tied to the current Tower lifetime. At the deadline resolve the current canonical recipient session once; if absent/unwritable, skip the force and retain ordinary held delivery. If that session is replaced while waiting, skip rather than retarget a later turn. Tower restart disarms pending force even when its deadline is still in the future. This intentionally favors avoiding surprising late interrupts over durable force intent, like the existing delayed-interrupt lifetime boundary. These lifecycle choices are proposals, **not yet approved**. An alternative is to rearm future deadlines on restart while skipping already-overdue ones; human selection requires updating the lifecycle tests and documentation before coding.

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
- Add nullable `interrupt_at`, `interrupt_claimed_at` epoch-ms columns and `interrupt_outcome` audit metadata. Ordinary rows default to null. Bounded-patience rows have `not_before = NULL`, `interrupt_at = enqueueTime + seconds*1000`, no claim timestamp, and outcome `armed`. Outcomes distinguish `claimed` (write may not have happened), `written-unverified`, `degraded`, `failed`, and skips (`offline`, `session-replaced`, `restart`, `partial-normal-write`); row status separately remains authoritative for delivered/dismissed/superseded cancellation. Keep deadline/claim metadata after terminal resolution. Never insert a replacement row for escalation.
- Add the next migration (currently v19 after v18), using the real `runGlobalMigrations` runner, with fresh schema/upgrade convergence and idempotency tests. Never change a historical migration in place.
- Persist before the initial gated attempt, including offline/registry-only/dead/unwritable targets. Return the real `delivered`/`held` outcome plus deadline metadata, never `scheduled` solely because an interrupt is armed. Show deadline/force-outcome metadata in inbox detail and truthful CLI hold output. A send response cannot retrospectively claim the later interruption succeeded.

### 2. Prompt deadline coordinator and one shared interrupt writer

Introduce `servers/mailbox-interrupt.ts`, owned by mailbox wiring and its start/stop lifecycle, with injected clock/session/DB ports. This coordinates ownership of an existing row; it does not enqueue another body.

- Arm an absolute-deadline timer immediately after persistence, **before awaiting the first gated attempt**. Use `max(0, interrupt_at - now)` rather than starting the patience budget after a slow initial delivery. No extra 1.5-second polling delay. At callback entry recheck wall time (rearm if it moved backward); coalesce by row ID and capture lifecycle generation. Start due submissions independently without awaiting terminal waits in the global drainer/alarms loop.
- Normal gate attempts continue during the window and can win while escalation waits. A timeout callback starting is not a claim. Recheck row state, deadline, lifecycle, current session identity and writability **inside the terminal submission callback**, immediately before claiming/writing.
- Extract the existing Ctrl+C + `writeMessageToSession(..., 100)` sequence into a shared interrupt writer in `message-write.ts`, called by both immediate send and timeout escalation under `submitToSession`. Reuse the same formatting, pacing, fixed settle, no-enter behavior and operator ceiling. Keep immediate send's existing enqueue/early-claim response contract unchanged; the timeout path requires its later conditional claim because its row has been eligible for gated delivery all along. Do not invoke the HTTP/CLI send path again.
- At a valid, exclusively owned force edge, atomically transition **this held row** to `delivered` and set `interrupt_claimed_at`/outcome `claimed` in a single guarded DB update, then synchronously call the shared interrupt writer with no intervening await. No gate check after this claim. A zero-row update means delivery/dismissal/supersession already won: write nothing, including no Ctrl+C.
- Capture the target session at deadline dispatch and recheck that it is still the live writable session for the canonical agent at the actual force edge. Offline/unwritable at dispatch or edge, replacement while queued, or old lifecycle generation means no write. Record a skip where the lifetime still owns the DB, leaving the body held for ordinary delivery. Do not retry force on a later session. Replacement **before** deadline is allowed: ordinary agent-addressed send semantics apply and the session live at deadline is the candidate.
- Stop cancels timers and invalidates queued callbacks. At startup, before mailbox writers start, change leftover held `armed` policies to `skipped-restart`; retain body/deadline. Do not rearm them. Rows already force-claimed stay terminal and are never replayed, even if the crash preceded the first byte. Timer/ownership state is process-local; DB metadata is audit, not authority to interrupt after restart.
- Each terminal/row task handles its own errors and releases timer/coalescing state. Deadline waiting must not block other recipients, normal mailbox draining, or owner notices. Pending timer storage is bounded by current armed rows, with resolution hooks cancelling promptly and callback checks providing a second safety net.

### 2a. Same-row ownership and in-flight gated delivery

A terminal lock alone is insufficient: the existing operator ceiling can bypass an active delivery, and an active gated row still reads `held` until its paced write completes. Therefore add **shared nonblocking per-row write ownership**, used by both body paths; never infer “not writing” from `status = held`.

- The gated path acquires a row token synchronously at its in-terminal precheck, after ordinary row/session/screen checks and immediately before its first possible byte. It retains the token through paced completion and synchronous DB outcome handling, then releases it **before echo verification**. No-byte contention/abort does not acquire or promptly releases ownership. Put release/error handling in `finally`; do not release before committing a successful delivery.
- The force callback tries the same row token synchronously inside `submitToSession`, even on a degraded lock acquisition. If owned by a gated writer, it writes **nothing** and sets `wroteBytes = false`; it must neither claim the row nor bump the bypass counter. Outside all locks it registers one continuation on that row's outcome. Never await a row/agent lock while holding the terminal lock. Re-enter submission and redo all checks only if that outcome proves no bytes were attempted and the row remains held.
- An in-flight normal write that succeeds wins: row is already delivered before the continuation runs; cancel the force with no second body. Delivery/dismissal/supersession while waiting likewise cancels at the actual claim edge. If the force wins first, its synchronous `held → delivered` claim makes all later gated prechecks refuse the row. A stale gate classification can never authorize a second write.
- If a normal write reports `dropped`, `preempted`, or throws after entering its write edge, conservatively treat bytes as possibly emitted: **skip force for this row** (`partial-normal-write`) rather than start a second body attempt. The gated outcome handler records this skip for every armed row with an uncertain partial write, even if its timer has not fired yet; releasing the row token must not erase the prior-write evidence. Preserve existing ordinary-mail failure/hold handling and surface the uncertainty. This exception is necessary to honor same-row no-second-body arbitration; it is not a clean gate veto. A known pre-write/no-byte abort may still escalate. Existing ordinary retry semantics can themselves repeat partial/unconfirmed effects; do not advertise exactly-once delivery.
- Deadline initiation is still prompt when the row is actively writing, but force must not abort/rewrite **its own** body just to meet the patience budget. A different row's long delivery may still be bypassed under existing operator-ceiling rules; preserve its interference detection and warnings. No blanket terminal lock exemption authorizes same-row overlap.
- Lock order remains per-agent → per-terminal for normal delivery. The timeout uses per-terminal with a synchronous try-ownership check only; it never acquires the per-agent serializer, including in continuations. This prevents a force task queued behind the active row from holding up unrelated global drain work.

### 2b. Audit and irreversible-write tradeoffs

- Force claims before bytes, matching existing immediate interrupt's loss-over-duplicate choice. A crash/throw after claim can leave `delivered` even with zero or partial bytes. Do not revert to held or retry the forced body. `interrupt_outcome = claimed` after restart means **unknown write outcome**, not receipt.
- After the shared writer completes, record `written-unverified`, or `degraded` if the operator ceiling was actually bypassed and bytes attempted. Thrown/observed failed writes record `failed`; track write return values without changing the immediate writer's timing/ordering. `no-enter` is staged body delivery, not submission to the agent. Accepted writes and scheduled Enter completion are not acknowledgment.
- Cancellation after the guarded claim is too late: scheduled settle/body/Enter cannot be recalled, as with immediate interrupt. Session loss after claim may drop subsequent bytes; preserve the terminal audit record and warn rather than replay.
- Reuse the existing degraded-warning wording/counter semantics, but for timeout actions emit row-specific Tower warning plus visible notification/inbox outcome: the originating CLI may already have returned `held`. Do not depend on its earlier response to carry later degradation. Keep the distinction between force-claimed, write-completed-unverified, failed and agent receipt explicit in logs/docs.

### 3. Fix the queued-operator corner in the shared primitive

Replace the enqueue-time `behindOperator` decision with explicit predecessor completion tracking:

- Keep an operator-only completion chain separate from the combined submission tail.
- An operator must await all preceding operators' **actual writes**, never their delivery-containing combined tails. Against non-operator predecessors it races its configured ceiling; measure the delivery budget from enqueue, so a budget already expired is not reset when a preceding operator drains.
- Run only once both conditions hold: preceding operators finished, and combined predecessors finished OR the delivery ceiling expired. Thus operator-vs-operator remains serialized, while operator 2 need not wait for the entire original long delivery after operator 1 finishes.
- The public combined tail still covers predecessors plus the current write, preventing later delivery writers from slipping past unfinished work. Preserve error isolation, no-op bypass accounting, cleanup/reset hooks, and ordinary uncontended behavior.
- Update boundary comments and regression tests for two/three operators, interspersed deliveries, failure, and no-op writers. Reuse this primitive for the new coordinator rather than creating a competing serializer.

### 4. Alarm treatment

- Give bounded-patience rows an escalation start of `max(created_at, not_before, interrupt_at)` (nulls fall back to creation). While force is armed, this grants the normal escalation and owner-notice grace periods after the deadline if it cannot resolve. After a skipped force, use the ordinary creation/eligibility clock (no ongoing self-resolution promise). Force-claimed rows are terminal and leave held alarms; force failure/degradation needs its separate visible diagnostic. Existing rows retain existing clocks.
- Exclude **only armed predeadline rows** from owner-starvation aggregation/membership; include ordinary held rows for the same agent. After the deadline the bounded row participates normally, including skipped offline/restart/partial-normal-write rows. A predeadline restart skip removes suppression immediately, so older ordinary held mail is not hidden by a dead force policy.
- Use the same start calculation for SQL queries and emitted `ageMs`. Keep ordinary eligible held counts/inbox visibility unchanged: bounded-patience mail is held, not future-scheduled mail.
- Test clearing a prior owner notice when its ordinary starving rows resolve and only predeadline rows remain; after the deadline a genuinely stuck row can create a new episode.

## Files to Change

- `packages/codev/src/agent-farm/{cli.ts,types.ts,commands/send.ts}` — flag validation, forwarding, hold guidance.
- `packages/sdk/src/tower-client.ts`, `packages/types/src/api.ts` — request/response and inbox metadata; maintain server/client package isolation.
- `packages/codev/src/agent-farm/db/{schema.ts,migrations.ts,types.ts,mailbox.ts}` — columns, real migration, conditional force-body claim, restart disarm, alarm age/membership.
- `packages/codev/src/agent-farm/servers/{tower-routes.ts,mailbox-wiring.ts,mailbox-delivery.ts,session-submit.ts,message-write.ts}` — persist policy, lifecycle, shared operator fix, diagnostics and age reporting.
- `packages/codev/src/agent-farm/servers/mailbox-interrupt.ts` — new deadline coordinator and shared row-ownership helper with testable time/session/write ports (ownership may be factored into a small separate module).
- `packages/codev/src/agent-farm/commands/inbox.ts` — show deadline/force outcome without changing held/scheduled grouping.
- Focused additions to `__tests__/{mailbox.test.ts,mailbox-owner-notice.test.ts,send.test.ts,tower-routes.test.ts,spec-1365-serializer-convergence.test.ts,spec-1273-submission-lock.test.ts}` plus new `pir-1481-{migration,interrupt-after,owner-wiring}.test.ts` and `pir-1481-interrupt-after.e2e.test.ts` under the same agent-farm test directory. Add SDK serialization coverage in its existing test tree.
- `codev/resources/commands/agent-farm.md` and its `codev-skeleton/` twin; `.codex/skills/afx/SKILL.md`, `.claude/skills/afx/SKILL.md` and both skeleton twins — usage, force-now vs time-sensitive, durability/cancellation/limitations.
- `codev/resources/arch.md` and the hot mailbox invariant in `arch-critical.md` — document the explicit opt-in timed force-body exception and its shared ownership/serialization boundary (use the arch-doc skill and mirror any affected skeleton/framework hot context); review/thread artifacts record evidence and limitations. No dashboard UI changes are proposed.

## Risks & Alternatives Considered

- **Ctrl+C-only then gated body:** rejected by the human. Busy/unverifiable screens at deadline must take the ungated force-body path, not remain held solely for the render gate.
- **Ungated body risk:** Ctrl+C and fixed settle do not prove that a draft/menu disappeared. The opt-in force may corrupt input or lose work, exactly as immediate `--interrupt` can. Document time-sensitive versus urgent usage and this explicit exception to ordinary no-force policy.
- **Durable late force:** not selected in this revision's proposal. Retrying after offline return/restart could interrupt a later unrelated turn. Proposed runtime-only force authority preserves durable body delivery but skips force on restart/unavailable/replaced target; this lifecycle product choice remains pending at the plan gate.
- **Claim at timer entry or invoke send again:** rejected because gated delivery/cancellation can win during lock waits, and another send creates another row/body. Ownership arbitration and conditional claim belong at the write edge.
- **Force after a possibly partial normal write:** rejected to avoid the timeout injecting a second copy of its own message. Keep current gate retry/error policy, disarm only the new force action, and report uncertainty. Same-row ownership outlives paced completion until its DB outcome is applied.
- **Reuse delayed interrupt unchanged:** its Ctrl+C-only behavior is the wrong body contract. Leave existing `--delay --interrupt` behavior unchanged; share the immediate interrupt writer instead.
- Persisted deadlines use existing epoch-ms conventions. Timers use a relative delay and recheck wall time at firing: a backward jump can rearm, while a forward jump does not magically wake an already-armed OS timer early. Do not promise hard wall-clock timing through clock changes; fake-clock tests pin these boundaries.
- Do not reopen #1365/#1476: both prerequisites are merged. #1477 PR #1625 and #1473 PR #1634 remain OPEN/unmerged at planning time.
- Read #1477's two reference tests under `/home/user/code/codev_root/codev/.builders/air-1477/packages/codev/src/agent-farm/__tests__/` without modifying them. Reuse its seeded-registry + real `makeDeliveryPorts` pattern in a separate #1481-specific test, not its branch or whole files. No cherry-pick/merge of either parked PR. Once maintainers land them, rerun their suites with ours and reconcile shared helper duplication if necessary.
- Do not assume #1473 input tracking exists: retain current output-token and serialized-write guards. Exercise no duplicate completed body write under normal cancellation/deadline races, while acknowledging the existing degraded partial-write boundary.

## Test Plan

### Deterministic automated coverage

1. CLI/API/SDK: positive fractions and bounds; zero, negative, nonfinite, string/null API input and conflicting flags rejected without rows; all send routes/broadcasts preserve the option and authorizations. Existing sends/delay/interrupt/escape remain unchanged.
2. Real migration runner: fresh DB, v18 upgrade with held/delivered rows, repeated runner invocation, reopen persisted DB; compare schema/defaults/indexes and preexisting values.
3. Fake clock/real DB: immediate clean delivery with no later Ctrl+C; hold then clean before deadline; busy at/exactly after deadline; busy/no-profile/unverifiable gate still receives shared Ctrl+C → 100 ms settle → ungated body → Enter; no-enter omits Enter; assert original row identity and no repeated force. Assert timer armed before any initial-delivery await and no polling-delay dependency.
4. Deferred-lock races: deliver/dismiss/supersede while queued, duplicate deadline dispatch, teardown/replacement, stop/start generation, thrown/dropped writes and claim/write crash window. Assert bytes, DB states, count/notice events, and bookkeeping cleanup—not merely timer callbacks. Pause a normal write across deadline: successful write cancels force; no-byte abort permits re-entry; dropped/preempted/throwing possible-partial write skips force. Force-first cancels a stale normal precheck. Verify a same-row degraded callback writes zero bytes and does not increment the bypass counter.
5. File-backed restart/offline: body/deadline audit survives, but unclaimed force is disarmed on restart both before and after due; claimed force is never replayed. Offline/unwritable at deadline skips force; return delivers only through normal gate. Replacement before deadline targets the current canonical session, replacement during lock wait skips force and never writes to the old session. Stop invalidates callbacks already queued for a lock.
6. Serializer: >2-second delivery with two operators queued during it; operator 2 runs after operator 1 finishes without awaiting the long delivery, but never overlaps operator 1. Third writer remains correctly chained. Verify unrelated agents' delivery/alarms progress.
7. Alarms: predeadline suppression, ordinary starving mail to the same recipient still alarms, deadline-based postdeadline grace while armed, removal of suppression after skip/restart, terminal force rows excluded from held notices, visible failed/degraded force outcomes, correct held counts, notice membership clearing/rearming, no notice-on-notice recursion. Seed real owner registry and invoke production wiring as in #1477.
8. Run focused suites, SDK/type builds, package build and complete non-watch unit suite. Run porch's required checks and consultations when porch requests them; do not hand-run its review cycle.

### Running worktree evidence before dev-approval / PR

Use the existing `send-integration.e2e.test.ts` child-Tower pattern: isolated `CODEV_AGENT_FARM_DIR`/DB and test workspace, separately allocated port (never 4100), real shellper/PTY, and the worktree-built CLI invoked from the test workspace root. Use a deterministic interactive PTY fixture rendering a supported composer and recording Ctrl+C/text/Enter; also demonstrate clean/busy behavior with a real supported agent CLI to validate the classifier against its actual prompt. Save timestamped transcripts and commands in the review.

Exercise clean-before-deadline/no later interrupt; busy/unverifiable-through-deadline with actual Ctrl+C + fixed settle + ungated body; body resolution/cancellation during contention; offline/session replacement/restart; two queued operators behind a long paced write; starvation suppression alongside ordinary mail; one completed body delivery; unchanged flags and invalid combinations. Separate fake-clock proofs from real-PTY observations—do not claim fixture output is live-agent evidence. Never stop/restart the live Tower, signal architect/builder sessions, or clean up existing worktrees. Stop only harness-owned child processes after verifying ownership.

## Commit / Gate Sequence

1. Commit/push this plan and requirements/thread notes; stop at `plan-approval`, recording the human-selected ungated body contract and requesting approval of the proposed no-late-force lifecycle behavior. A revision request is not gate approval.
2. After human approval: persistence/API changes; coordinator/operator/alarms changes; tests/docs/live evidence as logically separate commits in **one PR**. Let porch own phase transitions and 3-way review.
3. Stop at `dev-approval` with runnable evidence. Open PR only when porch permits; notify architect and record it with porch.
4. Contributor constraint: every PR needs maintainer/reviewer approval; **maintainer merges**. Do not merge, close issues, or clean up worktrees.
