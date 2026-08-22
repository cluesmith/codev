# PIR Plan: Serializer convergence — route the mailbox write edge through `submitToSession`

Issue #1365. Refs #1313 / PR #1330 / #1480 (absorbed) / #1481 (interlock, sequenced after this) / #1473 (echo-lag residual).

**Revision 2** — incorporates the architect's 3-way plan review (gemini APPROVE, codex +
claude REQUEST_CHANGES; both REQUEST_CHANGES reviews ratify Part 1). All five blocking items
are addressed in Part 2; item 4 (`--escape`) also changed Part 1, which now treats escape as
a first-class instance of the bug. Changes from revision 1 are summarised at the end.

**This plan leads with the evaluation the issue's "Evaluate first" section demands.** The
four failure questions are answered end-to-end from the code, *before* any convergence
design. The evaluation's conclusion (converge) is what the `plan-approval` gate is being
asked to ratify; the implementation section is contingent on that ratification.

---

## Part 1 — Evaluation: how the write paths actually compose

### The paths, as they exist today

| # | Path | Lock it takes | Where |
|---|---|---|---|
| A1 | Immediate `--interrupt` | **per-terminal** `submitToSession(terminalId, …)` | `servers/tower-routes.ts:2023` |
| A2 | Immediate `--escape` | **per-terminal** `submitToSession(terminalId, …)` | `servers/tower-routes.ts:1963` |
| B | Gated mailbox delivery (every normal send, cron, held-drain, owner notice) | **per-agent** `KeyedSerializer` keyed by `agentKey(workspacePath, toAgent)` | `servers/mailbox-delivery.ts:490-500` → `servers/mailbox-wiring.ts:215` → `writeMessagePaced` (`servers/message-write.ts:133`) |
| C | Delayed `--interrupt` | **per-terminal** for the bare `^C` only; the body then rides path B | `servers/tower-routes.ts:1724-1752` |

A1/A2/C take the same lock. B takes a disjoint one. The two lock spaces never intersect, so
**A/C vs B is unserialized** — the boundary this issue names.

Four facts bound the analysis, each verified in code rather than assumed:

1. `PtySession.write()` (`terminal/pty-session.ts:549`) is what *both* families call, and it
   emits no delivery signal — only `handleUserInput` (`terminal/pty-session.ts:802`, human
   keystrokes) emits `'submit'`; `'quiescence'` comes off an output timer
   (`terminal/pty-session.ts:503-508`). No write from inside a lock can synchronously
   re-enter the other lock.
2. `writeMessagePaced` (path B) returns `false` only when a **PTY write is dropped** (#1198,
   dead shellper socket). It cannot detect *semantic* loss — bytes the PTY accepted but the
   TUI then discarded.
3. The render gate's TOCTOU re-validation (`mailbox-delivery.ts:397`) closes the window
   between *classify* and *write start*. Nothing covers write-start through the trailing
   Enter — 50 ms (short message) to `(lines−1)×10+80` ms (paced multi-line).
