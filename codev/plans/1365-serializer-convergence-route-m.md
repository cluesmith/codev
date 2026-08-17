# PIR Plan: Serializer convergence — route the mailbox write edge through `submitToSession`

Issue #1365. Refs #1313 / PR #1330 / #1480 (absorbed) / #1481 (interlock, sequenced after this).

**This plan leads with the evaluation the issue's "Evaluate first" section demands.** The
four failure questions are answered end-to-end below, from the code, *before* any
convergence design. The evaluation's conclusion (converge) is what the `plan-approval`
gate is being asked to ratify; the implementation section is contingent on that ratification.

---

## Part 1 — Evaluation: how the three write paths actually compose

### The three paths, as they exist today

| # | Path | Lock it takes | Where |
|---|---|---|---|
| A | Immediate `--interrupt` / `--escape` | **per-terminal** `submitToSession(terminalId, …)` | `tower-routes.ts:1963` (escape), `tower-routes.ts:2023` (interrupt) |
| B | Gated mailbox delivery (every normal send, cron, held-drain, owner notice) | **per-agent** `KeyedSerializer` keyed by `agentKey(workspacePath, toAgent)` | `mailbox-delivery.ts:490-500` → `mailbox-wiring.ts:215` → `writeMessagePaced` (`message-write.ts:133`) |
| C | Delayed `--interrupt` (Spec 1313 maintainer round) | **per-terminal** for the bare `^C` only; the body then rides path B | `tower-routes.ts:1724-1752` |

A and C take the same lock. B takes a disjoint one. The two lock spaces never intersect,
so **A/C vs B is unserialized**, which is exactly what this issue names.

Three facts bound the analysis and were verified in code, not assumed:

1. `PtySession.write()` (`pty-session.ts:549`) is what *both* families call. It emits no
   delivery signal — only `handleUserInput` (`pty-session.ts:802`, human keystrokes) emits
   `'submit'`. So no write from inside a lock can synchronously re-enter the other lock.
