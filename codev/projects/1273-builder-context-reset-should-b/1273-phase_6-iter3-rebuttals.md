# Rebuttal — Phase 6 (Reset orchestrator + CLI wiring), iteration 3

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

**Accepted.** Fourth round in this project where two APPROVEs would have shipped a defect, and the third
consecutive one in this phase where the finding is about the WRAPPER rather than the state machine.

---

## Codex — REQUEST_CHANGES

### Issue: "The real wrapper never binds terminal-output reads, so `/clear` confirmation cannot work outside tests"

**Accepted.** `readRecentOutput` is optional on `TerminalPort`, and `confirmClear` opens with
`if (!terminal.readRecentOutput) return false;`. My production `buildTerminalPort` never set it. So on
every real run `confirmClear` returned false without doing anything, and the report printed
`clear-unconfirmed`.

That is worse than a missing feature, and it is the same failure shape as the `/clear`-via-escape
near-miss earlier in this phase: **a step that appears in the report as though it were attempted, and
could only ever pass in tests.** An architect reading `clear-unconfirmed` would reasonably infer "we
looked and could not confirm", when the truth was "we never looked". My own orchestrator tests covered
the confirmed branch using a mock that supplied the method the real code never bound — the tests were
green *because* they were testing something production did not do.

**Root cause, checked rather than assumed.** I had believed there was no Tower API for terminal output.
There is: `GET /api/terminals/:id/output` (`tower-routes.ts:936`), backed by
`PtyManager.getOutput(id, lines, offset)` returning `{ lines, total, hasMore }`. It has existed since the
terminal manager was written. What was missing was a **client binding** — `TowerClient` had no method for
that route, so from where I was standing the capability was invisible. That is exactly the assumption
this project keeps punishing: I described a capability from memory instead of opening the file.

**Changed**:

- `packages/core/src/tower-client.ts` — new `getTerminalOutput(terminalId, lines = 100)`, following the
  existing `getTerminal`/`listTerminals` shape.
- `commands/reset.ts` — `readRecentOutput` bound for real, reading the last 50 lines and joining them.
- Confirmation stays **advisory**: a null result (older Tower, 404, terminal gone) degrades to
  "unconfirmed" and never fails a reset that already succeeded. That property is now tested rather than
  asserted in a comment.

Two wrapper tests: the method is bound and returns the terminal's recent output, and a Tower that cannot
serve it yields `null` instead of throwing.

**A note on why this was not caught by "the tests pass".** The orchestrator test for the confirmed branch
constructs a terminal with `recentOutput` supplied. It proves `confirmClear` reads correctly *given* the
port. It cannot prove the port exists in production — that is a wrapper property, and it is the third such
property this phase (channel binding, target resolution, now output reads) that the state-machine tests
were structurally blind to. The command-surface file introduced in iteration 1 is where these belong, and
it is now carrying its third regression.

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised.

---

## Net effect

`/clear` confirmation now works outside tests. A previously unbound Tower route gained its client method.
Tests 3948 → 3950. Build clean.
