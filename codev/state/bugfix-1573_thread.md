# bugfix-1573 thread — Tower delivery write-edge: verify-or-retry, settle-before-write, loud size limit (#1573)

Protocol: BUGFIX (strict). Area: area/tower. Residuals of #1564 / #1521 left open
after PIR #1365 (PR #1492).

## What the change is
Three changes at the post-#1492 converged write edge (`mailbox-delivery.ts` +
`mailbox-wiring.ts` + `tower-routes.ts` + `commands/send.ts`):

1. **Settle-before-write** — require `now − session.lastDataAt ≥ 250ms` immediately
   before the write, else hold `busy`.
2. **Loud 48KB body limit + `bodyLength` echo** — reject at the route and mirror at
   the CLI; never silently truncate.
3. **Echo-verification before `markDelivered`** — after the paced write, poll the
   session's rendered mirror for the message's header line; absent → hold, not
   `delivered`.

## Log

### 2026-09-01 — investigate

Root cause confirmed by reading the post-#1492 code (no guessing):

- `[ok] Message delivered` means only "frames queued on a connected socket".
  `submitMessagePaced` (`servers/message-write.ts`) returns `written` when every
  `session.write()` returned true; `ShellperClient.write` returns true iff the
  socket object is connected. `deliverAgentMail` (`servers/mailbox-delivery.ts:555`)
  calls `markDelivered` on that alone — no echo, no ACK.
- The render gate has **no stability requirement**: `deliverAgentMail` samples
  `ringToken` before/after `classify` (TOCTOU), but never consults
  `session.lastDataAt` (`terminal/pty-session.ts:823`). A screen that repainted 1ms
  ago passes identically to one idle a minute. The quiescence drain trigger has an
  accidental 500ms settle; the request path (`handleSend` → immediate
  `deliverAgentMailSerialized`) and the `'submit'` fast trigger have none.
- No size limit exists between the CLI flag and the PTY bytes — only the generic
  1MiB HTTP body cap and `MAX_FILE_SIZE = 48KB` on `--file`
  (`commands/send.ts:21`).

#### Measurement: is header echo-verification viable? (decides change 3)

The issue's scope guard asks for this to be cut if it can't be done narrowly and
reliably. Rather than guess, I drove **real harnesses through a real PTY**
(`node-pty`, 117x64) with the production paced write (line-by-line, 10ms gaps,
80ms then `\r`), then rendered the accumulated output into a headless xterm
(`scrollback: 1000`) — the same mirror shape the gate classifies — and searched
for the header at +200/500/1000/2000/5000ms.

| harness | body | buffer | header found |
|---|---|---|---|
| claude (2.1.252) | 20 lines | normal | **exact form NO**, normalized YES, from +200ms |
| claude | 300 lines / 24.9KB | normal (scrollback) | exact YES at buffer line 6, all samples |
| codex (0.146.0) | 20 lines | normal | exact YES, all samples |
| agy | 12 lines | **alternate** | unmeasured — agy produced 1.7KB and never rendered a composer here (unauthenticated) |

The one surprise, and it is load-bearing: **claude markdown-renders the header on
submit.** While typing, the composer echoes `### [ARCHITECT INSTRUCTION | <ts>] ###`
verbatim; once submitted, the transcript shows `[ARCHITECT INSTRUCTION | <ts>]` —
the `###` fences are consumed as an H3. An exact-line match would therefore fail on
*every short claude delivery*, which is the common case. A **normalized** match
(strip everything but `[A-Za-z0-9]` on both sides, substring-compare) survives that,
survives line wrapping and any `> `/`❯ ` prefix, and stays harness-agnostic — no
per-harness branch.

Long messages are safe for a different reason: the composer echo scrolls into
scrollback while typing and is never erased, so the exact header is still at buffer
line 6 of a 300-line send.

Decisions taken from this:
- Needle = **header line only**, normalized. Not the footer: #1564's shape was
  "arrived as its final ~30 chars", so a tail needle would pass the very bug.
- Residual risk, documented not designed around: **agy uses the alternate screen**
  (`type=alternate` at boot), which has no scrollback, so a message longer than the
  viewport could scroll its header away → unverifiable → redelivery. Unmeasured
  because agy is not authenticated in this environment.
