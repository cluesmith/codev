# PIR Plan: Give the render gate an observation of PTY input

Issue: [#1473](https://github.com/cluesmith/codev/issues/1473) — "Render gate: fuller close of
the gate→write input race (R7 staleness) and input-echo-lag residual"

## Understanding

### What is actually left open

The issue body was written 2026-08-17; the architect's pre-spawn verification comment
(2026-09-04 @ `03bc5213e`) re-pinned it against HEAD, and I re-verified every claim in that
table against the files. It holds, and it narrows the scope considerably:

**The output side is closed.** `ringToken()` (`mailbox-delivery.ts:520`) is sampled at `:606`,
re-checked pre-lock at `:653`, and re-checked again *inside* the per-terminal lock at `:703`
(`precheck`, #1365). `SETTLE_BEFORE_WRITE_MS = 250` + `settled()` (`:422`, `:447`) gate on
output quiescence before the write, and `watchEcho`/`echoNeedle`/`verify()` (#1573) confirm the
write's own echo after it. The Notes' "consider an explicit post-write echo settle" has
therefore already landed — as #1573 — and must not be redone.

**The input side has no observation at all.** That is the whole of what remains:

- `ringToken` = `` `${session.bytesWritten}:${cols}x${rows}:${app}` `` (`:521`), and
  `bytesWritten` is the ring's **output** counter (`pty-session.ts:930-931` → `RingBuffer.bytesWritten`).
- `settled()` keys on `session.lastDataAt`, and `_lastDataAt` is assigned in exactly one place —
  `onPtyData` (`pty-session.ts:514-516`), i.e. **output**.
- `PtySession.write()` (`pty-session.ts:628-640`), the single funnel for user input
  ("WebSocket → write() → shellper", `:232`), records **nothing**: no counter, no timestamp.

So a human keystroke that has not yet been echoed back by the TUI is invisible to `tokenBefore`,
to **both** re-checks, and to `settled()`. The code says so itself, in two places, and names this
issue as the owner: `mailbox-delivery.ts:696-700` and `session-submit.ts:121-127`
("`ringToken` counts OUTPUT bytes, so input written by a path that does not take this lock … can
sit un-echoed on the line and read as unchanged … the echo-lag residual for the rest is #1473's
territory"), plus the memo-invalidation comment at `:735-737` ("PTY INPUT does not advance the ring —
only OUTPUT does").

### The two residuals, restated precisely

1. **R7 / gate→write input race.** A keystroke lands *after* `tokenBefore` is sampled at `:606`.
   Both re-checks compare an output counter that the keystroke did not move, so — until the TUI
   happens to echo it — the guard reads "unchanged" and the write proceeds onto a line the human
   has started typing on. The message fuses with their draft, and their half-typed thought is
   submitted as the agent's message by our Enter.
2. **Input-echo lag.** A keystroke lands *before* the sample but has not been echoed into the ring
   yet. Nothing a counter comparison can catch — both samples agree, correctly — and the
   classifier itself reads a genuinely empty composer, because the character is still in flight
   through WS → Tower → shellper → PTY → app → output. This one needs a *clock*, not a counter.

They are complementary, and neither mechanism covers the other's case. That is why the fix below
is two mechanisms rather than one.

### There is already a partial input chokepoint — and it is not enough

`PtySession.handleUserInput()` (`pty-session.ts:949-957`) is the documented single chokepoint for
live keyboard input (`tower-websocket.ts:72,100`; `pty-manager.ts:324,330`) and already calls
`recordUserInput()` → `_lastInputAt` (Spec 403 typing-awareness). So a timestamp for *keyboard*
input exists; the gate simply never consults it. It does **not** cover the raw
`POST /api/terminals/:id/write` passthrough (`tower-routes.ts:960` calls `session.write()`
directly), and there is no byte counter anywhere. Both gaps have to be closed for the gate to
trust the signal.

## Proposed Change

Give the session an input observation, then have the gate consume it in both of the two shapes the
two residuals require: a **monotone counter** folded into the change token (closes R7) and a
**settle interval** on the last input timestamp (closes echo lag).

### 1. `PtySession` observes input — fail-safe by default (`pty-session.ts`)

Add `_inputBytes` (monotone; `.length` of every chunk of *foreign* input accepted) and keep
`_lastInputAt`, exposed as `get inputBytes()` / the existing `get lastInputAt()`. Both are bumped
in `write()` itself, from a new `WriteOrigin` parameter:

```ts
export type WriteOrigin = 'external' | 'delivery';
write(data: string, origin: WriteOrigin = 'external'): boolean
```

**The default is `'external'` on purpose.** Counting at the two known chokepoints
(`handleUserInput` + the raw route) and opting *in* would leave any future input path silently
uncounted — which is exactly today's bug, re-created. Defaulting to "this is input" means a new
writer is covered the moment it exists, and the only way to be invisible to the gate is to say so
explicitly. The failure direction of a mistake is then a spurious HOLD, never a write onto a
draft.

Exactly one caller opts out: the gated delivery's own paced write. Everything else — the raw
passthrough, `handleUserInput`, and the operator `^C`/ESC gate-bypasses — counts as input, which
for the bypasses is not a workaround but the correct answer (a human is standing at that
terminal, and a concurrent delivery should hold).

`recordUserInput()` stays (Spec 403 uses `lastInputAt`/`isUserIdle` for typing-awareness) but its
timestamp assignment moves under `write()`'s external branch so keyboard and raw-route input can
never diverge again.

### 2. The delivery's own write opts out (`message-write.ts`, `mailbox-delivery.ts`)

`WritableSession.write` gains the optional `origin` argument; `writeMessageToSession` and
`writeEscapeToSession` thread a `WriteOrigin` from their caller, and `submitMessagePaced` passes
`'delivery'`. This is the "must not self-trip" requirement: `submitMessagePaced` writes through
the same `PtySession.write()`, and its text→Enter pacing spans `(lines−1)×10+80` ms, so without
the opt-out the in-lock precheck at `:703` (which runs before the first byte) would be fine but
the *next* delivery, the verdict memo, and the during-write watch in step 4 would all fire on our
own bytes.

`DeliverySession` (`mailbox-delivery.ts:60-...`) gains `readonly inputBytes: number` and
`readonly lastInputAt: number`, documented like the existing `bytesWritten`/`lastDataAt` pair.

### 3. The gate consumes both signals (`mailbox-delivery.ts`)

**Counter → token (residual 1):**

```ts
function ringToken(session, profile) {
  return `${session.bytesWritten}:${session.inputBytes}:${session.info.cols}x${session.info.rows}:${profile.app}`;
}
```

One line, and it propagates everywhere the token is already trusted, for free:

- the pre-classify sample (`:606`) vs. the pre-lock re-check (`:653`) — a keystroke during the
  async classify now holds even un-echoed;
- the in-lock precheck (`:703`) — a keystroke while we waited on the terminal lock now holds;
- the `CachedVerdict` memo (`:536`) — a CLEAN verdict can no longer be reused across a keystroke,
  which retires the caveat at `:735-737` verbatim.

`inputBytes` is monotone and never reset, so the token stays monotone and the aliasing arguments
documented for `CachedVerdict` continue to hold unchanged. Composing it as a second field rather
than adding into `bytesWritten` is deliberate: `bytesWritten` is the ring's counter and the mirror
flush loop compares it in lockstep (`pty-session.ts:780-786`); polluting it with input would break
that protocol.

**Clock → settle (residual 2):**

```ts
export const INPUT_SETTLE_BEFORE_WRITE_MS = 300;
function inputSettled(ports, session) {
  return ports.now() - session.lastInputAt >= INPUT_SETTLE_BEFORE_WRITE_MS;
}
```

Checked at both places `settled()` is checked today — the pre-lock check (`:659`) and the in-lock
`precheck` (`:705`) — holding `'busy'` exactly as the output settle does. Phrased as a positive
`>=` for the same NaN reason the existing `settled()` documents.

**300 ms**, one notch above the output settle's 250 ms, because the input round trip is strictly
longer than the output one it must cover: browser → WS → Tower → shellper → PTY → app render →
`onPtyData`. `_lastInputAt` initialises to `0`, so a session that has never received input is
settled from birth — no cold-start latency. I will confirm the number against a live terminal at
the dev-approval gate rather than only asserting it (see Test Plan).

### 4. During the paced write (`message-write.ts`)

Steps 1–3 close everything up to the first byte. Between the first byte and the Enter there is
still a 80 ms–seconds window (long bodies pace at 10 ms/line), and the issue asks for it
explicitly. Bytes are already out by then, so this is a **reporting** problem, not a gate problem.

Mirror the existing `watchBypasses` shape exactly: sample `session.inputBytes` before the write,
compare after, and surface it on the result:

```ts
| { status: 'written'; racedByInput?: boolean }
```

`deliverAgentMail` treats `racedByInput` as an unverified delivery: it stays past the point of no
return (`markDelivered` first), then joins the existing `markEscalatedDelivered` +
`onUnverifiedDelivery` + WARN path that `verified === false` already uses.

**Flag, not hold — and that is the opposite call from `preempted`, on purpose.** `preempted`
holds because an operator `^C`/ESC may have *cleared or truncated* the composer, so the message
plausibly never landed. A human keystroke removes nothing: our bytes are on the line, the header
echo will match, and the message will arrive (with stray characters). Holding would therefore mean
re-writing a message that did land, which is precisely the `#1584` re-injection failure — a
guaranteed duplicate charged for a race that cost a few stray characters.

### 5. Comments that currently document the hole

Three comment blocks assert this residual is open and name #1473; all must be updated in the same
change or the codebase will contradict itself: `mailbox-delivery.ts:696-700`,
`mailbox-delivery.ts:735-737` (the "PTY INPUT does not advance the ring" clause), and
`session-submit.ts:121-127`.

## Files to Change

- `packages/codev/src/terminal/pty-session.ts:628-640` — `WriteOrigin` param on `write()`;
  `_inputBytes` + `_lastInputAt` bumped on the `'external'` branch
- `packages/codev/src/terminal/pty-session.ts:930-971` — `get inputBytes()`; re-doc
  `recordUserInput`/`lastInputAt` as the gate's input signal
- `packages/codev/src/terminal/pty-session.ts:949-957` — `handleUserInput` no longer needs its own
  timestamp bump (it goes through `write()`); keeps composing/submit-signal behaviour
- `packages/codev/src/agent-farm/servers/message-write.ts:11-30` — `WritableSession.write` gains
  the optional origin; `:55-110` thread it; `:162-218` `submitMessagePaced` passes `'delivery'`
  and adds the input-race watch
- `packages/codev/src/agent-farm/servers/message-write.ts:120-134` — `racedByInput` on `written`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:60-105` — `DeliverySession` gains
  `inputBytes` + `lastInputAt`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:520-522` — `ringToken` folds in
  `inputBytes`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:415-450` — `INPUT_SETTLE_BEFORE_WRITE_MS`
  + `inputSettled()` beside the existing settle
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:653-710` — both check points; the
  updated residual comments
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:830-860` — fold `racedByInput` into
  the delivered-unverified reporting
- `packages/codev/src/agent-farm/servers/tower-routes.ts:960` — verify the raw passthrough now
  counts (it calls `session.write(body.data)`, so it is covered by the default; assert with a test
  rather than by inspection)
- `packages/codev/src/agent-farm/__tests__/spec-1473-gate-input-race.test.ts` — new
- Test fakes gaining the two fields: `spec-1470-reentry-delivery`, `send-architect-identity`,
  `cron-delivery`, `bugfix-1584-no-rewrite-after-write`, `send-mailbox-repro`,
  `bugfix-1573-delivery-verification`, `spec-1365-serializer-convergence`, `spec-1307-send-delay`,
  `send-delivery`
- `codev/reviews/1473-render-gate-fuller-close-of-th.md` — new, at the review phase
- `codev/state/pir-1473_thread.md` — builder thread

No `codev-skeleton/` mirror: this is product source under `packages/`, not framework template
content.

## Risks & Alternatives Considered

**Risk — delivery latency to an actively-typing human.** A mailbox message now holds while a human
has typed within the last 300 ms. This is the cost the architect asked me to weigh, and I judge it
small and correctly-directed: the interval only bites when a human owns the composer, which is the
case where a hold is the right answer anyway; the backstop retries at 1.5 s; and the `'submit'`
fast trigger (`scheduleDrain`, `:1222`) is largely unaffected because on Enter the *output* settle
already holds it (the agent begins repainting immediately) — the delivery in practice lands on the
later `'quiescence'` trigger, by which time `lastInputAt` is long stale. **Mitigation deferred, not
missing:** if measurement at the dev-approval gate shows real added latency, a one-shot re-drain
armed at the settle's remaining ms is a small follow-up. I would rather measure than build it
speculatively.

**Risk — the delivery self-trips its own signal.** The precise failure the architect flagged.
Mitigated structurally by the explicit `'delivery'` origin, and by a test that runs a full
multi-line paced delivery and asserts `inputBytes` is unchanged across it (a regression here would
otherwise present as "mail never delivers", which is a nasty bug to trace).

**Risk — a new input path forgets to count.** Mitigated by the default: an author must
*deliberately* pass `'delivery'` to become invisible. This inverts today's failure direction.

**Risk — test-fake churn.** Nine test files construct `DeliverySession` doubles. Making the fields
optional would avoid the churn, but `undefined` timestamps would make every fake hold (NaN) and
break the same tests anyway, while leaving production able to compile a fake-shaped port that
silently reads "no input". Required fields, updated fakes.

**Residual left open deliberately — input via a directly-attached shellper client.** A second
client attached to the same shellper writes to the PTY without passing through this `PtySession`,
so its keystrokes remain unobservable here. That is a different boundary (the shellper frame relay,
already listed as uncovered in `session-submit.ts:56-58`) and out of scope; I will document it in
the review rather than silently imply full coverage.

**Alternative — make `bytesWritten` count input too.** One counter, no interface change. Rejected:
it is the ring's output counter and the mirror flush loop (`pty-session.ts:780-786`) compares it in
lockstep to decide whether a render is torn. Input bumping it would make that loop spin.

**Alternative — settle only, no counter.** Simpler. Rejected: it cannot cover a keystroke landing
*after* the sample, which is residual 1 and the one the issue names first.

**Alternative — counter only, no settle.** Rejected: it cannot cover a keystroke that landed
before the sample and has not echoed, which is residual 2. Both samples agree, correctly, and the
screen is genuinely blank.

**Alternative — hold and redeliver on a during-write input race.** Rejected: guaranteed duplicates
for a race that does not remove our bytes. See §4.

## Test Plan

Unit (`vitest`, `packages/codev`):

- `PtySession.write(data)` bumps `inputBytes` by `data.length` and moves `lastInputAt`;
  `write(data, 'delivery')` moves neither. `handleUserInput` bumps (and still emits `'submit'` on
  Enter); the raw `/api/terminals/:id/write` route bumps.
- **Residual 1:** a delivery whose `classify` port resolves asynchronously, with the fake session's
  `inputBytes` incremented *during* the await → outcome is held `'busy'`, `writeMessage` never
  called. Same assertion with the increment landing inside the in-lock `precheck` window.
- **Residual 2:** a fake session with `lastInputAt = now − 100` and a fully clean, output-settled
  screen → held `'busy'`; at `now − 400` → delivered. Boundary at exactly 300 ms.
- **Self-trip:** a real `submitMessagePaced` against a fake session over a 5-line body → `written`,
  and the session's `inputBytes` is unchanged across the whole paced write.
- **During-write race:** bump `inputBytes` between the text write and the Enter → result carries
  `racedByInput`, the row is still `delivered` (never re-written — the #1584 invariant), and
  `onUnverifiedDelivery` fires.
- Full existing suite green — especially `bugfix-1584-no-rewrite-after-write`,
  `spec-1365-serializer-convergence`, `bugfix-1573-delivery-verification`, `render-gate`.

Manual, against a running Tower at the dev-approval gate (this is why the issue is PIR — "verified
against a running terminal, not only unit tests"):

1. `afx send` to a builder while typing into that builder's composer → the message holds, the draft
   is untouched, `afx inbox` shows `busy`. Repeat ~10× at different points in the keystroke stream.
2. Stop typing → the message delivers on the next backstop tick (≤ ~1.8 s).
3. Idle terminal → `afx send` still delivers promptly; measure the delta against `main` to confirm
   no latency regression on the common path.
4. The 300 ms figure: log the observed gap between a keystroke and its echo appearing in the ring
   across claude and codex harnesses, local and shellper-backed, and adjust the constant if the
   measurement disagrees with the estimate.
5. `--interrupt` / `--escape` mid-delivery still behave as #1365 defines (`preempted` → hold), i.e.
   the new input counting has not perturbed the operator bypasses.

Cross-platform: n/a (server-side Node; no UI surface changes).
