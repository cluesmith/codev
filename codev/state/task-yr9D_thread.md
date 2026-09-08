# task-yr9D — landing PR #1634 (issue #1473) as maintainers

Mohid (mohidmakhdoomi) authored PR #1634 on `builder/pir-1473`. Owner decision 2026-09-08:
maintainers finish it. **His commits and authorship stay intact — never rebase, never squash,
never force-push.** I merge `origin/main` in and add commits on top; the architect handles all
communication on the PR thread.

## 1. Merge of origin/main — done (`9788b2f2a`)

79 commits behind. Two conflicts, both from PR #1644 (issue #1567 — long frames go out as one
bracketed paste in ≤512-byte chunks, Enter outside the bracket).

**`message-write.ts`**, two hunks:

- The interface region. #1473 added `PacedWriteSession` (`id`, `inputSeq`, `write(data,
  origin?)`) directly above the #584-era constants `PACED_WRITE_LINE_THRESHOLD` /
  `INTER_LINE_DELAY_MS` / `PACED_ENTER_DELAY_MS`; #1567 deleted exactly those constants and
  replaced them with `BRACKET_MIN_LINES` / `BRACKET_MIN_BYTES` / `PASTE_CHUNK_*` /
  `PASTE_ENTER_DELAY_MS`. Resolution: keep the interface, drop the constants. Nothing
  references the old names any more.
- The write call inside `trySubmitToSession`. Both sides edited the same two lines for
  unrelated reasons — #1473 samples `inputSeq` there (it must be read INSIDE the lock,
  immediately before the first byte, or the comparison spans the lock wait too), #1567 forwards
  the `WriteStrategy`. Both kept.

**`mailbox-delivery.ts`**, one hunk — the delivered-unverified block. #1473 moved the whole
escalation OUT of `if (echo)` and generalised it over `UnverifiedCause` (`input-raced` |
`no-echo`); #1567 stayed inside the echo block and only reworded the log line, because a long
frame now shows as a paste placard so "the header never appeared" is no longer the whole
condition. Resolution: #1473's structure, with #1567's wording folded into the no-echo branch
of the message (`neither its header nor a paste placard appeared`).

Everything else auto-merged, and the two integration points read correctly afterwards: the
strategy threads through `DeliveryPorts.writeMessage` from `writeStrategyForApp(profile.app)`,
and `watchEchoOnScreen` counts `PASTE_PLACARD_NEEDLES` alongside the header needle.

`pnpm -r build` green. Full suite green: **294 files / 5932 tests / 48 skipped / 0 failures**.

## 2. Review fixes on top

The 3-way integration review's verified findings — see the commits below.