2. `writeMessagePaced` (path B) reports `false` only when a **PTY write is dropped**
   (#1198, dead shellper socket). It cannot detect *semantic* loss — bytes the PTY
   accepted but the TUI then discarded.
3. The render gate's TOCTOU re-validation (`mailbox-delivery.ts:397`) closes the window
   between *classify* and *write start*. It does **not** cover the window from write start
   through the trailing Enter (50–130 ms+, longer for multi-line).

### Q1 — Can a gated delivery interleave *between* a Ctrl+C and the post-interrupt clean prompt?

**Yes, in both orderings, and the second is worse than the issue's framing suggests.**

The immediate-interrupt critical section is `^C` → 100 ms settle → text → Enter, all inside
one `submitToSession` acquisition (`tower-routes.ts:2023-2026`). Path B holds none of that
lock, so:

**Ordering 1 — mailbox write lands inside the interrupt's settle window.** The drainer
classifies clean at t₀, re-validates the ring token, starts `writeMessagePaced`. The
interrupt's `^C` fires at t₀+ε and its own text is scheduled for `^C`+100 ms. The mailbox
text and the interrupt text now occupy the same composer, and one Enter submits the fusion —
the exact `w1a` blob shape Spec 1313 exists to make impossible. Narrow (the `^C` must land
after the token re-check), but real.

**Ordering 2 — the `^C` lands inside the mailbox delivery's own text→Enter window, and the
row is still marked `delivered`.** The mailbox path writes its text at t₀ and schedules
Enter at t₀+50 ms (short) or +80 ms after the last line (multi-line). A `^C` arriving in
that window clears the composer. At t₀+50 ms the mailbox Enter fires into an empty prompt.
`writeMessagePaced` returns `true` — every byte *was* accepted by the PTY — so
`markDelivered` transitions the row (`mailbox-delivery.ts:463`) and the delivery is
broadcast.

That is **silent message loss with a false `delivered` audit record**. It is not a
cosmetic garble: the mailbox's whole contract is "a row reads `delivered` iff the message
reached the agent," and this path breaks it in the one direction the design refuses
elsewhere (the `#1198` dropped-write handling exists precisely to avoid marking a row
delivered when bytes did not land). The render gate cannot help — it proved the prompt
empty *before* the write, and nothing re-checks after.

Note the asymmetry with the interrupt path's own claim-first tradeoff
(`tower-routes.ts:1997-2008`): there, a lost message is a *documented, deliberate* choice
by the operator taking an explicit bypass. Here it is an autonomous background delivery
losing a message it reports as delivered, with no operator present. Same symptom,
different — and unaccepted — provenance.

### Q2 — Does the delayed-interrupt reshape leave a window where the body lands mid-turn?

**No.** The reshape (`tower-routes.ts:1715-1753`) fires only the `^C` on the timer; the body
is a persisted `not_before` row that can only ever leave the mailbox through
`deliverAgentMail`, which requires a render-verified empty prompt. There is no code path
from the delayed-interrupt timer to a body write. A mid-turn screen classifies not-clean →
held. The reshape is sound and needs no change.

Two true-but-benign residuals, worth writing down because #1481 will inherit them:

- **`^C`→body is not atomic.** The `^C` callback returns `0`, so the terminal lock releases
  immediately; `scheduleDrain` (line 1751) then runs the gate. Anything may occupy the
  terminal in between. This is *correct by design* — the gate re-decides — but it means the
  delayed interrupt guarantees "the turn was ended," never "this body is next."
- **The `^C` can be a no-op the caller cannot distinguish from success.** All liveness is
  re-checked inside the lock (lines 1733-1735) and a dead/unwritable session simply logs and
  drops the nudge. Fine today; a `--interrupt-after` that promises "interrupt *then* this
  message" (#1481) will need a stronger statement than the current logs provide.

Under Ordering 2 from Q1, though, the delayed path is *also* exposed: its `^C` is exactly
the writer that can clear another agent-bound delivery's half-written composer. The delayed
interrupt fires **unattended**, on a timer — so the "a human is standing at this terminal"
argument that makes the immediate path's race acceptable does not hold for it at all.

### Q3 — Is escalation/held state consistent if an interrupt tears the session mid-write?

**Bookkeeping stays internally consistent; its correspondence to reality does not.**

- **Session torn down mid-write** (socket death, not interrupt): `writeMessagePaced` returns
  `false` → `hold('no-live-pty')` (`mailbox-delivery.ts:458`), row stays held, escalation
  clock keeps running, `onHeldStateChange` unaffected. **Correct.**
- **Interrupt clears the composer mid-write** (Q1 Ordering 2): row → `delivered`, leaves the
  held set, `onHeldStateChange` fires, held count drops, any `escalated` flag becomes moot.
  Every derived indicator agrees with the DB, and the DB is **wrong**. There is no
  detector: nothing after the write re-examines the screen. **This is the inconsistency**,
  and it is invisible rather than noisy.
- **Immediate interrupt's own row**: claimed `delivered` before the write, by design
  (`tower-routes.ts:1997-2008`). Consistent with its documented tradeoff; unchanged here.
- **Escalation/liveness telemetry**: unaffected either way. `isClassifierStuck`
  (`mailbox-delivery.ts:242`) only escalates `no-profile` / `no-region-end` /
  `no-composer-marker`, so neither `busy` nor `no-live-pty` holds can false-alarm.

### Q4 — Should the disjoint-lock boundary stay accepted, or converge?

**Converge.** The three reasons, in order of weight:

1. **The failure is silent loss with a false `delivered`, not a garbled composer.** The
   issue's own "practical corruption surface is small" framing under-states it: the
   accepted-boundary argument covers the *fusion* case (Ordering 1) but not the
   *clear-then-Enter-into-nothing* case (Ordering 2), which was not separately reasoned
   about when the boundary was accepted. A row that reads `delivered` while the agent never
   saw the message is the one outcome Spec 1313's whole architecture is built to exclude.
2. **The "an operator is present" premise is false for the delayed path.** Path C fires on a
   timer with nobody watching, and #1481 (`--interrupt-after`) turns that from a rarity into
   a routine, *scheduled* co-occurrence of an interrupt and a pending gated delivery to the
   same terminal. The boundary gets *more* load-bearing exactly where the workstream is
   heading.
3. **The fix is cheap and cycle-free.** The per-terminal lock is acquired as a leaf inside
   the per-agent serializer, so the order is always agent → terminal and never the reverse;
   fact (1) above (writes emit no delivery signals) rules out re-entrancy. One mechanism,
   not two.

**What convergence must NOT do**, and this is the design's load-bearing constraint: taking
the per-terminal lock only moves the race unless the gate verdict is **re-validated inside
that lock**. A delivery that classifies clean, then waits ~150 ms behind an interrupt that
writes a whole message + Enter, and *then* writes, is strictly worse than today. The
in-lock precheck is not a refinement of the fix — it is the fix.

Equally, the lock must stay a **leaf around the write only**, never widened to cover the
async classify: `--interrupt` is the human's escape hatch for a wedged agent, and making it
queue behind a gate classification would be a real UX regression for the one action that
must always get through fast.

**Interlock note for #1481** (`--interrupt-after`): after this change, "interrupt, then
deliver this body" is expressible as *ordered acquisitions of one lock* rather than a race
between two. #1481 should build on that and should **not** re-introduce a body write outside
the gate. The residuals in Q2 (the `^C`→body gap is gate-mediated, not atomic; a no-op `^C`
is only logged) are the two things #1481 must design against explicitly.

---

## Part 2 — Proposed change (contingent on the gate ratifying Part 1)

Route path B's write edge through `submitToSession`, keyed by the terminal id, as a leaf
inside the existing per-agent serializer, with the gate verdict re-validated inside the lock.

### Design

**1. The delivery path learns the terminal id.** `DeliverySession`
(`mailbox-delivery.ts:52`) gains `readonly id: string`. `PtySession` already has it
(`pty-session.ts:118`), so the live binding is free; the four unit-test fakes gain one line
each. Preferred over casting `(session as PtySession).id` in the wiring — the delivery
module must *document* that its write takes a per-terminal lock, not hide it behind a cast.

**2. The `writeMessage` port gains an in-lock precheck and a typed result.** Today it is
`(session, msg, noEnter) => boolean | Promise<boolean>`, which cannot express "aborted
before writing anything." New shape:

```ts
export type WriteResult =
  | { status: 'written' }                          // every byte landed, Enter included
  | { status: 'dropped' }                          // #1198 partial/dropped → hold no-live-pty
  | { status: 'aborted'; reason: MailboxReason };  // precheck failed IN-lock → hold, nothing written

writeMessage(
  session: DeliverySession,
  formattedMessage: string,
  noEnter: boolean,
  precheck: () => MailboxReason | null,            // null = proceed
): WriteResult | Promise<WriteResult>;
```

`deliverAgentMail` supplies the precheck, so reason authority stays in the delivery module:

```ts
() => (!session.writable ? 'no-live-pty'
     : ringToken(session, profile) !== tokenBefore ? 'busy'
     : null)
```

This is the *same* pair of checks the code already runs at `mailbox-delivery.ts:397` and
`:424` — they are now re-run at the write instant, inside the lock, instead of only before
it. The pre-lock checks stay as cheap fast-paths (they avoid a pointless lock acquisition).

**3. `submitMessagePaced` — the new leaf.** In `message-write.ts` (which then imports
`session-submit.ts`; `session-submit.ts` imports nothing, so no cycle):

```ts
export async function submitMessagePaced(
  session: WritableSession & { id: string }, message: string, noEnter: boolean,
  precheck: () => MailboxReason | null,
): Promise<WriteResult>
```

It acquires `submitToSession(session.id, …)`, runs `precheck()` first thing inside the
callback (bail → return offset `0`, nothing written), otherwise runs the existing tracked
paced write and returns the completion offset so the lock is held through the trailing
Enter. Ordering guarantee is preserved: `submitToSession` registers its `sleep` timer
*after* `write()` returns — i.e. after the Enter's `setTimeout` was registered at the same
offset — so the Enter still executes before the promise resolves, exactly as
`writeMessagePaced` documents (`message-write.ts:124-127`).

`writeMessagePaced`'s only live caller is `mailbox-wiring.ts:215`; after this it is
test-only. It will be removed and its drop-semantics test (`spec-1313-paced-write-drop`)
re-pointed at `submitMessagePaced`, unless review prefers keeping the unlocked primitive
exported.

**4. Wiring.** `mailbox-wiring.ts:215` becomes
`writeMessage: (session, msg, noEnter, precheck) => submitMessagePaced(session, msg, noEnter, precheck)`.

**5. Outcome mapping in `deliverAgentMail`** (replacing the `if (!written)` at line 458):
`written` → `markDelivered` as today; `dropped` → `hold('no-live-pty')` as today;
`aborted` → `hold(reason)`. The `finally { memo?.delete(cacheKey) }` (line 447) stays
unconditional — an aborted write puts no bytes on the wire, but invalidating a verdict we
just proved stale is correct anyway, and keeping it unconditional preserves the
rejection-safety the comment argues for.

### Lock-order / deadlock safety (must hold, and does)

- Order is always **per-agent → per-terminal**; nothing acquires them in the reverse order.
  Paths A and C take only the per-terminal lock and never enter the per-agent serializer.
- No synchronous re-entry: `PtySession.write()` emits no `'submit'` signal (only
  `handleUserInput` does), and `'quiescence'` is emitted from an output timer
  (`pty-session.ts:503-508`), so no `scheduleDrain` can be raised from inside a lock's
  callback. Even if one were, it is `void`-ed onto a microtask and never awaited.
- Liveness: an interrupt now waits at most one in-flight paced write (~50–130 ms, longer for
  a long multi-line body) — acceptable, and the point of the change. It is **not** made to
  wait behind a gate classify.

### Files to change

- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` — `DeliverySession.id`;
  `WriteResult`; `writeMessage` port signature + doc; precheck construction and outcome
  mapping around `:397-:458`.
- `packages/codev/src/agent-farm/servers/message-write.ts` — add `submitMessagePaced`;
  retire `writeMessagePaced`.
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:215` — bind the new port shape.
- `packages/codev/src/agent-farm/servers/session-submit.ts:42-69` — **rewrite the "Exactly
  what it covers" boundary comment**: it now covers gated mailbox deliveries; state the
  per-agent → per-terminal order, why the lock is a leaf around the write and not the
  classify, and what remains deliberately uncovered (`POST /api/terminals/:id/write`, WS
  keystrokes). *Deliverable in either outcome.*
- `packages/codev/src/agent-farm/servers/tower-routes.ts:2017-2022` — replace the "flagged,
  not done here" scope paragraph with the converged guarantee.
- `codev/resources/arch.md` §7 item 5 (line ~1801) — **replace the "disjoint lock … accepted,
  documented boundary" sentence** with the converged model, plus a short statement of the
  delayed-interrupt sequencing (`^C` on the timer, body through the gate, not atomic by
  design). *Deliverable in either outcome.*
- Tests: new `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts`;
  fake-session updates in `send-delivery.test.ts`, `send-mailbox-repro.test.ts`,
  `cron-delivery.test.ts`, `send-architect-identity.test.ts`;
  `spec-1313-paced-write-drop.test.ts` re-pointed.

No skeleton mirror: this is `packages/codev` source and our own `codev/resources/arch.md`,
not framework template content.

### Phasing (git commits inside one PR)

1. **Convergence + unit tests** — the code above, red-to-green on the new race tests.
2. **Boundary model documentation** — `session-submit.ts`, `tower-routes.ts`, `arch.md`,
   written against what actually landed.
3. **CMAP consultation** (implementation + tests) and fixes; review doc.

## Risks & Alternatives Considered

- **Risk — the lock moves the race instead of closing it.** A delivery that classified clean
  before queuing behind an interrupt would write onto a screen the interrupt just changed.
  *Mitigation*: the in-lock precheck is mandatory, and is the primary thing the new tests
  assert. Without it this change is a regression, and the plan should be rejected if the
  precheck is dropped.
- **Risk — interrupt latency.** A `--interrupt` may now wait for an in-flight paced write.
  Bounded by one message's pacing; the lock deliberately excludes the classify so the wait
  can never be gate-length.
- **Risk — port signature churn breaks fakes.** Four test files. Compile-time, not runtime;
  a fake that fails to update fails the build.
- **Risk — `aborted` re-holds a row that would previously have been written.** That is the
  intent (it would have been written onto a screen that moved), but it makes `busy` holds
  marginally more frequent under contention. The backstop re-delivers within 1.5 s.
- **Alternative — accept the boundary (wontfix).** Rejected on Q1 Ordering 2: a false
  `delivered` on a lost message is not a robustness nicety, and #1481 removes the
  "operator is present" premise. Had the analysis found only Ordering 1, wontfix would have
  been defensible.
- **Alternative — widen `submitToSession` to hold across gate + write.** Rejected: it would
  queue the human's escape hatch behind an async classification, and it buys nothing the
  in-lock precheck does not.
- **Alternative — keep `boolean` and map an aborted write to `false`.** Simpler, no port
  churn, but reports `no-live-pty` for a `busy` abort — a lie in `afx inbox` and in the send
  response. Rejected for the typed result; noted as the fallback if review wants minimal
  surface.
- **Alternative — post-write verification (re-classify after Enter, re-hold on mismatch).**
  Rejected: detect-and-repair is the architecture Spec 1313 explicitly replaced, and a
  re-hold risks double delivery.

## Test Plan

**Unit** (new `spec-1365-serializer-convergence.test.ts`, fake sessions + injected clock,
recording an ordered write log):

- A gated delivery and a concurrent immediate-interrupt to the same terminal **never
  interleave**: the `^C` appears either wholly before the delivery's text or wholly after
  its Enter — never between. (Fails on `main`.)
- **Ordering 2 regression**: an interrupt racing an in-flight delivery no longer leaves the
  row `delivered` — the delivery either completes intact or aborts and the row stays `held`.
  (Fails on `main`: today the row reads `delivered` with nothing on the agent's screen.)
- **In-lock staleness**: gate returns clean, an interrupt writes while the delivery waits on
  the terminal lock → delivery writes **zero** bytes and holds `busy`; `markDelivered` never
  runs.
- **In-lock unwritable**: session becomes unwritable while queued → holds `no-live-pty`,
  nothing written.
- **Preserved semantics**: dropped write (#1198) still holds `no-live-pty`; two deliveries to
  one agent still cannot interleave; the promise still resolves *after* the Enter.
- **Lock hygiene**: after mixed delivery/interrupt/escape traffic settles,
  `pendingSubmissionSessions() === 0` and the per-agent serializer is inactive — no leak, no
  wedge, all promises settle (deadlock-freedom).
- **Escape** unchanged.

**Regression suites to re-run**: `spec-1273-submission-lock`, `spec-1273-interrupt`,
`write-queue`, `mailbox`, `send-delivery`, `send-mailbox-repro`, `send.test`,
`spec-1313-paced-write-drop`, `spec-1307-send-delay`, `cron-delivery`, `tower-routes`,
plus a full `pnpm --filter @cluesmith/codev test` and `build`.

**Manual (for the `dev-approval` gate)** — with a live Tower and two agents:

1. `afx send <agent> "<long multi-line body>"` and, within the same second,
   `afx interrupt <agent>` from a second shell. Repeat ~10×. Expect: never a fused
   composer, and **never** a row in `afx inbox`/`afx inbox show` reading `delivered` whose
   text did not appear on the agent's screen.
2. `afx send <agent> --delay 5 --interrupt "<body>"` against a mid-turn agent: `^C` at due
   time, body lands only once the prompt is clean, exactly one copy.
3. `afx interrupt` against a busy agent still responds promptly (no gate-length stall).
4. `afx send <agent> --escape` unchanged; a not-writable target still 503s
   `TERMINAL_NOT_WRITABLE`.

**Cross-platform**: none — server-side Node only, no UI surface.
