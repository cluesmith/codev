# Phase 9, iteration 1: responses to review

Gemini was skipped (agy exit 3). Codex requested changes; Claude approved with notes.

## Codex (REQUEST_CHANGES)

1. **A server that never binds is left running, untracked.** Accepted and fixed for Windows.
   `spawnIdeServerUnlocked` now kills the spawned tree (`killSessionTree`) before throwing on a
   readiness timeout. A failed kill is logged. The real-Windows stub test gains a never-listening
   server (`STUB_IDE_NO_LISTEN`), driven through the plain `.cmd` shim so the tree has a cmd.exe
   root. It asserts that the start fails, the server and its child are gone, and no record exists.
   The POSIX start path has the same defect, but this project keeps POSIX byte-identical, so it
   is raised with the architect and not changed here.

2. **A stop with survivors deletes the record.** Accepted and fixed. When any target outlives
   the exit wait, `stopWindowsIdeServer` keeps the record and throws, naming the surviving pids,
   so the server stays tracked and the stop can be retried. `/api/ide` DELETE now answers 500 with
   that message, which `afx ide stop` prints before exiting 1. The unit test asserts the throw,
   the kept record and the warning.

## Claude (APPROVE), notes

- (a) **Synchronous port queries inside Tower.** Fixed. `getProcessesOnPortAsync` (`utils/port.ts`)
  runs the Windows PowerShell query asynchronously; POSIX is the same `lsof` lookup. Adoption, stop
  and status use it, so Tower runs no synchronous PowerShell port query on any IDE path.
- (b) **Stale `isPortLive` docstring.** Fixed: it names `getProcessesOnPort`, not `lsof` only.
- (c) **Profile assertion checked the test's own mock.** Fixed: the stub test now asserts the real,
  unmocked `AGENT_FARM_DIR` lies under the user profile.
- (d) **`/tmp` fallback in a Windows-run test.** Fixed: `TEMP || TMPDIR || '/tmp'`.
- (e) **No Phase 9 section in the review doc.** Added.
- (f) **#1789's POSIX-only test suites.** Kept as is, and the trade is recorded in the review doc.
