# Issue #1664 — draft delivery acceptance (fixed)

- harness: `claude` 2.1.266 (Claude Code), 120x40, 20 trials
- gate: the CURRENT composer-region stability gate
- delivery: the PRODUCTION `deliverAgentMail` over a real sqlite mailbox, live gate bindings
  (`classifyBuffer` + `composerRegionFingerprint`) and the production write edge
  (`submitMessagePaced`), driven every 150 ms
- settle: `SETTLE_BEFORE_WRITE_MS`=250 ms

## Outcomes

- **held**: 20/20

- delivered at a moment the RETIRED whole-screen settle would have refused: 0/20
- longest output gap seen while a row waited: 3509 ms (the retired whole-screen settle needed 250 ms to deliver at all)
- wait to delivery: mean 0 ms, median 0 ms, max 0 ms
- head-loss (tail rendered, head did not): 0/20
- body left the composer for the transcript: n/a (nothing was delivered — see below)
- a turn was running while the row waited: 20/20
- repaints the recipient emitted while the row waited: median 1

## Hold verdicts observed

- `busy:user-text`
