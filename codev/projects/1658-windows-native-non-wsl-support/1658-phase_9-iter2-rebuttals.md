# Phase 9, iteration 2: responses to review

Gemini was skipped (agy exit 3). Codex requested changes; Claude approved with three notes.

## Codex (REQUEST_CHANGES)

**Stop with no listener deletes the record without killing anything.** Accepted and fixed for
Windows, which this phase owns. There are two causes, now told apart:

- **The port query failed.** `getProcessesOnPortAsync` resolves `null` on Windows when the
  PowerShell query fails or times out; it no longer returns `[]`. `stopWindowsIdeServer` then
  keeps the record, kills nothing and throws, so the stop can be retried.
- **Nothing listens, but the server may still be alive with its port closed.**
  `windowsIdeRecordedServerPlan` checks the recorded pid's tree in a fresh census. It counts as
  this server only if a process in the tree carries Tower's connection-token path on its command
  line; every spawn passes `--connection-token-file <path>`. The child's line is checked too,
  because a `cmd.exe` root's line holds the path with cmd escapes. If the tree is ours, it is
  killed and the stop waits on it. Otherwise nothing is killed and the record goes, so a reused
  pid is never touched. If the census fails here, the record is kept and the stop throws.

Unit tests cover all four cases: query failed, a port-closed live server killed, a reused pid
left alone, and census failure. POSIX keeps `lsof`'s `[]` for both cases; that is #1668's
existing behavior there, as Claude notes.

## Claude (APPROVE), notes

1. **A failed port query reads as "nothing listening".** The same point as Codex's, fixed as
   above. `afx ide status` on Windows falls back to a loopback connect when the query fails.
2. **"The server process was stopped" was asserted, not verified.** Fixed.
   `stopUnreadyIdeServer` now returns whether the process is gone. The error says "stopped" only
   then, and otherwise "could not be stopped and may still be running", naming the pid. A
   non-ESRCH failure of the POSIX group SIGTERM is logged.
3. **The exit wait had no creation-time re-check.** Fixed. Targets carry their census creation
   time. Before reporting survivors, the stop re-reads the census and drops any pid whose
   creation time changed. A survivor with no recorded creation time, or a failed census, still
   counts as surviving, which fails safe. Unit-tested with a pid reused during the wait.