4. `ringToken` is built from `bytesWritten`, a cumulative **output** counter. Input that has
   not yet been echoed is invisible to it. This is the echo-lag residual (#1473) and it
   bounds what any pre-write check can promise.

### Q1 — Can a gated delivery interleave between a Ctrl+C and the post-interrupt clean prompt?

**Yes, in both orderings — and `--escape` is a third instance of the same class.**

The immediate-interrupt critical section is `^C` → 100 ms settle → text → Enter, all inside
one `submitToSession` acquisition (`tower-routes.ts:2023-2026`). Path B holds none of that
lock.

**Ordering 1 — the mailbox write lands inside the interrupt's settle window.** The drainer
classifies clean at t₀, re-validates the ring token, starts `writeMessagePaced`. The
interrupt's `^C` fires at t₀+ε and its own text is scheduled for `^C`+100 ms. Both bodies now
occupy one composer and a single Enter submits the fusion — the `w1a` blob shape Spec 1313
exists to make impossible. Narrow (the `^C` must land after the token re-check), but real.

**Ordering 2 — the `^C` lands inside the delivery's own text→Enter window, and the row is
still marked `delivered`.** The delivery writes text at t₀ and schedules Enter at t₀+50 ms
(short) or +80 ms after the last line. A `^C` in that window clears the composer; at t₀+50 ms
the delivery's Enter fires into an empty prompt. `writeMessagePaced` returns `true` — every
byte *was* accepted by the PTY (fact 2) — so `markDelivered` transitions the row
(`mailbox-delivery.ts:463`) and the delivery is broadcast.

That is **silent message loss with a false `delivered` audit record**, the one outcome Spec
1313's architecture exists to exclude. The gate cannot help: it proved the prompt empty
*before* the write, and nothing re-checks after.

**Ordering 3 — `--escape` truncates an in-flight multi-line delivery** (raised by claude in
review; folded in here as first-class). `writeEscapeToSession`
(`servers/message-write.ts:53`) writes a bare ESC, then Enter 50 ms later. A multi-line
delivery writes its lines 10 ms apart, so an ESC arriving mid-sequence discards what has been
typed so far, the delivery's remaining lines land on the now-cleared composer, and either
Enter (escape's at +50 ms, or the delivery's own) submits a **truncated body**. The row is
marked `delivered`. Escape is not a milder cousin of interrupt here — for multi-line
deliveries it is the more likely trigger, because the delivery's exposed window is longest
exactly when the body is long.

Note the asymmetry with the interrupt path's own claim-first tradeoff
(`tower-routes.ts:1997-2008`): there, a lost message is a *documented, deliberate* choice by
an operator taking an explicit bypass. Here it is an autonomous background delivery losing a
message it reports as delivered, with no operator present.

### Q2 — Does the delayed-interrupt reshape leave a window where the body lands mid-turn?

**No.** The reshape (`tower-routes.ts:1715-1753`) fires only the `^C` on the timer; the body
is a persisted `not_before` row that can leave the mailbox only through `deliverAgentMail`,
which requires a render-verified empty prompt. There is no code path from the timer to a body
write. A mid-turn screen classifies not-clean → held. The reshape is sound and needs no
change.

Two true-but-benign residuals, recorded because #1481 inherits them:

- **`^C`→body is not atomic.** The `^C` callback returns `0`, so the terminal lock releases
  immediately; `scheduleDrain` (line 1751) then runs the gate. Anything may occupy the
  terminal in between. Correct by design — the gate re-decides — but the delayed interrupt
  guarantees "the turn was ended," never "this body is next."
- **A no-op `^C` is indistinguishable from success to the caller.** Liveness is re-checked
  inside the lock (lines 1733-1735); a dead/unwritable session logs and drops the nudge.

Under Ordering 2, the delayed path is *also* an exposed writer: its `^C` can clear another
delivery's half-written composer. It fires **unattended**, on a timer — so the "a human is
standing at this terminal" premise that makes the immediate path's race acceptable does not
apply to it at all.

### Q3 — Is escalation/held state consistent if an interrupt tears the session mid-write?

**Bookkeeping stays internally consistent; its correspondence to reality does not.**

- **Session torn down mid-write** (socket death, not interrupt): `writeMessagePaced` returns
  `false` → `hold('no-live-pty')` (`mailbox-delivery.ts:458`); row stays held, escalation
  clock keeps running. **Correct.**
- **Interrupt clears the composer mid-write** (Ordering 2) **or escape truncates it**
  (Ordering 3): row → `delivered`, leaves the held set, `onHeldStateChange` fires, held count
  drops, any `escalated` flag becomes moot. Every derived indicator agrees with the DB, and
  the DB is **wrong**. Nothing after the write re-examines the screen, so there is no
  detector. **This is the inconsistency** — invisible rather than noisy. Ordering 3 is the
  worse variant: the agent receives a *partial* message, so the failure can propagate as
  acted-upon-but-wrong rather than merely absent.
- **Immediate interrupt's own row**: claimed `delivered` before the write by design
  (`tower-routes.ts:1997-2008`) — consistent with its documented tradeoff; unchanged here.
- **Escalation/liveness telemetry**: unaffected either way. `isClassifierStuck`
  (`mailbox-delivery.ts:242`) escalates only `no-profile` / `no-region-end` /
  `no-composer-marker`, so neither `busy` nor `no-live-pty` holds can false-alarm.

### Q4 — Should the disjoint-lock boundary stay accepted, or converge?

**Converge.** In order of weight:

1. **The failure is silent loss (or silent truncation) with a false `delivered`, not a
   garbled composer.** The accepted-boundary argument covers the fusion case (Ordering 1) but
   not Orderings 2 and 3, which were not separately reasoned about when the boundary was
   accepted.
2. **The "an operator is present" premise is false for the delayed path.** Path C fires on a
   timer with nobody watching, and #1481 (`--interrupt-after`) turns that from a rarity into
   a routine, *scheduled* co-occurrence of an interrupt and a pending gated delivery to the
   same terminal. The boundary gets more load-bearing exactly where the workstream is heading.
3. **The fix is cheap and cycle-free.** The per-terminal lock is acquired as a leaf inside the
   per-agent serializer, so the order is always agent → terminal, never the reverse; fact 1
   rules out re-entrancy.

**What convergence buys, stated precisely** (revised per review item 3 — revision 1 overclaimed
here):

> **Serialization is the structural guarantee.** After this change, no lock-taking writer —
> gated delivery, `--interrupt`, `--escape`, delayed `^C` — can put bytes on a terminal while
> another lock-taking writer's submission is in flight. That is what closes Orderings 1, 2
> and 3, and it is a property of the lock, not of any check.
>
> **The in-lock precheck narrows, but does not close, the echo-lag residual.** Re-validating
> the gate verdict inside the lock is *necessary* — without it, a delivery that classified
> clean and then waited behind an interrupt would write onto a screen the interrupt just
> changed, which is worse than today. But `ringToken` tracks output (fact 4), so input from a
> writer that does **not** take the lock — the raw `POST /api/terminals/:id/write`
> passthrough, and human keystrokes over the WebSocket — can sit on the line un-echoed and
> defeat it. Those writers stay deliberately uncovered (a human owns their own composer), so
> that residual survives this change by design. It is **#1473's territory**, and the boundary
> comment must say so rather than implying the race is gone.

The lock must also stay a **leaf around the write only**, never widened to cover the async
classify: `--interrupt` is the human's escape hatch for a wedged agent, and making it queue
behind a gate classification would be a real regression for the one action that must always
get through fast.

**Interlock note for #1481** (`--interrupt-after`): after this change, "interrupt, then
deliver this body" is expressible as *ordered acquisitions of one lock* rather than a race
between two. #1481 should build on that and must not re-introduce a body write outside the
gate. The Q2 residuals (the `^C`→body gap is gate-mediated, not atomic; a no-op `^C` is only
logged) are the two things it must design against explicitly.

---

## Part 2 — Proposed change (contingent on the gate ratifying Part 1)

Route path B's write edge through `submitToSession`, keyed by the terminal id, as a leaf
inside the existing per-agent serializer, with the delivery's preconditions re-validated
inside the lock — and with the delivery side using a **non-blocking** acquisition so the
drainer can never stall.

### D1. The delivery path learns the terminal id, and the id is guarded at runtime

`DeliverySession` (`mailbox-delivery.ts:52`) gains `readonly id: string`. `PtySession`
already has it (`terminal/pty-session.ts:118`), so the live binding is free.

**Runtime guard (review item 5).** A missing id must not silently become a global lock.
`tower-routes.test.ts:221`'s `gateSession()` is an un-annotated object literal with **no
`id`** that reaches the *real* `mailbox-wiring` binding — verified. Structural typing means
such a fake can compile while keying every lock on `undefined`, collapsing per-terminal
serialization into one global lock without a single failing assertion. So `submitMessagePaced`
throws on a non-string/empty id. A throw there propagates out of `writeMessage`, past the
`finally` that invalidates the memo, through the per-agent serializer to the drainer's
per-agent `try/catch` (`mailbox-delivery.ts:661`) — logged, row stays **held**, never marked
delivered. Fail-loud and fail-safe. `gateSession()` gains a real `id` and is added to the
change list.

### D2. Asymmetric acquisition — deliveries try, operators block (review item 2)

The review is right that a symmetric blocking lock is a liveness regression:
`MailboxDrainer.tick` awaits agents **sequentially** (`mailbox-delivery.ts:644-664`), so one
agent blocked on a terminal lock stalls every other agent's delivery, plus that tick's
escalation, owner-notice and prune passes.

`session-submit.ts` therefore gains a non-blocking sibling:

```ts
/** True while a submission is in flight for this session. */
export function isSubmissionInFlight(sessionId: string): boolean;

/** submitToSession, but abandons instead of queueing when the session is contended.
 *  Resolves `false` (nothing written) if another submission holds the session. */
export function trySubmitToSession(sessionId, write, clock?): Promise<boolean>;
```

The check-then-install is race-free without ceremony: JS is single-threaded and `chains.has`
→ `chains.set` has no await between them, so no second caller can interleave.

- **Delivery (path B) uses `trySubmitToSession`.** Contended → write nothing, return
  `aborted:'busy'`, row stays held, backstop retries in ≤1.5 s. This costs nothing real: a
  contended terminal means another writer is mid-submission, so the in-lock precheck would
  have aborted the delivery anyway. The drainer never blocks, so head-of-line blocking is
  gone — a *stronger* liveness property than today, where the drainer awaits a full paced
  write per agent.
- **`--interrupt` / `--escape` / delayed `^C` keep `submitToSession`** and block. They are
  operator actions that must land.

Starvation is not a concern in the other direction: interrupts are human-rate, deliveries
retry every 1.5 s.

### D3. Interrupt latency has a new worst case, and needs a ceiling (new finding)

Not in the review, and it changes the shape of D2's operator side. Today `--interrupt` never
waits. After convergence it waits for any in-flight delivery write, whose duration is
`(lines−1)×10+80` ms — and body size is bounded only by `parseJsonBody`'s **1 MiB** default
(`agent-farm/utils/server-utils.ts:47`). A 48 KB `--file` attachment of short lines is ~48k
lines ≈ **8 minutes**; a realistic 500-line paste is ~5 s. So "the escape hatch stalls behind
a long message" is an ordinary case, not a pathological one, and an unbounded block on
`afx interrupt` would be a worse regression than the bug being fixed.

**Remedy: a bounded wait with explicit degradation.** `submitToSession` gains an optional
`waitCeilingMs` (default off; set for the interrupt/escape call sites, proposed **2000 ms**).
If the lock is not acquired within the ceiling, the operator write proceeds **unserialized**
and logs loudly at WARN with the session id and the wait.

This is strictly better than today at every point: below the ceiling we get the full
guarantee; at or above it we degrade to exactly today's unserialized behaviour, which is the
status quo — never worse — and we now say so in the log instead of never knowing. The
alternative (unbounded block) trades a rare silent corruption for a routine visible hang on
the one action that exists to rescue a wedged agent.

The ceiling value is a judgment call and is flagged for the reviewer. Consider it settled
only if the gate says so; the fallback is unbounded blocking plus a documented latency
tradeoff.

### D4. The in-lock precheck (including the row-status re-check, review item 1)

The `writeMessage` port cannot express "aborted before writing anything," so it changes shape:

```ts
/** Why a gated write abandoned inside the lock. */
export type WriteAbort =
  | { kind: 'hold'; reason: MailboxReason }  // re-hold: busy (screen moved / contended) or no-live-pty
  | { kind: 'row-resolved' };                // dismissed/superseded under us — terminal state, no hold

export type WriteResult =
  | { status: 'written' }                    // every byte landed, Enter included
  | { status: 'dropped' }                    // #1198 partial/dropped → hold no-live-pty
  | { status: 'aborted'; abort: WriteAbort };

writeMessage(
  session: DeliverySession,
  formattedMessage: string,
  noEnter: boolean,
  precheck: () => WriteAbort | null,         // null = proceed; runs INSIDE the lock
): WriteResult | Promise<WriteResult>;
```

`deliverAgentMail` supplies the precheck, so all reason authority stays in the delivery
module. It re-runs, at the write instant, the three checks the code already performs before
the lock:

```ts
() => {
  if (!session.writable) return { kind: 'hold', reason: 'no-live-pty' };   // mirrors :424
  if (ringToken(session, profile) !== tokenBefore)                          // mirrors :397
    return { kind: 'hold', reason: 'busy' };
  const now = getById(db, row.id);                                          // mirrors :411 — review item 1
  if (!now || now.status !== 'held') return { kind: 'row-resolved' };
  return null;
}
```

The row-status re-check is load-bearing, not defensive tidiness: without it, this change
would **widen** the dismiss→bytes-on-wire window from ~zero to the whole lock wait. Dismiss
and supersede are independent synchronous DB writes not routed through the delivery
serializer (as `mailbox-delivery.ts:404-410` already explains), and `better-sqlite3` is
synchronous, so this re-read sees anything committed up to the write instant. The pre-lock
checks stay as cheap fast-paths that avoid a pointless acquisition.

Outcome mapping in `deliverAgentMail`, replacing `if (!written)` at `:458`:

| result | action |
|---|---|
| `written` | `markDelivered` + broadcast, as today |
| `dropped` | `hold('no-live-pty')`, as today |
| `aborted / hold` | `hold(reason)` |
| `aborted / row-resolved` | `ports.onHeldStateChange()` + `{ delivered: [], reason: null }` — exactly the existing `:411-416` branch |

The unconditional `finally { memo?.delete(cacheKey) }` (`:447`) stays. An aborted write puts
no bytes on the wire, but discarding a verdict we just proved stale is right anyway, and
keeping it unconditional preserves the rejection-safety its comment argues for.

### D5. `submitMessagePaced` — the new leaf

In `message-write.ts` (which then imports `session-submit.ts`; `session-submit.ts` imports
nothing, so no cycle):

```ts
export async function submitMessagePaced(
  session: WritableSession & { id: string }, message: string, noEnter: boolean,
  precheck: () => WriteAbort | null,
): Promise<WriteResult>
```

It guards the id (D1), acquires via `trySubmitToSession` (D2) — contended → return
`aborted:{kind:'hold',reason:'busy'}` — runs `precheck()` first thing inside the callback
(abort → return offset `0`, nothing written), otherwise runs the existing tracked paced write
and returns its completion offset so the lock is held through the trailing Enter.

Enter-before-resolve ordering is preserved: `submitToSession` registers its `sleep` timer
*after* `write()` returns — i.e. after the Enter's `setTimeout` was registered at the same
offset — so the Enter still executes first, exactly as `writeMessagePaced` documents
(`message-write.ts:124-127`). This is asserted with fake timers (see Test Plan).

`writeMessagePaced`'s only live caller is `mailbox-wiring.ts:215`; after this it is
test-only. It will be removed and `spec-1313-paced-write-drop.test.ts` re-pointed at
`submitMessagePaced`, unless review prefers keeping the unlocked primitive exported.

### D6. Wiring

`mailbox-wiring.ts:215` becomes
`writeMessage: (session, msg, noEnter, precheck) => submitMessagePaced(session, msg, noEnter, precheck)`.

### Lock-order / deadlock safety (must hold, and does)

- Order is always **per-agent → per-terminal**; nothing acquires them in reverse. Paths
  A1/A2/C take only the per-terminal lock and never enter the per-agent serializer.
- No synchronous re-entry (fact 1). Even if a `scheduleDrain` were raised from inside a lock
  callback it is `void`-ed onto a microtask and never awaited.
- With D2 the delivery side never blocks at all, so the only wait in the system is an
  operator waiting on a delivery — bounded by D3.

### Files to change

- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` — `DeliverySession.id`;
  `WriteAbort`/`WriteResult`; `writeMessage` port signature + doc; precheck construction and
  outcome mapping around `:397-:466`.
- `packages/codev/src/agent-farm/servers/session-submit.ts` — add `isSubmissionInFlight`,
  `trySubmitToSession`, `waitCeilingMs`; **rewrite the "Exactly what it covers" boundary
  comment** (`:42-69`): it now covers gated mailbox deliveries; state the per-agent →
  per-terminal order, the asymmetric acquisition and why, the D3 ceiling and its degradation,
  why the lock is a leaf around the write and not the classify, that **serialization is the
  structural guarantee while the precheck only narrows the echo-lag residual (#1473)**, and
  what stays deliberately uncovered (`POST /api/terminals/:id/write`, WS keystrokes).
  *Deliverable in either outcome.*
- `packages/codev/src/agent-farm/servers/message-write.ts` — add `submitMessagePaced`; retire
  `writeMessagePaced`.
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:215` — bind the new port shape.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — replace the "flagged, not done
  here" scope paragraph (`:2017-2022`) with the converged guarantee; pass `waitCeilingMs` at
  the interrupt (`:2023`), escape (`:1963`) and delayed-`^C` (`:1728`) call sites.
- `codev/resources/arch.md` §7 item 5 (~line 1798) — replace the "disjoint lock … accepted,
  documented boundary" sentence with the converged model: one lock at the write edge, the
  agent→terminal order, the delivery-tries/operator-blocks asymmetry, the delayed-interrupt
  sequencing (`^C` on the timer, body through the gate, not atomic by design), and the
  #1473 residual stated honestly. *Deliverable in either outcome.*
- `codev/resources/arch-critical.md` — the review suggests a hot-tier fact for the
  agent→terminal lock-order invariant. The hot tier is **at its 10-fact cap**, so this
  requires demoting an existing fact. Proposed in the review phase as an explicit
  displacement recommendation for the maintainer, not applied unilaterally.
- Tests: new `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts`;
  fake/port updates in `tower-routes.test.ts` (`gateSession` at `:221` — add `id`),
  `send-delivery.test.ts` (fake session **plus** the inline `ports.writeMessage` overrides at
  `:422`, `:604`, `:618` — note `:604` currently returns `undefined` and relies on falsy⇒hold,
  which the typed result makes explicit), `send-mailbox-repro.test.ts`,
  `cron-delivery.test.ts`, `send-architect-identity.test.ts`;
  `spec-1313-paced-write-drop.test.ts` re-pointed.

No skeleton mirror: this is `packages/codev` source plus our own `codev/resources/`, not
framework template content.

### Phasing (git commits inside one PR)

1. **Lock primitives** — `isSubmissionInFlight`, `trySubmitToSession`, `waitCeilingMs`, with
   their own tests (including the D3 ceiling's degradation path).
2. **Convergence + delivery tests** — the port reshape, precheck, `submitMessagePaced`,
   wiring, fake updates; red-to-green on the race tests.
3. **Boundary model documentation** — `session-submit.ts`, `tower-routes.ts`, `arch.md`,
   written against what actually landed.
4. **CMAP consultation** (implementation + tests) and fixes; review doc, incl. the
   `arch-critical.md` displacement proposal.

## Risks & Alternatives Considered

- **Risk — the lock moves the race instead of closing it.** A delivery that classified clean
  before queuing would write onto a screen the writer ahead of it just changed. *Mitigation*:
  the in-lock precheck (D4) is mandatory and is what the new tests assert; with D2 the
  delivery does not queue at all. Dropping the precheck turns this change into a regression.
- **Risk — interrupt latency (D3).** Bounded by the ceiling, degrading to today's behaviour
  with a loud WARN. Unbounded blocking is the rejected alternative.
- **Risk — head-of-line blocking in the sequential drainer.** Removed by D2; the drainer
  never waits on a terminal lock.
- **Risk — port signature churn breaks fakes.** Six test files. Compile-time, except the
  `undefined`-returning override at `send-delivery.test.ts:604`, which is called out
  explicitly.
- **Risk — more `busy` holds under contention.** Intended (those writes would have landed on
  a moved screen), and the backstop re-delivers within 1.5 s.
- **Risk — a silently global lock from a missing id.** Closed by D1's runtime guard plus the
  different-terminals test.
- **Alternative — accept the boundary (wontfix).** Rejected on Orderings 2 and 3: a false
  `delivered` on a lost or truncated message is not a robustness nicety, and #1481 removes the
  "operator is present" premise. Had the analysis found only Ordering 1, wontfix would have
  been defensible.
- **Alternative — symmetric blocking lock.** Rejected per review item 2: stalls the
  sequential drainer for every other agent.
- **Alternative — widen `submitToSession` to hold across gate + write.** Rejected: queues the
  human's escape hatch behind an async classification and buys nothing the precheck does not.
- **Alternative — keep `boolean` and map an aborted write to `false`.** Simpler, no port
  churn, but reports `no-live-pty` for a `busy` abort and cannot express `row-resolved` at
  all. Rejected; noted as the fallback if review wants minimal surface.
- **Alternative — post-write verification (re-classify after Enter, re-hold on mismatch).**
  Rejected: detect-and-repair is the architecture Spec 1313 replaced, and a re-hold risks
  double delivery.

## Test Plan

**Unit** — new `spec-1365-serializer-convergence.test.ts`, fake sessions with an ordered
write log, `vi.useFakeTimers()` (the paced writer uses raw `setTimeout`, so an injected clock
alone cannot assert ordering — review's non-blocking note):

*Serialization (the structural guarantee)*
- A gated delivery and a concurrent immediate `--interrupt` to the same terminal **never
  interleave**: the `^C` appears wholly before the delivery's text or wholly after its Enter.
  (Fails on `main`.)
- Same for `--escape` (Ordering 3): a multi-line delivery is **never truncated** by an ESC
  landing between its lines. (Fails on `main`.)
- **Ordering 2/3 regression**: an interrupt or escape racing an in-flight delivery no longer
  leaves the row `delivered` — the delivery either completes intact or aborts with the row
  still `held`. (Fails on `main`: today the row reads `delivered` with nothing, or a
  fragment, on the agent's screen.)

*In-lock precheck*
- Screen moved while queued → zero bytes written, hold `busy`, `markDelivered` never runs.
- Session became unwritable → zero bytes, hold `no-live-pty`.
- **Row dismissed/superseded during the lock wait → zero bytes, no hold, `onHeldStateChange`
  fires, outcome `{delivered: [], reason: null}`** (review item 1).

*Asymmetric acquisition (D2)*
- Contended terminal → delivery returns `aborted:'busy'` **immediately** (no await on the
  holder) and the row stays held.
- **The drainer does not stall**: with agent A's terminal held by a long operator submission,
  agent B's delivery in the same `tick()` still completes, and escalation/prune still run.
- Interrupt/escape still **block** and land after the in-flight write.

*Ceiling (D3)*
- An operator submission waiting past `waitCeilingMs` proceeds unserialized and logs WARN;
  below the ceiling it serializes normally.

*Key hygiene (review item 5)*
- **Deliveries to two different terminals do not serialize** (proves the key is the real id).
- A session with a missing/empty `id` throws from `submitMessagePaced`, the row stays
  **held**, and nothing is written.

*Preserved semantics*
- Dropped write (#1198) still holds `no-live-pty`; two deliveries to one agent still cannot
  interleave; the returned promise still resolves **after** the Enter; `noEnter` staging
  unchanged.

*Hygiene*
- After mixed delivery/interrupt/escape traffic settles, `pendingSubmissionSessions() === 0`,
  the per-agent serializer is inactive, and every promise settles (deadlock-freedom).

**Regression suites**: `spec-1273-submission-lock`, `spec-1273-interrupt`, `write-queue`,
`mailbox`, `send-delivery`, `send-mailbox-repro`, `send`, `spec-1313-paced-write-drop`,
`spec-1307-send-delay`, `cron-delivery`, `tower-routes`, plus a full
`pnpm --filter @cluesmith/codev test` and `build`.

**Manual (for the `dev-approval` gate)** — live Tower, two agents:

1. `afx send <agent> "<long multi-line body>"` and, within the same second,
   `afx interrupt <agent>` from a second shell. Repeat ~10×. Expect: never a fused composer,
   and **never** a row in `afx inbox show` reading `delivered` whose text did not appear
   (whole and intact) on the agent's screen.
2. Same race with `afx send <agent> --escape` — expect no truncated body.
3. `afx send <agent> --delay 5 --interrupt "<body>"` against a mid-turn agent: `^C` at due
   time, body lands only once the prompt is clean, exactly one copy.
4. **Liveness**: with a large body mid-delivery to agent A, confirm agent B's held mail still
   delivers promptly (D2), and that `afx interrupt <A>` returns within the ceiling (D3),
   logging the WARN if it degrades.
5. A not-writable target still 503s `TERMINAL_NOT_WRITABLE`.

**Cross-platform**: none — server-side Node only, no UI surface.

---

## Changes from revision 1 (for the reviewer)

| Review item | Where addressed |
|---|---|
| 1 — row-status re-check in the precheck | D4 (`getById` in the precheck; `row-resolved` in `WriteAbort`; outcome-mapping row; dedicated test) |
| 2 — head-of-line blocking / asymmetric try-lock | **Adopted** — D2 (`trySubmitToSession`, delivery fail-fasts, operators block) + drainer-does-not-stall test |
| 3 — echo-lag residual overclaimed | Q4's "What convergence buys, stated precisely"; fact 4 in Part 1; carried into the `session-submit.ts` and arch.md deliverables |
| 4 — `--escape` is a second instance | Part 1 Q1 Ordering 3 + Q3; first-class in the test matrix and manual steps |
| 5 — test-fake id hazard | D1 runtime guard; `gateSession` fix; different-terminals + missing-id tests |
| non-blocking — clock/fake timers | Test Plan preamble |
| non-blocking — file paths, `send-delivery.ts` overrides | Files to change (paths corrected; `:422`/`:604`/`:618` listed, `:604`'s `undefined` return called out) |
| non-blocking — `arch-critical.md` hot fact | Files to change — flagged as requiring displacement at the 10-fact cap; proposed in review, not applied unilaterally |

**New finding not in the review**: D3 — interrupt latency. Body size is capped only by
`parseJsonBody`'s 1 MiB, so a blocking operator acquisition can wait minutes on a realistic
`--file`-sized body. Proposed remedy is a bounded wait that degrades to today's behaviour with
a loud WARN. The ceiling value (2000 ms) is a judgment call flagged for the gate.
