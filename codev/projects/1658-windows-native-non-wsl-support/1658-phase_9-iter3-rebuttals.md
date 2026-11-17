# Phase 9, iteration 3: responses to review

Gemini was skipped (agy exit 3). Codex requested changes; Claude approved with three notes.

## Codex (REQUEST_CHANGES)

**On Windows, a failed start reports "stopped" without verifying exit.** Accepted and fixed.
`stopUnreadyIdeServer` used to take any `killSessionTree` result without a refusal as proof, but
`killSessionTree` does not reject when `taskkill` fails. It now waits on the kill's own snapshot
with `waitForTreeExit` for the stop window. It reports stopped only once the tree has exited, and
otherwise logs that the tree outlived the kill. The start error then says the process could not
be stopped and names the pid. Seam tests cover all three outcomes: the snapshot exits, it
outlives the kill, the kill throws. The real-Windows never-listening stub test still passes.

## Claude (APPROVE), notes

1. **The same unverified "stopped".** Fixed as above, including tests for the false branch.
2. **A start on a new port could fail with a stop-shaped message.** Fixed. When stopping the
   server on the old port fails, the start now throws "Cannot start the IDE server on port N:
   stopping the one on port M failed: ...". The record stays as the stop left it.
3. **cmd `^` escapes could defeat the token-path match.** Fixed. Both the command lines and the
   token path have `^` removed before comparing, so a username such as `Tom & Jerry` (escaped
   `^&` on a `cmd.exe` root's line) still matches. Unit-tested.
