# bugfix-1584 — tower: echo-verify re-write loop re-injects a delivered message unboundedly

Builder thread. Issue #1584 (hotfix for the 3.3.2 regression from #1573 / PR #1577;
field report #1583).

## 2026-09-02 — INVESTIGATE

**Root cause confirmed at current main** (no guessing — traced the whole path):

1. `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:694` — inside
   `deliverAgentMail`, AFTER `ports.writeMessage(...)` has returned
   `{ status: 'written' }` (every byte + Enter accepted by the PTY), a failed
   `echo.verify()` does `return hold('busy')`. The row stays `held`.
2. `MailboxDrainer.tick()` (1.5 s backstop) and `scheduleDrain` re-run
   `deliverAgentMail` for that agent on every later clean-prompt pass, which does a
   **full re-write** of `current.formatted_message`. There is no attempt counter
   anywhere — `grep attempt` over `mailbox-delivery.ts` and `db/mailbox.ts` returns
   only prose; the `mailbox` table has no attempts column.
3. `isClassifierStuck()` (line ~305) deliberately excludes `busy`, so the loop never
   reaches liveness telemetry — it is silent to the owner.
4. Field trigger (per #1583): the recipient starts responding immediately, so its
   output either scrolls the header out of the 1000-line `SessionScreen` mirror or
   evicts the pre-write copy. `countEchoOnScreen` then does not see `count > before`
   (`mailbox-wiring.ts:237` `watchEchoOnScreen`), verification fails, the message is
   re-injected, the recipient responds again → self-sustaining. `afx interrupt` makes
   it worse: each interrupt produces a fresh clean prompt = another pass.

**Existing proof in-tree:** `bugfix-1573-delivery-verification.test.ts` →
"a row held by a failed verification is redelivered by the next pass" asserts
`h.writes).toEqual([FORMATTED, FORMATTED])` — i.e. the current suite pins the
re-write as intended behaviour. That test is one of the two #1573 tests the issue
says to update to the new contract.

**Scope:** small. Verify site in `mailbox-delivery.ts`, a `verified` field threaded
through `DeliveryOutcome` → `tower-routes.ts handleSend` → `sdk/tower-client.ts` →
`commands/send.ts`, plus tests. Well under 300 LOC. Fits BUGFIX.

**Design (prescribed by the issue, owner-approved — not relitigated):** a row whose
write completed is at-least-once delivered and must NEVER be written again. One extra
bounded verify window, then mark `delivered` + `escalated`, WARN log, `verified:false`
to the sender.

**Note:** the worktree had no `node_modules` — ran `pnpm install` before testing.

## 2026-09-02 — FIX

Change (6 source files + 3 test files, ~155 LOC of source diff):

- `mailbox-delivery.ts` — the fix. After `writeMessage` returns `written` there is now an
  explicit POINT OF NO RETURN: no `hold(...)` may follow it. The echo check still runs but
  decides what we *report*, not whether we write again. On failure: one extra bounded
  `verify()` window (a second LOOK, zero bytes written; ~1.2 s total since
  `ECHO_VERIFY_TIMEOUT_MS` is 600), then `markEscalated` (while the row is still `held`, since
  `markEscalated` is held-only) + a `WARN` log + `verified: false` on the outcome.
- `DeliveryOutcome.verified?: boolean` — absent when verification was skipped (no needle) or
  nothing was delivered.
- `DeliveryPorts.log(message, level?)` — needed a `WARN` level; the wiring binding was
  hardcoding `INFO`. Existing 1-arg fakes stay assignable.
- `tower-routes.ts handleSend` — keeps the delivery outcome and spreads `verified` onto the
  delivered response (additive; omitted when undefined).
- `sdk/tower-client.ts` — `verified?: boolean` on the send response type + passthrough.
- `commands/send.ts` — `[ok] Message delivered to X (N bytes) (unverified — header not seen
  on the terminal)` when `verified === false`; unchanged otherwise.

**Audit of item 3 (holds reachable after a completed write):** the only one was the verify
site. `dropped` = bytes lost mid-pace; `preempted` = an unserialized operator write may have
truncated the composer; `contended`/`aborted` = nothing written. None is `written`, so none is
the at-least-once case. Documented at the point-of-no-return comment. `cron-delivery.ts` shares
`deliverAgentMailSerialized`, so it has no second verify site. Item 4 needed no code change —
pinned by test instead.

**Judgment call (worth an architect glance):** I set the `escalated` DB column but did NOT fire
`ports.onEscalation`. That SSE event's binding hardcodes the title "Message held past
escalation age", which would be false for a delivered row. The sender-facing `verified:false`
(item 2) is the surface that actually reaches a human.

**Tests.** New `bugfix-1584-no-rewrite-after-write.test.ts` (7 tests): control test (written
exactly once, ends `delivered` + `escalated`, two real `MailboxDrainer.tick()`s write nothing),
WARN log content, at-most-two verify windows, broadcast still fires, verified path unchanged,
pre-write hold still holds, and the immediate-responder simulation against a REAL
`SessionScreen` (header echoed then buried under 2000 lines of response). **6 of its 7 tests
fail against the unmodified `mailbox-delivery.ts` at HEAD** (verified by swapping the file back
in and re-running); the 7th is the pre-write-hold guard, which should pass on both.

Updated (not deleted) the two #1573 tests that pinned hold-and-redeliver, plus route
(`tower-routes.test.ts`) and CLI (`send.test.ts`) coverage for `verified`.

## 2026-09-02 — PR

PR #1585 opened (`Fixes #1584`). Three commits: the fix, the tests + this thread, and a
follow-up tightening (report `verified` only for the row *this* request's pass delivered — a
pass picks the agent's OLDEST held row, so without an id check a concurrent drainer delivery
of our row could be reported with another message's verification result).

**Environment note for whoever picks this up:** the worktree arrived with no `node_modules`
and no `packages/codev/skeleton/`. 12 test files (adopt, update, hot/cold-tier, protocol-drift,
consult, consolidate, spawn-retirement, session-manager, …) fail until `pnpm install` +
`pnpm --filter "@cluesmith/codev^..." build` + `pnpm build` in `packages/codev`. I confirmed
the identical per-file failure counts at HEAD before building, so none were mine. After the
build: **5372 passed, 0 failed, 48 skipped** across 273 files.

`consult` did NOT auto-detect the project from builder context — it listed every project and
exited 0 without reviewing. `--project-id bugfix-1584` fixes it. Worth an issue if it recurs.

CMAP verdicts: gemini=APPROVE (no issues, 12.8s). codex + claude pending.
