# Issue #1664 — streaming delivery acceptance (codex-confirm)

- harness: `codex` codex-cli 0.153.4, 120x40, 5 trials
- gate: the CURRENT composer-region stability gate
- `queuesInputMidTurn`: from the profile (already measured)
- delivery: the PRODUCTION `deliverAgentMail` over a real sqlite mailbox, live gate bindings
  (`classifyBuffer` + `composerRegionFingerprint`) and the production write edge
  (`submitMessagePaced`), driven every 150 ms
- settle: `SETTLE_BEFORE_WRITE_MS`=250 ms

## Outcomes

- **delivered-intact**: 5/5

- delivered at a moment the RETIRED whole-screen settle would have refused: 5/5
- longest output gap seen while a row waited: 174 ms (the retired whole-screen settle needed 250 ms to deliver at all)
- wait to delivery: mean 397 ms, median 397 ms, max 400 ms
- head-loss (tail rendered, head did not): 0/5
- body left the composer for the transcript (submitted, not stranded on the line): 5/5 delivered
- a turn was running while the row waited: 5/5
- repaints the recipient emitted while the row waited: median 16

## Hold verdicts observed

- `busy:composer-redraw`
