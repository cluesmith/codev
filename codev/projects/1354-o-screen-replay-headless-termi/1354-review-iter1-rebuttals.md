# Iteration-1 Rebuttals / Dispositions (PIR #1354)

Verdicts: gemini=APPROVE, codex=REQUEST_CHANGES, claude=REQUEST_CHANGES.
Every finding was verified against the actual files before acting. Fixes are in
commits `975b0e5-range` on the branch (see below); the review file's "Things to
Look At" carries the same dispositions for the pr-gate reviewer.

## Claude findings

1. **BLOCKING: `ITerminalAddon` cast uncommitted — PR head fails `tsc`.**
   VERIFIED TRUE: `git log -S ITerminalAddon` was empty; the cast lived only in
   the working tree (vitest transpiles without typechecking, and porch's build
   check ran against the working tree, which is how it was masked).
   **Fixed**: committed as "[PIR #1354] Commit the ITerminalAddon type bridge";
   tracked tree is now clean and `tsc --noEmit` passes on the branch head.
2. **Review file's build claim inaccurate for the committed tree.**
   Accepted — true as stated; it becomes accurate with the fix above committed.
3. **Minor: standalone `TerminalManager` path drops the fallback log.**
   **Fixed**: `pty-manager.ts` now forwards WARN lines (the AC-4 desync signal)
   to the console; INFO stays suppressed there as routine per-attach chatter.
4. **Minor: `tower-routes.ts` plan deviation unrecorded.**
   **Fixed**: recorded in the review file. The sites were deliberately left
   untouched — `mirrorSeed` is optional and fresh-spawn replays are never
   capped, so passing it would be a no-op.

## Codex findings

1. **`screenBufferType` read before flushing — alt-enter still in the parser
   queue misroutes a resume onto the delta path.**
   VERIFIED TRUE (reproducible: feed `\x1b[?1049h` without awaiting a read;
   type reports 'normal').
   **Fixed + regression test**: `attachWithReplay` now flushes the mirror
   before routing on buffer type; the new test feeds an unflushed alt-enter
   and asserts the resume receives the snapshot.
2. **Fallback logs omit the plan's `attempts=<k>` field.**
   **Fixed** for the `flush-timeout` reason — the only reason with a
   meaningful attempt count (the loop bound); test asserts the exact line.
3. **Standalone `pty-manager.ts` omits pause/resume framing and the seq frame.**
   **Rebutted**: that framing has never existed on the standalone path — the
   pre-#1354 code sent a bare data frame with no seq heartbeat. The approved
   plan's wire contract was "send the snapshot exactly as replay is sent
   today; keep each site's existing framing." Introducing brackets and a seq
   heartbeat to the standalone server's protocol is a behavior change out of
   scope for this PR.

## Verification after fixes

- `tsc --noEmit`: pass (clean tracked tree — committed == working).
- Affected suites (`src/terminal/`, `tower-websocket.test.ts`): 384 passed, 0 failed.
- PR #1402 body updated with the dispositions.
