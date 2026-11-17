# PIR Plan: Give the render gate an observation of PTY input

Issue: [#1473](https://github.com/cluesmith/codev/issues/1473) — "Render gate: fuller close of
the gate→write input race (R7 staleness) and input-echo-lag residual"

**Revision 3** — addresses the 3-way CMAP + architect adjudication in
[comment 5545685246](https://github.com/cluesmith/codev/issues/1473#issuecomment-5545685246)
(gemini APPROVE, claude 3 blockers, codex 4; gemini's approve discounted, and I agree it should be —
it asserts the self-trip is closed, which §1 below disproves).

The design shape is unchanged and endorsed by all three reviewers: `'external'` default, hard-coded
`'delivery'` wrapper, counter + clock, flag-not-hold, and the `lastInputAt > lastDataAt` rejection.
Revision 3 fixes six blocking items, answers two decide-items, and **reverses two of my own
positions** (mouse stripping; deferring the re-drain).

**I verified every item against source before accepting it**, including enumerating the pinned
xterm bundle myself rather than relaying the review's table. That turned up **one hazard nobody
raised** — see §1's case-sensitivity note, which would have eaten every arrow key.

## Understanding

### What is actually left open

**The output side is closed.** `ringToken()` (`mailbox-delivery.ts:520`) is sampled at `:606`,
re-checked pre-lock at `:653` and again inside the per-terminal lock at `:703` (#1365).
`SETTLE_BEFORE_WRITE_MS = 250` + `settled()` gate on output quiescence (#1573); `watchEcho`/
`verify()` confirm the write's echo (#1573, #1584). The issue's "consider a post-write echo settle"
**already landed as #1573** and must not be redone.

**The input side has no observation at all:**

- `ringToken` = `` `${session.bytesWritten}:${cols}x${rows}:${app}` `` (`:521`); `bytesWritten` is
  the ring's **output** counter (`pty-session.ts:930-931`).
- `settled()` keys on `lastDataAt`, assigned only in `onPtyData` (`pty-session.ts:514-516`) — again
  **output**.
- `PtySession.write()` (`:628-640`), the single funnel for user input, records **nothing**.

Three comment blocks say so and name this issue as owner: `mailbox-delivery.ts:696-700`, `:735-737`,
`session-submit.ts:121-127`.

### The two residuals

1. **R1 — gate→write input race (R7 staleness).** A keystroke lands *after* `tokenBefore` is
   sampled. Both re-checks compare an output counter it did not move, so until the TUI echoes it the
   guard reads "unchanged" and we write onto a line the human has started typing on. Our Enter then
   submits their half-typed draft as the agent's message.
2. **R2 — input-echo lag.** A keystroke lands *before* the sample and is not yet echoed. No counter
   comparison can catch it — both samples agree, correctly — and the classifier reads a genuinely
   empty composer. This needs a *clock*.

### Why `lastInputAt` cannot simply be consumed

`handleUserInput()` (`pty-session.ts:949-957`) already records `_lastInputAt`, but `Terminal.tsx:639`
forwards **everything** xterm emits on `onData` to it, and xterm emits terminal **replies** through
that same event. The client strips only DA/CPR/DECRPM (`Terminal.tsx:655-661`) and **only while
`rc.initialPhase` is true** — set on connect (`:421`, `:462`), cleared by `flushInitialBuffer`
(`:469`) on a short timer. For a session's entire steady-state life the filter is **off**.

Consuming the timestamp raw would produce false holds with no human present, a self-trip route the
`'delivery'` origin cannot close (our write → repaint → app query → browser reply → counted as
input), and **starvation**: `busy` is excluded from `isClassifierStuck` (`:400-405`), so a chatty
attached client would silently never deliver. A server-side reply filter is therefore a
**precondition** of the design, not a refinement.

## Proposed Change

### 1. Server-side terminal-reply filter — `terminal-replies.ts` (new)

```ts
export function stripTerminalReplies(data: string): string
```

**I enumerated every CSI/OSC/DCS emission site in the pinned bundle myself**
(`node_modules/.pnpm/@xterm+xterm@5.5.0/…/lib/xterm.js`). What it can emit:

| Emission | Literal in the bundle | Treatment |
|---|---|---|
| DA1 | `ESC[?1;2c`, `ESC[?6c` | strip |
| DA2 | `ESC[>0;276;0c`, `ESC[>83;40003;0c`, `ESC[>85;95;0c` | strip |
| DSR | `ESC[0n` | strip — **was missing** |
| XTWINOPS | `ESC[4;h;w t`, `ESC[6;h;w t`, `ESC[8;rows;cols t` | strip — **was missing** |
| CPR | `ESC[<row>;<col>R` | strip |
| DECXCPR | `ESC[?<row>;<col>R` — **two** params | strip — **my pattern required three** |
| DECRPM | `ESC[<?>…$y` | strip |
| OSC colour | `ESC]<n>;rgb:…` + **ST** | strip |
| Mouse SGR / X10 | `ESC[<b;col;rowM\|m`, `ESC[M` + 3 bytes | **COUNT — do not strip** (§1b) |
| Focus | `ESC[I`, `ESC[O` | strip (see below) |

The three gaps are exactly the output-provoked class, so **revision 2's "self-trip completely
closed" was false**. Corrected.

**The rule.** Taking claude's final-byte rule for the CSI family, since no key sequence xterm can
produce ends in `c`, `n`, `t` or `y` — I confirmed this against the bundle's full key table (finals
are `~ A B C D F H I O Z`, plus `R` and `M`/`m`):

```ts
/\x1b\[[?>=]?[0-9;]*\$?[cnty]/g      // DA / DSR / XTWINOPS / DECRPM, incl. forms nobody enumerated
/\x1b\[\??[0-9]+;[0-9]+R/g           // CPR + DECXCPR (correct arity)
/\x1b\[\?[0-9;]*u/g                  // kitty-keyboard reply, if the VS Code fork ever answers one
/\x1b\[[IO]/g                        // focus in / out
/\x1bP[0-9]\$r[^\x1b]*\x1b\\/g       // DECRQSS
/\x1bP>\|[^\x1b]*\x1b\\/g            // XTVERSION — dead weight for stock xterm; kept for the fork
/\x1b\][0-9;]+;rgb:[0-9a-fA-F\/]+(?:\x07|\x1b\\)/g   // OSC colour, BEL or ST
```

**HAZARD NOBODY RAISED — the character class must be case-sensitive.** `ESC[C` is Right-arrow and
`ESC[1;5C` is Ctrl-Right. An `i` flag on `[cnty]` would strip **every arrow key, `F`/`H` home/end,
and shift-Tab** from the gate signal — silently re-opening R1 for ordinary keyboard navigation,
which is the exact corruption this issue exists to close. The regexes carry `g` only, never `i`, and
a test asserts `ESC[C`, `ESC[1;5C`, `ESC[A`–`ESC[D`, `ESC[F`, `ESC[H`, `ESC[Z` and `ESC[15~` all
**survive**.

The `?` in the kitty pattern is what keeps it off real kitty-encoded keystrokes; the module doc
states the table is derived from a **pinned** dependency, so a version bump is a review trigger.

**Where it applies.** Inside `write()`'s `'external'` branch — see §2 — so the raw
`POST /api/terminals/:id/write` route gets it for free. Signal-only: the full chunk still reaches
the PTY verbatim, because the application asked for the reply. (Blocking a DA reply would hang
every attached terminal; a test pins it.)

**Failure directions.** Over-strip → an uncounted keystroke, i.e. *exactly today's behaviour*, never
a regression. Under-strip → a spurious hold — but see the decide-item in §8, which is why that is no
longer simply "the backstop clears it".

**Bracketed paste is not stripped**, and the filter is content-blind: a reply-shaped sequence
*inside* a paste would be stripped from the signal while the surrounding pasted text still counts.
Intended, pinned by a test, and in the over-strip (safe) direction.

**Focus reports are stripped, deliberately, and this is consistent with §1b.** A focus report cannot
alter composer *content*; a click that could carries its own mouse report, which is preserved. So
stripping focus costs no R1 coverage while stopping an alt-tab from holding delivery.

**`composing` is left alone** (all three reviewers agreed). Replies already spuriously call
`startComposing()`, but `stopComposing` drives the `'submit'` trigger and I will not perturb a
delivery trigger inside a delivery-safety issue. `get composing()` (`:988`) has no production
consumer, so the cost of leaving it is nil. Follow-up in the review.

### 1b. Mouse reports COUNT as input — reversing revision 2

I checked the bundle rather than taking either reviewer's word, because claude and codex directly
contradicted each other. **Codex is right.** The mouse encoders build their string from a DOM-derived
event object (`{col,row,button,action}`) and hand it to the generic `triggerDataEvent` path — they
are not a parser reply callback. A mouse report is a **human action that can change the composer**:
a click moves the cursor, a middle-click pastes, a drag selects. Stripping it re-opens R1 for
mouse-driven TUIs — the corruption direction this issue exists to close.

Revision 2's mouse row is **removed**. Claude's opposite suggestion (also filter the urxvt 1015 form)
would have widened the hole. The flooding concern is real but correctly bounded: motion tracking
holds delivery only while the mouse is actually moving, and clears 300 ms after it stops — the
fail-safe direction.

### 2. `PtySession` observes input — two origins, filter inside `write()` (CMAP item D)

```ts
export type WriteOrigin =
  /** Default — an unknown/foreign writer. Counts as input. */
  | 'external'
  /** The gated delivery's own paced write. Must never trip the gate's input signal. */
  | 'delivery';

write(data: string, origin: WriteOrigin = 'external'): boolean {
  if (origin === 'external') {
    const human = stripTerminalReplies(data);
    if (human) this.recordUserInput(human);
  }
  …existing write…
}
```

**`'pre-recorded'` is deleted.** Both blocking reviewers were right and gemini's defence missed the
point: nothing couples that value to an actual recording, so a future caller passing it while
recording nothing is invisible input — the precise failure `'external'` exists to prevent, and the
same "compiles fine, mail never delivers" shape as the 1-arg/2-arg hazard. Moving the filter inside
`write()` collapses three origins to two, gets the raw route covered for free, keeps `composing` on
raw data per §1, and leaves the delivery path untouched. `write()` is synchronous with no await, so
record-then-write is atomic with respect to the event loop.

`handleUserInput` therefore reduces to its composing/submit logic plus a plain `this.write(data)`.

**Naming.** `.length` is UTF-16 code units, so `inputBytes` would lie. The field is **`inputSeq`**,
documented as *a monotone change counter — it exists to differ, not to total*, advancing by
`data.length`.

**Return-path semantics.** The bump happens on the `'external'` branch **regardless of the write's
return value**. The question is "did a foreign writer put input at this session?", not "did it
land". A dropped write cannot mask itself as `busy` instead of `no-live-pty`, because `precheck`
tests `session.writable` *before* the token (`:702` before `:703`).

**Monotonicity, precisely.** The *token* is not globally monotone (geometry and app can change back
and forth); the *counters* are, and that plus the session-object-identity guard preserves
`CachedVerdict`'s non-aliasing argument (`:536`). `_inputSeq` must **never reset** — including across
a spawn relaunch and `attachShellper` (`:263-267`), which replace the PTY while keeping the
`PtySession` object. Note `attachShellper` *does* hydrate `_lastDataAt` from the shellper's tracker;
`_inputSeq`/`_lastInputAt` get no such hydration and must be left untouched. A test pins this.

**Injectable clock.** `recordUserInput` uses `Date.now()` while the gate uses `ports.now()`, which is
the general rule behind the `send-architect-identity` breakage (see Files). `PtySessionConfig` gains
an optional `clock?: () => number` (default `Date.now`) used by `recordUserInput`, so a test can pair
a fake clock with a real `PtySession`. Existing tests survive today only because `attachShellper`
hydrates `_lastDataAt`; `_lastInputAt` has no such seam, and this adds one.

### 3. The delivery's write opts out — and the types split (CMAP item F)

Revision 2 was **uncompilable**: it showed `const tracked: WritableSession = { write: … }` with no
`inputSeq` while making `inputSeq` required on `WritableSession`. `message-write.ts` is inside
`packages/codev/tsconfig.json`, so that is a build break. Split the types:

- `WritableSession` — unchanged, one-arg `write`. All `writeEscapeToSession` /
  `writeMessageToSession` need, and it spares fake churn in helpers that never needed the field.
- The paced-delivery seam: `submitMessagePaced(session: WritableSession & { id: string; readonly inputSeq: number }, …)`.
- The inner `tracked` adapter stays the minimal write-only `WritableSession` shape.

The origin is **hard-coded in the wrapper**, per codex's construction:

```ts
const tracked: WritableSession = {
  write: (data: string): boolean => {
    const ok = session.write(data, 'delivery');
    if (!ok) delivered = false;
    return ok;
  },
};
```

A 1-arg function **is** assignable to a 2-arg function type, so TypeScript would not catch a wrapper
that forgot to forward an origin parameter, and the failure mode is "mail never delivers".
Hard-coding removes the opportunity. **Verified safe:** `submitMessagePaced` has exactly one
production caller (`mailbox-wiring.ts:301`, the delivery `writeMessage` port); the operator bypasses
use `writeEscapeToSession`/`writeMessageToSession` under `submitToSession` (`tower-routes.ts:2113`,
`:2197`) and the delayed `^C` calls `live.write('\x03')` raw (`:1834`) — all keep `'external'` and
correctly count.

### 4. The gate consumes both signals (`mailbox-delivery.ts`)

`DeliverySession` (`:60-105`) gains `readonly inputSeq: number` and `readonly lastInputAt: number`.

**Counter → token (R1):**

```ts
`${session.bytesWritten}:${session.inputSeq}:${session.info.cols}x${session.info.rows}:${profile.app}`
```

**Why the counter earns its place — corrected (CMAP item E).** Revision 2 argued a delivery "can sit on the
per-terminal lock for up to 2 s". **That is false, and I verified it:** `submitMessagePaced` →
`trySubmitToSession` returns `false` immediately when `isSubmissionInFlight`
(`session-submit.ts:479`) — deliveries **decline**, they never wait. `OPERATOR_SUBMIT_WAIT_CEILING_MS`
is what an *operator* waits under while a *delivery* holds the line, the opposite direction. Revision
2 quoted that asymmetry itself and then argued from the wrong side. This matters because these cases
become a code comment, and a false justification there is worse than none. The real two:

- **Verdict-memo invalidation** — correct and *sufficient alone*. A `CachedVerdict` survives across
  backstop ticks, so the gap between the cached classify and its reuse is bounded by no settle.
  Without `inputSeq` in the token a CLEAN verdict can be reused across a keystroke — the caveat the
  code admits at `:735-737`, retired verbatim.
- **Unbounded awaits inside the gap.** `tokenBefore` (`:606`) → `precheck` contains
  `await ports.classify` (`:626`) **and** `await ports.watchEcho` (`:715`), the latter flushing and
  scanning up to 1000 mirror lines. Neither is bounded by 300 ms on a loaded box.

**Clock → settle (R2):**

```ts
export const INPUT_SETTLE_BEFORE_WRITE_MS = 300;
function inputSettled(ports, session): boolean {
  return ports.now() - session.lastInputAt >= INPUT_SETTLE_BEFORE_WRITE_MS;
}
```

Checked at both places `settled()` is — pre-lock (`:659`) and in-lock `precheck` (`:704`) — phrased
as a positive `>=` for the same NaN reason `settled()` documents. 300 ms is one notch above the
output settle's 250 ms because the input round trip is strictly longer than the output one it
covers. `_lastInputAt` initialises to `0`, so a session that never received input is settled from
birth.

**This BOUNDS R2; it does not close it.** Surviving by construction: input older than 300 ms whose
echo is still delayed, and input in flight from the browser at sample time. Named in the plan, the
code comments and the review, with the rollback criterion in the Test Plan.

### 5. During the paced write

Sections 1–4 cover everything up to the first byte. Between the first byte and the Enter there is
still an 80 ms-to-seconds window. Bytes are out by then, so this is a **reporting** problem: sample
`inputSeq` before the write, compare after, surface `| { status: 'written'; racedByInput?: boolean }`.

**`racedByInput` is omitted when false**, so the exact `{status:'written'}` assertions in
`spec-1365-serializer-convergence.test.ts` keep passing.

**Flag, not hold.** `preempted` holds because an operator `^C`/ESC may have *cleared* the composer.
Re-writing a message that landed is the #1584 re-injection failure, and there is no attempt cap in
the module. But the wording must be honest: a human **Enter** mid-write submits our partial body and
`^U`/`^W`/`^C` truncate it, so the WARN says **"may have been truncated or submitted early"**.

### 6. Report it to every operator surface, including the sender (CMAP item C)

Revision 2 threaded `cause` into `UnverifiedDeliveryInfo` and stopped — leaving the **primary**
surface wrong. I verified: `tower-routes.ts:2288-2289` surfaces only `outcome.verified`, and
`commands/send.ts:462` prints its warning **only** on `verified === false`. So in the exact case §5
exists for — Enter truncation, where the needle is the first line, it landed, `verified === true` —
the row is escalated and the dashboard notified while the human who ran the send is told plain
"Message delivered". Same for `racedByInput` with no needle, where `verified` is absent entirely.

- **`unverifiedCause?: 'no-echo' | 'input-raced'`** on `DeliveryOutcome`, threaded through
  `/api/send` → the send response type → `commands/send.ts`. **Not** overloaded onto `verified`,
  which would mean two different things at one call site.
- **Precedence: `'input-raced'` wins** when both are true — it is the more actionable remedy.
- The escalation decision moves outside `if (echo)`:
  `const unverified = result.racedByInput === true || verified === false;` — escalating exactly once.
- The WARN at `:840-841` interpolates `needle.length`, which now runs with `needle === ''` and would
  print "needle 0 chars". **Branch the text, don't append to it.**
- `UnverifiedDeliveryInfo` (`:323`) gains the same `cause`, threaded into
  `surfaceUnverifiedDelivery` (`mailbox-wiring.ts:524-535`), whose body currently hard-codes "its
  header never appeared on that screen".

### 7. Decide — the one-shot re-drain: **BUILD IT NOW** (reversing revision 2)

Revision 2 deferred this to measurement. Claude is right that there is nothing left to measure:
`stopComposing` emits `'submit'` synchronously right after `recordUserInput`, and
`mailbox-wiring.ts:600` wires `'submit'` to `scheduleDrain`, which runs in a **microtask** — so
`lastInputAt === now` at that pass, **always**, analytically. "Measure first" is the right instinct
against a speculative optimisation; it is the wrong instinct against a proven certainty.

And one timer is simultaneously the mitigation for **three** things: the submit-trigger hold, the
navigation-key case (a key provoking no output otherwise costs a full 1.5 s backstop period), and
the escalation-blind residual in §8 — because a hold that re-arms itself shrinks the starvation
window from "forever" to "one settle".

**Design, keeping the pure module pure:** `DeliveryOutcome` gains `retryAfterMs?: number`, set only
when a pass held *solely* on `inputSettled`. The drainer (which already owns timers and the
generation guard) arms a coalesced per-agent `setTimeout` for that delay + a small margin, then
calls `scheduleDrain`. Cleared in `stop()` alongside the existing timers, and generation-guarded
exactly like `scheduleDrain` (`:1234`).

### 8. Decide — the escalation-blind input hold: **a gate detail AND a counter**

The residual none of us had named, and it is real: an input-caused hold calls `hold('busy')`, which
**nulls `detail`** (`:591-596`), and plain `busy` is excluded from `isClassifierStuck` (`:400-405`).
So #1482's whole diagnostic axis is lost for this new hold class and nothing escalates it. Revision
2's "a spurious hold the backstop clears" was too optimistic: a missed reply **recurring under
300 ms** (an app polling geometry every repaint) holds indefinitely, and the only net —
`escalateHeldToOwner` at ~180 s — is skipped for architects, so a starved architect is entirely
silent.

Both halves, because they answer different questions:

- **A gate detail `'recent-input'`** added to `MailboxGateDetail` (`db/types.ts:115`), carried by a
  `hold(reason, detail)` variant rather than the detail-nulling `hold`. `afx inbox` and the send
  response then say `busy:recent-input` — "waiting on recent terminal input" — through the existing
  shared `formatVerdict`, no formatter change needed.
- **It must NOT join `isUnverifiableVerdict`** (`sdk/hold-verdict.ts:47-52`). It sits beside
  `user-text`: a human at the line is a hold that clears on its own, and escalating it would
  false-alarm on every ordinary typist (Constraint 1). Adding the value is therefore automatically
  correct there — the predicate is an allow-list.
- **A consecutive-input-hold counter** on the drainer, WARN-logged at a threshold (~60 consecutive
  holds ≈ 90 s). A human types in bursts; 90 s of unbroken sub-300 ms input is a machine, not a
  person. This is a diagnostic, not an escalation — it leaves a trace for the starved-architect case
  without wiring a false-alarm path.

Note §7's re-drain also attacks this from the other side: it shortens each cycle, so the counter
crosses its threshold sooner and the evidence arrives faster.

### 9. Comments that currently document the hole

`mailbox-delivery.ts:696-700`, `:735-737`, `session-submit.ts:121-127` all assert this residual is
open and name #1473. Each must state the **surviving** residuals from §4, §5 and the list below —
never claim closure.

## Files to Change

**Phase 1 — input observation + reply filter**

- `packages/codev/src/terminal/terminal-replies.ts` — new; `stripTerminalReplies`, pinned-dependency
  doc note
- `packages/codev/src/terminal/pty-session.ts:628-640` — `WriteOrigin`; filter + bump inside the
  `'external'` branch
- `packages/codev/src/terminal/pty-session.ts:930-971` — `get inputSeq()`; `recordUserInput(chunk?)`;
  re-doc `lastInputAt` as the gate's input signal
- `packages/codev/src/terminal/pty-session.ts:949-957` — `handleUserInput` reduces to
  composing/submit + `this.write(data)`
- `packages/codev/src/terminal/pty-session.ts:42-60` — `PtySessionConfig.clock?: () => number`
- `packages/codev/src/terminal/pty-session.ts:263-267` — `attachShellper` must not touch `_inputSeq`
  / `_lastInputAt`
- new: `packages/codev/src/terminal/__tests__/terminal-replies.test.ts`

**Phase 2 — gate consumption**

- `packages/codev/src/agent-farm/servers/message-write.ts:11-20,162-168` — type split (§3)
- `packages/codev/src/agent-farm/servers/message-write.ts:189-195` — `tracked` hard-codes `'delivery'`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:60-105` — `DeliverySession` fields
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:520-522` — `ringToken` folds `inputSeq`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:415-450` —
  `INPUT_SETTLE_BEFORE_WRITE_MS` + `inputSettled()`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:588-596` — `hold(reason, detail)` variant
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:653-710` — both check points
- `packages/codev/src/agent-farm/db/types.ts:115` — `'recent-input'` on `MailboxGateDetail`

**Phase 3 — during-write watch + full reporting chain**

- `packages/codev/src/agent-farm/servers/message-write.ts:120-134,180-218` — `racedByInput`
  (omitted when false)
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:323-329` — `cause` on
  `UnverifiedDeliveryInfo`
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:815-860` — `unverified` outside
  `if (echo)`; branched WARN text; `unverifiedCause` on `DeliveryOutcome`
- `packages/codev/src/agent-farm/servers/tower-routes.ts:2288-2289` — surface `unverifiedCause`
- `packages/codev/src/agent-farm/commands/send.ts:462` — cause-aware sender warning
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:524-535` — cause-aware notification text
- SDK/type surface for the `/api/send` response (whichever declares `verified`)

**Phase 4 — re-drain + starvation diagnostics**

- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` — `retryAfterMs` on `DeliveryOutcome`;
  drainer timer (coalesced, generation-guarded, cleared in `stop()`); consecutive-input-hold counter
  + WARN

**Phase 5 — comments, review, thread** (§9, plus `codev/reviews/1473-…md`,
`codev/state/pir-1473_thread.md`)

**Test doubles to migrate — not all one class:**

- `spec-1313-paced-write-drop.test.ts:33-45` — breaks at **compile** time (annotated
  `WritableSession & {id}` literal). The §3 type split may make this a no-op; verify rather than
  assume.
- `tower-routes.test.ts:226` `gateSession` — **runtime**. Structural, reaches the live wiring
  binding; missing `lastInputAt` → `now() − undefined` → NaN → `inputSettled()` false → **every send
  test in this file holds instead of delivering**. This description fits *this file alone*.
- `tower-websocket.test.ts:61` `makeSession` — **runtime**, but it exercises WS delegation only and
  does **not** reach the live mailbox binding. Correction to revision 2, which lumped it in.
- `send-architect-identity.test.ts:108` — calls `s.write(msg)` on a **real** session to simulate a
  delivery; under the new default that becomes external input. **The general rule:**
  `recordUserInput()` uses `Date.now()` while the gate uses `ports.now()`, so *any* test pairing a
  fake clock with a real `PtySession` breaks, and adding fields never fixes it. These survive today
  only because `attachShellper` hydrates `_lastDataAt`; `_lastInputAt` has no such seam — which is
  what §2's injectable clock adds. Fix: pass `'delivery'` (or use the real paced writer) **and**
  inject the clock.
- `send-integration.e2e.test.ts:244,570,597` — uses the raw route, unlisted in revision 2. It
  survives only because the redelivery wait is 12 s ≫ 300 ms. Make that **deliberate** with a
  comment, not lucky.
- `DeliverySession` fakes: `spec-1470-reentry-delivery`, `send-architect-identity`, `cron-delivery`,
  `bugfix-1584-no-rewrite-after-write`, `send-mailbox-repro`, `bugfix-1573-delivery-verification`,
  `spec-1365-serializer-convergence`, `spec-1307-send-delay`, `send-delivery`
- `typing-awareness.test.ts:63-161` — **must keep passing unchanged**; `recordUserInput()` stays a
  real assignment, never a no-op

No `codev-skeleton/` mirror: product source under `packages/`, not framework template content.
`Terminal.tsx` is **read but not modified** — the filter is deliberately server-side, because
`afx attach`, the VS Code webview and mobile clients do not share the client-side one.

## Risks & Alternatives Considered

### Latency

- **`QUIESCENCE_DEBOUNCE_MS = 500` (`pty-session.ts:40`) > 300**, so any quiescence-triggered pass is
  automatically input-settled whenever the last input preceded the last output byte — the normal
  case, since the TUI echoes. That is the main delivery trigger, and it is unaffected.
- **The `'submit'` trigger is now provably always held** (§7), which is why the re-drain is built
  rather than deferred.
- **A single navigation key with no output** would otherwise cost close to a full backstop period
  (1.5 s); the re-drain covers this too.
- **The delayed `^C`** (`tower-routes.ts:1834`) fires **UNATTENDED**, so revision 1's "a human is
  standing there" was wrong. It counts because it changes composer state. Consequence: the
  `scheduleDrain` nudge right after it now holds — and the re-drain is what recovers it.

### Other risks

- **Self-trip — two routes.** (a) Our own paced write: closed structurally by §3's hard-coded
  `'delivery'`, plus a test asserting `inputSeq` unchanged across a real multi-line paced write.
  (b) **Our write → repaint → query → browser reply → counted as input**: closed only by §1's filter,
  and only now that DSR/XTWINOPS/DECXCPR-arity are in it. A regression in either presents as "mail
  never delivers".
- **An over-broad filter eats real keys.** The case-sensitivity hazard in §1, plus anchored patterns
  only — never a blanket "starts with `ESC[`". Pinned by survival tests.
- **A new input path forgets to count** — inverted by the `'external'` default.
- **Test-fake churn** — optional fields would let production compile a port that silently reads "no
  input" while breaking the same tests via NaN. Required fields, migrated fakes.
- **A `MailboxGateDetail` value is a DB-typed union** (§8). Additive only; existing rows keep `null`,
  and `formatVerdict`/`isUnverifiableVerdict` are allow-list-shaped so the new value is correctly
  inert in the escalation path without editing either.

### Surviving residuals — stated in the plan, the code comments and the review

1. **R2 is bounded, not closed** (§4): input older than 300 ms whose echo is still delayed, and
   input in flight from the browser at sample time.
2. **During-write races are reported, not prevented** (§5). Bytes are already out.
3. **An `afx attach` client is wholly out of scope** — *its input and its terminal's replies alike*.
   It connects straight to the shellper socket (`commands/attach.ts:141-142`) and never touches
   `PtySession`, so nothing here observes it. (Corrected from revision 2, which implied only input
   was out of scope — and which is also why manual step 1 cannot be run against `afx attach`.)
4. **A reply the §1 table misses** counts as input → a hold. Now visible as `busy:recent-input` and
   counted (§8) rather than silent.

The issue is a **narrowing**. The code comments will say so.

### Alternative — `lastInputAt > lastDataAt` (evaluated; rejected, unchanged)

Constant-free and stronger on coverage, but it **deadlocks permanently**: an input that provokes no
output ever — a key the TUI ignores — leaves the condition true forever, the gate holds `busy`,
`busy` is excluded from `isClassifierStuck`, nothing escalates, and that agent's mail never
delivers. Trading a bounded 300 ms hold for an unbounded silent one is the wrong direction. The
reply filter removes the *reply*-driven deadlock, not the ignored-keystroke one. Recorded as the
next tightening in **bounded** form (hold while un-echoed, capped ~1 s, then fall back to the settle)
if measurement shows 300 ms is too loose. §8's detail + counter also makes such a deadlock *visible*,
which it would not have been before.

### Alternatives unchanged

- **Make `bytesWritten` count input too** — rejected: the mirror flush loop compares it in lockstep
  (`pty-session.ts:780-786`); input bumping it would make that loop spin.
- **Settle only, no counter** — rejected: memo invalidation and the unbounded awaits (§4).
- **Counter only, no settle** — rejected: cannot see input that landed before the sample.
- **Hold on a during-write race** — rejected: re-writes a message that landed (#1584).
- **Client-side filtering** (extending `Terminal.tsx`'s `initialPhase` filter to all phases) —
  rejected: three other clients don't share it, and a security/correctness signal must not depend on
  a cooperative client.

## Test Plan

### Unit (`vitest`, `packages/codev`)

**Reply filter** — the highest-value tests, since a mistake here is silent in both directions:

- Every literal the pinned bundle can emit is stripped: `ESC[?1;2c`, `ESC[?6c`, `ESC[>0;276;0c`,
  `ESC[>83;40003;0c`, `ESC[>85;95;0c`, `ESC[0n`, `ESC[4;24;80t`, `ESC[6;16;8t`, `ESC[8;24;80t`,
  `ESC[12;40R`, `ESC[?12;40R`, `ESC[?2004$y`, `ESC[2004$y`, OSC colour with **BEL** and with **ST**
  (separately), DECRQSS.
- **Survival (the case-sensitivity hazard):** `ESC[A`–`ESC[D`, `ESC[C`, `ESC[1;5C`, `ESC[1;3A`,
  `ESC[F`, `ESC[H`, `ESC[Z`, `ESC[15~`, `ESC[3~`, a bare `ESC`, Ctrl-chars, UTF-8 text.
- **Mouse survives and counts** (§1b): SGR `ESC[<0;10;5M` / `ESC[<0;10;5m`, and X10 `ESC[M` + 3 bytes.
- Mixed chunk `"a" + CPR + "b"` → `"ab"`. Reply-shaped bytes inside bracketed paste → documented
  behaviour, pinned.
- The doc-comment claim that the table is pinned-version-derived: a test naming the version.

**Signal plumbing:**

- `write(d)` bumps `inputSeq` by `d.length` and moves `lastInputAt`; `write(d, 'delivery')` moves
  neither. A dropped write (`false`) still bumps on the `'external'` branch.
- `handleUserInput(DA_REPLY)` → `inputSeq` **unchanged** *and* **the PTY received the reply
  verbatim**. This is the one way the change breaks every attached terminal (apps block waiting on
  their DA/DSR replies), so it is asserted explicitly.
- The raw `/api/terminals/:id/write` route bumps, and gets the filter (§2) for free.
- **The operator bypasses still count as `'external'`** — one assertion on `writeEscapeToSession`
  stops a future refactor tagging them `'delivery'`.
- `attachShellper` leaves `_inputSeq`/`_lastInputAt` untouched. `typing-awareness.test.ts` passes
  unchanged.

**Gate:**

- **R1:** `classify` resolving asynchronously with `inputSeq` incremented during the await → held
  `busy:recent-input`, `writeMessage` never called. Same for the in-lock `precheck` window. Plus the
  two cases the counter exists for (§4): an increment across a slow `watchEcho`, and a
  `CachedVerdict` that must not be reused across an increment.
- **R2:** clean, output-settled screen with `lastInputAt = now − 100` → held; `now − 400` →
  delivered; boundary at exactly 300 ms.
- **Self-trip:** a real `submitMessagePaced` over a 5-line body → `written`, `inputSeq` unchanged
  across the whole paced write.
- **Detail + counter (§8):** an input hold records `detail: 'recent-input'`;
  `isUnverifiableVerdict('busy','recent-input')` is **false**; the consecutive counter WARNs at its
  threshold and resets on a delivery.
- **Re-drain (§7):** a pass held solely on `inputSettled` returns `retryAfterMs`; the drainer arms
  exactly one coalesced timer; `stop()` clears it; a stale generation does not fire.

**Reporting, all four quadrants (§5–6):** `racedByInput` with (a) `verified === true`, (b) **no echo
needle at all**, (c) `verified === false` → escalates **exactly once** with `cause: 'input-raced'`
winning precedence in (c); and (d) no race, `verified === true` → no escalation. In every case the
row stays `delivered` and is never re-written (#1584). Plus: the sender's `/api/send` response
carries `unverifiedCause` and `commands/send.ts` prints the right warning in each; the WARN text
does not say "needle 0 chars"; `{status:'written'}` exact-match assertions still pass.

**Full existing suite green** — especially `tower-routes`, `tower-websocket`,
`spec-1313-paced-write-drop`, `send-integration.e2e`, `bugfix-1584-no-rewrite-after-write`,
`spec-1365-serializer-convergence`, `bugfix-1573-delivery-verification`, `render-gate`,
`typing-awareness`, `hold-verdict`.

### Manual, against a running Tower at the dev-approval gate

This is why the issue is PIR — verified against a running terminal, not only unit tests.

1. **Reply-traffic measurement (§1's direct evidence), run FIRST.** Browser attached, hands **off**
   the keyboard, agent running: log every `handleUserInput` chunk for 60 s plus what the filter
   strips vs. keeps. Expected: zero surviving residue. If replies still get through, nothing
   downstream is trustworthy. **Repeat on the VS Code integrated terminal** — a different xterm
   build, and the one surface whose reply set may differ. **Not `afx attach`**: it bypasses
   `PtySession` entirely (residual 3), so logging there shows zero chunks and would read as a false
   pass.
2. **The 300 ms calibration.** Log the keystroke→echo gap across claude and codex, local and
   shellper-backed. **Rollback criterion:** if p99 > 300 ms, raise the constant to p99 + margin; if
   that would need to exceed ~500 ms, adopt the bounded `lastInputAt > lastDataAt` refinement
   instead of a larger constant, and re-open the plan.
3. **Mouse (§1b).** Click into a builder's composer mid-`afx send` → the message holds. This is the
   assertion that would have failed under revision 2.
4. `afx send` while typing into the target's composer → holds, draft untouched, `afx inbox` shows
   **`busy:recent-input`**. ~10× at different points in the keystroke stream.
5. Stop typing → delivers on the **re-drain** (≈300 ms), not the 1.5 s backstop. Measure both, since
   §7 is the claim being tested.
6. Idle terminal → `afx send` still delivers promptly; delta against `main` to confirm no regression
   on the common path.
7. `--interrupt` / `--escape` mid-delivery still behave as #1365 defines (`preempted` → hold); the
   delayed `^C` fires and now correctly counts as input.

Cross-platform: n/a (server-side Node).