- Verification passes on composer echo too, so a *swallowed Enter* (typed but not
  submitted) still verifies. Not closed here: distinguishing composer from transcript
  is the classifier's job and is explicitly out of scope. The dirty composer holds
  all following mail, so it surfaces.

Scope: three focused edits plus tests, well under the 300 LOC BUGFIX ceiling.
Proceeding to fix.

Probe scripts live in the session scratchpad (not committed).

### 2026-09-01 — fix

Three changes plus tests; 378 lines added across 15 files, most of it comment and test.

**1. Settle-before-write.** `DeliverySession` gains `lastDataAt` (PtySession already tracked
it). `deliverAgentMail` requires `now − lastDataAt ≥ SETTLE_BEFORE_WRITE_MS` (250) both
before the per-terminal lock and again inside the precheck, mirroring how the other three
write-instant conditions are already double-checked. Phrased as a positive `>=` via a
`settled()` helper so a session with no usable timestamp yields NaN → **not** settled → hold.
A fail-open there would have been worse than no check, and one existing test double
(tower-routes' `gateSession`) did in fact lack the field.

**2. Loud 48KB limit.** `MAX_MESSAGE_BYTES` + `messageTooLargeError` in `utils/message-format.ts`,
imported by both boundaries. The CLI checks AFTER the `--file` append — attachment content
travels in the same body — and `MAX_FILE_SIZE` is now defined as `MAX_MESSAGE_BYTES` so the
two cannot drift. Route answers 400 `MESSAGE_TOO_LARGE` before resolving the target.
`bodyLength` rides every send response that carried a body (delivered, held, interrupt,
delayed) through the SDK to `afx send`'s success line.

*Behaviour change worth flagging:* a `--file` attachment at or near 48KB plus any message
text now fails where it previously went through. That is the tightening working as intended
— such a body could never have been typed into a composer reliably — but it is a real
change, not a no-op.

**3. Echo verification.** New required `verifyEcho` port, called after a `written` result and
before `markDelivered`. Made REQUIRED rather than optional (`escalateHeldToOwner`'s pattern):
an optional port a future ports-construction forgets is a silent return of the exact bug.
Live binding `verifyEchoOnScreen` polls the session's `gateScreen` — the same mirror the gate
classifies — every 50ms for up to 600ms, scanning the full retained buffer (`bufferLines`,
new export in `render-gate.ts`) rather than the viewport.

The needle is the formatted message's first line, run through `normalizeForEcho` (strip all
non-alphanumerics). That is what makes it work: claude renders `### [ARCHITECT INSTRUCTION |
<ts>] ###` verbatim in the composer, then markdown-strips the fences on submit, so a literal
match would fail on every short claude delivery. Normalizing also absorbs quote prefixes,
indentation and wrapping. Needles under 12 normalized chars are skipped rather than
rubber-stamped.

**Dropped: the optional sacrificial leading newline (issue item 4).** `writeMessageToSession`
would send a bare `\n` as its own first write, and whether a harness treats that as "insert
newline" or "submit" is exactly the per-harness behaviour I could not measure for codex and
agy. An empty submit ahead of every message is a worse failure than the head-eating it
guards against, which settle-before-write already addresses. The issue marks the item
optional and says to drop it at the first sign of harness weirdness.

**Tests.** New `bugfix-1573-delivery-verification.test.ts` (16 tests): settle window (inside /
at boundary / in-lock re-check / NaN), the control test (completed write + unshown header →
held, not delivered, no broadcast), confirmed delivery, redelivery of a held row, short-needle
skip, needle normalization against the three measured rendered forms, and `verifyEchoOnScreen`
against a real `SessionScreen` (composer form, markdown-stripped form, scrolled-into-scrollback,
absent, early return). Route tests for over-limit / at-limit / `bodyLength`; CLI tests for the
local refusal, the `--file` interaction and the byte-count echo.

Verified the tests are real: with the settle and verify branches disabled, 6 of the 16 fail;
restored, all pass.

`tower-routes.test.ts`'s `gateSession` double now echoes writes into its own mirror, because
a real terminal does and the delivery path now depends on it. That is a more faithful fake,
and a test wanting a swallowing terminal can still pass a `write` that skips the feed.
