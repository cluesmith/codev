# PIR Plan: Give the render gate an observation of PTY input

Issue: [#1473](https://github.com/cluesmith/codev/issues/1473) — "Render gate: fuller close of
the gate→write input race (R7 staleness) and input-echo-lag residual"

**Revision 2** — addresses the 2-way consult (claude + codex) and architect verification posted as
[issue comment 5545347014](https://github.com/cluesmith/codev/issues/1473#issuecomment-5545347014).
The design shape is unchanged (two mechanisms, fail-safe `'external'` default, flag-not-hold past
the point of no return); the three blockers are fixed and every decide/document item is answered
below. **I re-verified each reviewer claim against the source myself** — every one held, and two of
them turned out to be worse than described. Where my re-check *changed* the answer, it is called
out inline.

## Understanding

### What is actually left open

The architect's pre-spawn comment re-pinned the issue against `03bc5213e`. I re-checked every row
against the files; it holds.

**The output side is closed.** `ringToken()` (`mailbox-delivery.ts:520`) is sampled at `:606`,
re-checked pre-lock at `:653`, and re-checked again *inside* the per-terminal lock at `:703`
(`precheck`, #1365). `SETTLE_BEFORE_WRITE_MS = 250` + `settled()` (`:422`, `:447`) gate on output
quiescence before the write; `watchEcho`/`echoNeedle`/`verify()` (#1573, #1584) confirm the write's
own echo after it. The Notes' "consider an explicit post-write echo settle" therefore **already
landed, as #1573** — it must not be redone.

**The input side has no observation at all.** That is the whole of what remains:

- `ringToken` = `` `${session.bytesWritten}:${cols}x${rows}:${app}` `` (`:521`), and `bytesWritten`
  is the ring's **output** counter (`pty-session.ts:930-931` → `RingBuffer.bytesWritten`).
- `settled()` keys on `session.lastDataAt`, and `_lastDataAt` is assigned in exactly one place —
  `onPtyData` (`pty-session.ts:514-516`), i.e. **output**.
- `PtySession.write()` (`pty-session.ts:628-640`), the single funnel for user input, records
  **nothing**: no counter, no timestamp.

The code says so itself in three places, and names this issue as the owner:
`mailbox-delivery.ts:696-700`, `mailbox-delivery.ts:735-737` ("PTY INPUT does not advance the ring
— only OUTPUT does"), and `session-submit.ts:121-127`.

### The two residuals, restated precisely

1. **R1 — gate→write input race (the R7 staleness case).** A keystroke lands *after* `tokenBefore`
   is sampled at `:606`. Both re-checks compare an output counter the keystroke did not move, so
   until the TUI happens to echo it the guard reads "unchanged" and the write proceeds onto a line
   the human has started typing on. Our Enter then submits their half-typed draft as the agent's
   message.
2. **R2 — input-echo lag.** A keystroke lands *before* the sample and has not been echoed into the
   ring yet. No counter comparison can catch this — both samples agree, correctly — and the
   classifier reads a genuinely empty composer, because the character is still in flight through
   WS → Tower → shellper → PTY → app render. This one needs a *clock*, not a counter.

### An existing partial chokepoint, and why it cannot simply be consumed

`PtySession.handleUserInput()` (`pty-session.ts:949-957`) is the documented single chokepoint for
live keyboard input (`tower-websocket.ts:72,100`; `pty-manager.ts:324,330`) and already calls
`recordUserInput()` → `_lastInputAt`. So a timestamp exists; the gate never consults it.

**It cannot be consumed as-is, and this is Blocker 1.** `Terminal.tsx:639` forwards *everything*
xterm.js emits on `onData` to that chokepoint, and xterm emits terminal **replies** through the
same event. The client strips only DA/DA2, CPR and DECRPM (`Terminal.tsx:655-661`) and **only while
`rc.initialPhase` is true** — I traced the flag: set on every connect (`:421`, `:462`), cleared by
`flushInitialBuffer` (`:469`) on a short post-connect timer. For the entire steady-state life of a
session the filter is **off**. Focus reports (`ESC[I`/`ESC[O`) and mouse reports are never filtered
at all, in any phase.

Consuming `lastInputAt` without a server-side filter would therefore produce:

1. **False holds with no human present** — replies are provoked *by output*, so they cluster
   exactly where deliveries cluster.
2. **A self-trip route the `'delivery'` origin cannot close.** Our paced write causes a repaint;
   the repaint carries a query; the browser replies; the reply counts as foreign input. This is the
   honest answer to the architect's self-trip question, and revision 1 missed it entirely.
3. **Starvation, not merely latency.** `busy` is excluded from `isClassifierStuck` (`:404`), so a
   terminal with a chatty attached client would never escalate — it would silently never deliver.

`inputSeq` and `lastInputAt` are therefore only trustworthy behind a server-side reply filter, and
the filter is a precondition of the whole design rather than a refinement of it.

## Proposed Change

### 1. Server-side terminal-reply filter (Blocker 1) — `terminal-replies.ts` (new)

A pure, exported, unit-testable function:

```ts
export function stripTerminalReplies(data: string): string
```

It removes complete, well-formed reply sequences and returns the residue. The enumerated set:

| Reply | Pattern |
|---|---|
| Primary/secondary/tertiary DA | `\x1b\[[?>=][0-9;]*c` |
| CPR / DECXCPR | `\x1b\[[0-9]+;[0-9]+R`, `\x1b\[\?[0-9]+;[0-9]+;[01]R` |
| DECRPM (mode report) | `\x1b\[\??[0-9;]*\$y` |
| Focus in / out | `\x1b\[I`, `\x1b\[O` |
| Mouse — SGR / X10 | `\x1b\[<[0-9;]+[Mm]`, `\x1b\[M[\s\S]{3}` |
| DECRQSS reply (DCS) | `\x1bP[0-9]\$r[^\x1b]*\x1b\\` |
| XTVERSION | `\x1bP>\|[^\x1b]*\x1b\\` |
| OSC colour replies | `\x1b\][0-9;]+;rgb:[0-9a-fA-F/]+(\x07\|\x1b\\)` |

**Server-side and unconditional**, because `afx attach`, the VS Code webview and mobile clients do
not share the client-side filter. Anchored, specific patterns only — never a blanket "starts with
`ESC[`", which would eat real function keys and arrow keys.

**Where it applies, and where it deliberately does not.** It decides the *gate signal* only; the
bytes still reach the PTY verbatim, because the application asked for the reply. It runs in
`handleUserInput` and nowhere else — the raw `POST /api/terminals/:id/write` passthrough
(`tower-routes.ts:960`) is a programmatic writer that no terminal replies through, so it keeps the
plain fail-safe default.

**Failure directions, both acceptable and asymmetric in the right way.** Over-stripping (a human
types something the filter matches) yields an uncounted keystroke — *exactly today's behaviour*, so
never a regression. Under-stripping (a reply the table misses) yields a spurious HOLD that the
backstop clears. Neither can write onto a draft.

**Bracketed paste** (`ESC[200~`…`ESC[201~`) is deliberately *not* stripped: the content between the
markers is real user input and must count.

**Scope note — `composing` is left alone.** Today a reply containing no `\r` calls
`startComposing()`, so replies already mark a session as composing with no human present. That is a
real latent bug, but `composing`/`stopComposing` drive the `'submit'` fast trigger
(`pty-session.ts:984`), and I am not perturbing a delivery trigger inside an issue about delivery
safety. I confirmed `get composing()` (`:988`) has **no production consumer** outside
`pty-session.ts` — so the blast radius of leaving it is nil. It goes in the review as a follow-up.

### 2. `PtySession` observes input — fail-safe by default (`pty-session.ts`)

```ts
export type WriteOrigin =
  /** Default — an unknown/foreign writer. Counts as input. */
  | 'external'
  /** The gated delivery's own paced write. Must never trip the gate's input signal. */
  | 'delivery'
  /** The caller already recorded the (filtered) signal for this chunk — see handleUserInput. */
  | 'pre-recorded';

write(data: string, origin: WriteOrigin = 'external'): boolean
```

The `'external'` default is the spine of the design, and both reviewers endorsed keeping it:
counting only at known chokepoints and opting *in* is precisely how the current hole was made. A
future input path is covered the moment it exists, and becoming invisible to the gate requires
saying so out loud.

`handleUserInput` becomes:

```ts
handleUserInput(data: string): void {
  const human = stripTerminalReplies(data);
  if (human) this.recordUserInput(human);   // filtered signal — replies bump nothing
  if (data.includes('\r') || data.includes('\n')) this.stopComposing();
  else this.startComposing();               // unchanged, per §1's scope note
  this.write(data, 'pre-recorded');         // full chunk still reaches the PTY
}
```

**Counter naming (decide-item).** `.length` is UTF-16 code units, not bytes, so `inputBytes` would
lie. The field is named **`inputSeq`** and documented as *a monotone change counter — it exists to
differ, not to total*; it advances by `data.length`. A change token needs only monotone increment,
and `.length` is the cheap choice on an input hot path.

**`recordUserInput()` keeps its signature and behaviour** (`typing-awareness.test.ts:63-161`
asserts it moves `lastInputAt`); it gains an optional chunk argument for the `inputSeq` bump. The
now-duplicate call inside `handleUserInput` is replaced by the filtered one above, and `write()`'s
`'external'` branch calls it too, so keyboard input and raw-route input can never diverge again.

**Return-path semantics (decide-item).** The bump happens on the `'external'` branch **regardless
of the write's return value**, including a dropped write to a dead shellper socket. The question
the counter answers is "did a foreign writer put input at this session?", not "did it land". A
dropped write cannot then mask itself as `busy` instead of `no-live-pty`, because `precheck` tests
`session.writable` *before* the token (`:702` before `:703`).

**Monotonicity, stated precisely (decide-item).** The *token* is not globally monotone — geometry
and resolved app can change back and forth. The *counters* are, and that plus the
session-object-identity guard is what preserves `CachedVerdict`'s non-aliasing argument (`:536`).
`_inputSeq` must therefore **never reset**, including across a spawn relaunch and `attachShellper`
(`:263-267`), both of which replace the PTY while keeping the same `PtySession` object. Note
`attachShellper` *does* hydrate `_lastDataAt` from the shellper's tracker; `_inputSeq` and
`_lastInputAt` get no such hydration and must be left untouched there. A test pins this.

### 3. The delivery's own write opts out (`message-write.ts`)

Per codex's construction, which is the safer one and which I verified is safe here: the origin is
**hard-coded in the `tracked` wrapper**, not threaded as a parameter through the general helpers.

```ts
const tracked: WritableSession = {
  write: (data: string): boolean => {
    const ok = session.write(data, 'delivery');
    if (!ok) delivered = false;
    return ok;
  },
};
```

This is Blocker 3's sharpest point: a 1-arg function **is** assignable to a 2-arg function type, so
TypeScript would not have caught a wrapper that forgot to forward an origin parameter, and the
failure mode is "mail never delivers". Hard-coding removes the opportunity.

**I verified this cannot mis-tag an operator write.** `submitMessagePaced` has exactly *one*
production caller — `mailbox-wiring.ts:301`, the delivery `writeMessage` port. The operator
bypasses use `writeEscapeToSession`/`writeMessageToSession` directly under `submitToSession`
(`tower-routes.ts:2113`, `:2197`), and the delayed `^C` calls `live.write('\x03')` raw
(`tower-routes.ts:1834`) — all three keep the `'external'` default and correctly count.

`WritableSession` (`message-write.ts:11-20`) also gains `readonly inputSeq: number`, which §5 needs.

### 4. The gate consumes both signals (`mailbox-delivery.ts`)

`DeliverySession` (`:60-105`) gains `readonly inputSeq: number` and `readonly lastInputAt: number`,
documented like the existing `bytesWritten`/`lastDataAt` pair.

**Counter → token (R1):**

```ts
function ringToken(session, profile) {
  return `${session.bytesWritten}:${session.inputSeq}:${session.info.cols}x${session.info.rows}:${profile.app}`;
}
```

**Restating why the counter is load-bearing (decide-item).** Claude is right that the headline R1
case is largely covered by the settle alone — a post-sample keystroke is by construction <300 ms
old at both check points. The counter earns its place on two other cases, and without naming them a
future reader will delete it as redundant:

- **Waits longer than the settle.** `OPERATOR_SUBMIT_WAIT_CEILING_MS = 2000` (`session-submit.ts:223`),
  so a delivery can sit on the per-terminal lock for up to 2 s between `tokenBefore` and the in-lock
  `precheck`. A keystroke landing early in that wait is >300 ms old by the time `precheck` runs and
  passes the settle cleanly. Only the counter catches it. Slow classifies are the same shape.
- **Verdict-memo invalidation.** A `CachedVerdict` entry survives across backstop ticks, so the gap
  between the cached classify and its reuse is unbounded by any settle. Without `inputSeq` in the
  token, a CLEAN verdict can be reused across a keystroke — the caveat the code currently admits at
  `:735-737`, which this retires verbatim.

**Clock → settle (R2):**

```ts
export const INPUT_SETTLE_BEFORE_WRITE_MS = 300;
function inputSettled(ports, session): boolean {
  return ports.now() - session.lastInputAt >= INPUT_SETTLE_BEFORE_WRITE_MS;
}
```

Checked at both places `settled()` is checked — pre-lock (`:659`) and in-lock `precheck` (`:704`) —
holding `'busy'` exactly as the output settle does, and phrased as a positive `>=` for the same NaN
reason `settled()` documents. 300 ms is one notch above the output settle's 250 ms because the
input round trip is strictly longer than the output one it must cover. `_lastInputAt` initialises
to `0`, so a session that has never received input is settled from birth.

**This BOUNDS R2; it does not close it (decide-item).** Revision 1 said "closes", which overclaims.
Two cases survive by construction, and they are named in the plan, in the code comment, and in the
review: input older than 300 ms whose echo is still delayed, and input still in flight from the
browser when the sample is taken. The dev-gate measurement (Test Plan) exists to size the bound
honestly, with the rollback criterion stated there.

### 5. During the paced write (`message-write.ts`)

Sections 1–4 cover everything up to the first byte. Between the first byte and the Enter there is
still an 80 ms-to-seconds window (long bodies pace at 10 ms/line). Bytes are out by then, so this is
a **reporting** problem.

Mirror the existing `watchBypasses` shape: sample `session.inputSeq` before the write, compare
after, and surface it on the result — `| { status: 'written'; racedByInput?: boolean }`.

**Flag, not hold — the opposite call from `preempted`, on purpose.** `preempted` holds because an
operator `^C`/ESC may have cleared the composer, so the message plausibly never landed. Re-writing
a message that *did* land is the #1584 re-injection failure, and there is no attempt cap anywhere
in the module.

**Correction to revision 1 (decide-item).** I wrote "a keystroke removes nothing." That is wrong: a
human **Enter** mid-paced-write submits our partial body, and `^U`/`^W`/`^C` truncate it. The
flag-not-hold decision survives — re-writing is still the worse outcome — but the WARN text must
say the message **may have been truncated or submitted early**, not merely that stray characters
were added.

### 6. Escalate `racedByInput` independently of echo (Blocker 2)

I confirmed the `verified === false` escalation is nested inside `if (echo)`
(`mailbox-delivery.ts:819-858`), and that `echo` is `null` whenever `echoNeedle()` returns `''`.
Revision 1's "joins the existing path" was therefore wrong twice over:

- **short/raw sends have no needle**, so the flag would be dropped entirely;
- **the Enter-truncation case makes `verified` come back `true`** — the needle is the message's
  *first line*, which landed — while the tail was lost. `racedByInput` is the only signal for that
  failure, and the one place revision 1 put it is the one place it would be suppressed.

So:

```ts
const unverified = result.racedByInput === true || verified === false;
```

evaluated **outside** the `if (echo)` block, escalating exactly once. `UnverifiedDeliveryInfo`
(`:323`) gains a discriminator — `cause: 'no-echo' | 'input-raced'` — threaded into the WARN text
and into `surfaceUnverifiedDelivery`'s notification body (`mailbox-wiring.ts:524-535`), whose text
currently hard-codes "its header never appeared on that screen". An operator today cannot tell
"header never appeared" from "a human typed into it mid-write"; these are different remedies.

### 7. Comments that currently document the hole

Three blocks assert this residual is open and name #1473; all must be updated in the same change or
the codebase will contradict itself: `mailbox-delivery.ts:696-700`, `mailbox-delivery.ts:735-737`,
`session-submit.ts:121-127`. Each must state the **surviving** residuals from §4 and §5 rather than
claiming closure.

## Files to Change

**Phase 1 — input observation + reply filter**

- `packages/codev/src/terminal/terminal-replies.ts` — new; `stripTerminalReplies`
- `packages/codev/src/terminal/pty-session.ts:628-640` — `WriteOrigin` param; bump on `'external'`
- `packages/codev/src/terminal/pty-session.ts:930-971` — `get inputSeq()`; re-doc
  `recordUserInput`/`lastInputAt` as the gate's input signal
- `packages/codev/src/terminal/pty-session.ts:949-957` — `handleUserInput` filtered bump +
  `'pre-recorded'` write
- `packages/codev/src/terminal/pty-session.ts:263-267` — assert `attachShellper` leaves `_inputSeq`
  and `_lastInputAt` untouched
- new: `packages/codev/src/terminal/__tests__/terminal-replies.test.ts`

**Phase 2 — gate consumption**

- `packages/codev/src/agent-farm/servers/message-write.ts:11-20` — `WritableSession.inputSeq`
- `packages/codev/src/agent-farm/servers/message-write.ts:189-195` — `tracked` hard-codes `'delivery'`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:60-105` — `DeliverySession` fields
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:520-522` — `ringToken` folds `inputSeq`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:415-450` — `INPUT_SETTLE_BEFORE_WRITE_MS`
  + `inputSettled()`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:653-710` — both check points

**Phase 3 — during-write watch + reporting**

- `packages/codev/src/agent-farm/servers/message-write.ts:120-134,180-218` — `racedByInput`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:323-329` — `cause` discriminator
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:815-860` — `unverified` outside `if (echo)`
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:524-535` — cause-aware notification text

**Phase 4 — comments, review, thread** (§7, plus `codev/reviews/1473-…md`,
`codev/state/pir-1473_thread.md`)

**Test doubles to migrate** — the four the architect caught break at **runtime, not compile time**;
I confirmed all four, and add the nine `DeliverySession` fakes:

- `tower-routes.test.ts:226` `gateSession` — structural, reaches the live wiring binding. Missing
  `lastInputAt` → `now() − undefined` → NaN → `inputSettled()` false → **every send test in the file
  holds instead of delivering**
- `tower-websocket.test.ts:61` `makeSession` — same shape
- `spec-1313-paced-write-drop.test.ts:33-45` — a `WritableSession & {id}` with no `inputSeq`
- `send-architect-identity.test.ts:108` — calls `s.write(msg)` on a **real** session to simulate a
  delivery; under the new default that becomes external input. Adding fields does not fix it — it
  must pass `'delivery'`
- `DeliverySession` fakes: `spec-1470-reentry-delivery`, `send-architect-identity`, `cron-delivery`,
  `bugfix-1584-no-rewrite-after-write`, `send-mailbox-repro`, `bugfix-1573-delivery-verification`,
  `spec-1365-serializer-convergence`, `spec-1307-send-delay`, `send-delivery`
- `typing-awareness.test.ts:63-161` — **must keep passing unchanged**; `recordUserInput()` stays a
  real assignment, never a no-op

No `codev-skeleton/` mirror: this is product source under `packages/`, not framework template
content.

## Risks & Alternatives Considered

### Latency — restated with the numbers, and sharpened

- **`QUIESCENCE_DEBOUNCE_MS = 500` (`pty-session.ts:40`) > 300**, so any quiescence-triggered pass
  is automatically input-settled whenever the last input preceded the last output byte — the normal
  case, since the TUI echoes. This is the main delivery trigger and it is unaffected.
- **The `'submit'` trigger is now *provably always* held, not "largely unaffected".**
  `mailbox-wiring.ts:600` wires `'submit'` to `scheduleDrain`, which runs in a microtask, so
  `lastInputAt === now` at that pass, always. Revision 1 hedged this; it is a certainty. The cost is
  bounded: that body slips to the quiescence trigger ≥500 ms later, which would usually have held on
  the *output* settle anyway.
- **"Only bites while actively typing" was too narrow** (codex). A single navigation key that
  provokes no output can cost close to a full backstop period (1.5 s), because nothing re-triggers a
  drain until the next tick.
- **The delayed `^C` rationale in revision 1 was wrong.** `tower-routes.ts:1834` is documented three
  lines below as firing **UNATTENDED**, so "a human is standing at that terminal" does not apply. It
  should still count — it changes composer state, and a delivery must not write across it — but the
  consequence must be stated: the `scheduleDrain` nudge right after it is now guaranteed to hold,
  slipping the body to the quiescence trigger.

**Mitigation deferred, not missing.** A one-shot re-drain armed at the settle's remaining ms would
recover the `'submit'` case. It is a small follow-up, and I would rather measure at the dev gate
than build it speculatively — the gate exists for exactly this.

### Other risks

- **Self-trip.** Two routes, not one. (a) Our own paced write — closed structurally by §3's
  hard-coded `'delivery'`, plus a test that runs a real multi-line paced write and asserts
  `inputSeq` is unchanged across it. (b) **Our write → repaint → query → browser reply → counted as
  input** — closed only by §1's filter. A regression in either presents as "mail never delivers".
- **A new input path forgets to count.** Inverted by the `'external'` default: an author must
  deliberately opt out.
- **Test-fake churn.** Optional fields would avoid it but make `undefined` timestamps read as NaN →
  hold, breaking the same tests while letting production compile a port that silently reads "no
  input". Required fields, migrated fakes.

### Surviving residuals — stated in the plan, the code and the review

1. **R2 is bounded, not closed** (§4): input older than 300 ms whose echo is still delayed, and
   input in flight from the browser at sample time.
2. **During-write races are reported, not prevented** (§5). Bytes are already out.
3. **Input via a directly-attached shellper client** never passes through this `PtySession` and
   stays unobservable. A different boundary, already listed as uncovered at `session-submit.ts:56-58`.
4. **A reply the §1 table misses** counts as input → a spurious hold the backstop clears.

The issue is a *narrowing*, and the code comments will say so rather than asserting #1473 is closed.

### Alternative — `lastInputAt > lastDataAt` instead of a constant (evaluated; rejected, with the reason recorded)

Claude's proposal: "input arrived and nothing has been painted since" is constant-free and also
covers the >300 ms un-echoed residual. It is genuinely stronger on coverage. **Rejected as the
primary mechanism because it can deadlock permanently.** An input that provokes *no output ever* —
a key the TUI ignores — leaves the condition true forever: the gate holds `busy`, `busy` is excluded
from `isClassifierStuck` (`:404`), so nothing escalates and that agent's mail never delivers. Trading
a bounded 300 ms hold for an unbounded silent one is the wrong direction for an issue whose entire
premise is fail-safe hardening.

The architect's note that it is viable "only if Blocker 1 is fixed first" is necessary but not
sufficient: the filter removes the *reply*-driven deadlock, not the ignored-keystroke one.

**Recorded as the natural next tightening, in bounded form.** If the dev-gate measurement shows
300 ms is too loose, the right move is `lastInputAt > lastDataAt` **capped by a ceiling** (hold while
un-echoed, up to ~1 s, then fall back to the settle) — coverage without the deadlock. I am not
building it now because it adds a second constant and a second mechanism to close a residual I
cannot yet demonstrate.

### Alternatives previously considered, unchanged

- **Make `bytesWritten` count input too.** Rejected: it is the ring's output counter and the mirror
  flush loop compares it in lockstep (`pty-session.ts:780-786`); input bumping it would make that
  loop spin.
- **Settle only, no counter.** Rejected — see §4's two load-bearing cases (2 s lock waits, memo
  invalidation).
- **Counter only, no settle.** Rejected: cannot see input that landed before the sample and has not
  echoed. Both samples agree, correctly.
- **Hold on a during-write race.** Rejected: re-writes a message that landed (#1584).

## Test Plan

### Unit (`vitest`, `packages/codev`)

- **Reply filter:** each row of §1's table is stripped; arrow keys, function keys, a bare `ESC`,
  Ctrl-chars, UTF-8 text and bracketed-paste content all survive; a mixed chunk
  (`"a" + CPR + "b"`) yields `"ab"`.
- **Signal plumbing:** `write(d)` bumps `inputSeq` by `d.length` and moves `lastInputAt`;
  `write(d, 'delivery')` moves neither; `write(d, 'pre-recorded')` moves neither. A dropped write
  (`false`) still bumps on the `'external'` branch. `handleUserInput` with a pure DA reply bumps
  **nothing**; with real text bumps. The raw `/api/terminals/:id/write` route bumps.
  `attachShellper` leaves both untouched. `typing-awareness.test.ts` passes unchanged.
- **R1:** `classify` resolves asynchronously with `inputSeq` incremented during the await → held
  `'busy'`, `writeMessage` never called. Same with the increment inside the in-lock `precheck`
  window. **Plus the two cases the counter exists for:** an increment during a >300 ms simulated
  lock wait (which the settle alone would pass), and a `CachedVerdict` that must not be reused
  across an increment.
- **R2:** clean, output-settled screen with `lastInputAt = now − 100` → held `'busy'`; `now − 400`
  → delivered; boundary at exactly 300 ms.
- **Self-trip:** a real `submitMessagePaced` over a 5-line body → `written`, and `inputSeq` is
  unchanged across the whole paced write.
- **During-write race + Blocker 2, all four quadrants:** `racedByInput` with (a) `verified === true`,
  (b) no echo needle at all, (c) `verified === false` — escalating **exactly once** in each, with
  the right `cause`; and (d) no race, `verified === true` → no escalation. In every case the row
  stays `delivered` and is never re-written (the #1584 invariant).
- Full existing suite green — especially `tower-routes`, `tower-websocket`,
  `spec-1313-paced-write-drop`, `bugfix-1584-no-rewrite-after-write`,
  `spec-1365-serializer-convergence`, `bugfix-1573-delivery-verification`, `render-gate`,
  `typing-awareness`.

### Manual, against a running Tower at the dev-approval gate

This is why the issue is PIR — "verified against a running terminal, not only unit tests."

1. **The reply-traffic measurement (Blocker 1's direct evidence).** Browser attached, hands **off**
   the keyboard, agent running: log every `handleUserInput` chunk for 60 s, and log what the filter
   strips vs. keeps. Expected: zero surviving residue. This runs *first* — if replies still get
   through, nothing downstream is trustworthy. Repeat for the VS Code webview and `afx attach`.
2. **The 300 ms calibration.** Log the observed keystroke→echo gap across claude and codex, local
   and shellper-backed. **Rollback criterion:** if p99 exceeds 300 ms, raise the constant to
   p99 + margin; if that would need to go past ~500 ms, adopt the bounded `lastInputAt > lastDataAt`
   refinement instead of a larger constant, and re-open the plan.
3. `afx send` to a builder while typing into that builder's composer → the message holds, the draft
   is untouched, `afx inbox` shows `busy`. ~10× at different points in the keystroke stream.
4. Stop typing → delivers on the next backstop tick (≤ ~1.8 s).
5. Idle terminal → `afx send` still delivers promptly; measure the delta against `main` to confirm
   no regression on the common path. Separately measure the `'submit'`-trigger case, which §"Latency"
   predicts is now always deferred to quiescence.
6. `--interrupt` / `--escape` mid-delivery still behave as #1365 defines (`preempted` → hold), and
   the delayed `^C` still fires and now correctly counts as input.

Cross-platform: n/a (server-side Node). The only client-side file read is `Terminal.tsx`, and it is
**not modified** — the filter is deliberately server-side.
