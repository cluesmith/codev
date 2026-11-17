# Issue #1664 — turn-end delivery acceptance (fixed)

- harness: `claude` 2.1.266 (Claude Code), 120x40, 20 trials
- gate: the CURRENT composer-region stability gate
- delivery: the PRODUCTION `deliverAgentMail` over a real sqlite mailbox, live gate bindings
  (`classifyBuffer` + `composerRegionFingerprint`) and the production write edge
  (`submitMessagePaced`), driven every 150 ms
- settle: `SETTLE_BEFORE_WRITE_MS`=250 ms

## Outcomes

- **delivered-intact**: 20/20

- delivered at a moment the RETIRED whole-screen settle would have refused: 0/20
- longest output gap seen while a row waited: 45 ms (the retired whole-screen settle needed 250 ms to deliver at all)
- wait to delivery: mean 244 ms, median 393 ms, max 404 ms
- head-loss (tail rendered, head did not): 0/20
- body left the composer for the transcript (submitted, not stranded on the line): 20/20
- repaints the recipient emitted while the row waited: median 2

## Hold verdicts observed

- `busy:composer-redraw`
