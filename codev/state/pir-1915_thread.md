# pir-1915 thread

## 2026-11-23 — plan
- Plan at codev/plans/1915-windows-show-and-end-orphaned-.md.
- Orphan = member of the session's Job Object, not the root shellper, whose parent pid is gone or reused (parent created after it). Parent unopenable => never listed.
- Helper gains `snapshot` (Toolhelp pid/ppid/name, shaped for later liveness-sweep reuse; sweep untouched), `job-processes`, `end-process` (kernel-side job + creation-time check).
- Tower routes GET /api/orphans, POST /api/orphans/end (husk-sweep precedent); `afx orphans [agent] [--apply] [-y]`; afx status + codev doctor sections, Windows only.
- Observed this session's tree: shellper -> conhost, bash(launch loop) -> bash -> bash -> claude.exe.
- Architect notes: no AI attribution anywhere; no auto-ending; full suite one at a time with bugfix-1910.

## 2026-11-23 — premise finding (blocks the plan as written)
- Architect asked to reproduce "Tower started inside a session lands in that session's job". Doing so showed something bigger:
  this builder's own session job contains ONLY shellper, conhost and 3 launch-loop bash.exe. claude.exe and every
  tool-call process are OUTSIDE the job (QueryInformationJobObject member list + IsProcessInJob).
- Cause (measured, isolated jobs, no Tower involved): Git Bash (MSYS) launches native children with breakaway, and
  session jobs carry BREAKAWAY_OK. With limit flags 0x800: bash in job, node child NOT in job. With flags 0: node child
  IN job; node and cmd both ran normally (rc 0).
- Isolated Tower + session running bash -c "node & cmd /c ping & ( node & )": job members = shellper, conhost, the bash
  processes (incl. an orphaned bash subshell); node, cmd, ping all outside.
- So a job-membership listing would not see agent tool-call orphans at all, and Spec 1658's "TerminateJobObject ends
  the whole session" does not cover native processes started from Git Bash.
- `afx tower start` from inside a session: Tower created via CIM, not in the session job (measured). Case B (plain
  detached spawn) was inconclusive because my tool processes are themselves outside the job.
- Main Tower PID 53132 before and after all experiments; test processes I created were all ended.
- Raised with the architect; waiting for a decision before revising the plan.

## 2026-11-23 — owner chose option A (same PR); plan revision 2
- Survey with no breakaway: git, gh, node->cmd, cmd, powershell, python, codex/code/claude --version, and a real
  `claude -p` Bash tool call all exit 0; claude, its bash and sleep stay in the job.
- Re-test: Tower plain-spawned from Git Bash inside a no-breakaway job IS a member, with its helper, a new session's
  shellper and that session's children; TerminateJobObject ended all of them. Hence three guards: Tower boot refusal
  inside a session job, teardown guard (no job terminate when the job holds a foreign shellper or a Tower), protected
  set in the listing.
- Gotcha: PowerShell variable names are case-insensitive ($k clobbered $K); leaked OpenProcess handles make
  IsProcessInJob report a dead process as still a member — check exit with Get-Process.
- Main Tower PID 53132 throughout; all test processes ended.

## 2026-11-23 — implement
- Commit 1 (alone): 6b7f81940 session jobs set no limit flags (no breakaway). New .windows. test fails with the old flag.
- Commit 2: 5c06db9bf helper ops snapshot / job-members / in-job / end-process; teardown guard (no job terminate or
  taskkill /T when the root's tree or job holds a Tower or another shellper); Tower refuses to boot inside the job its
  marker names. Surprise: the helper program outgrew the 32,767-char command line (-EncodedCommand) — now a tiny
  bootstrap reads the program from stdin, still in memory only.
- Commit 3: 74419b02a listing + ending, Tower routes (end is local-only like shutdown), afx orphans, afx status
  (--port added for isolated Towers), codev doctor, docs in both trees.
- Measured while testing: in Git Bash the dead-parent process is often the bash.exe stub MSYS keeps as parent of a
  native program (the program is its descendant); a Tower started by `cmd start /b` keeps the conhost of that cmd,
  whose parent is gone -> console hosts are never listed.
- Snapshot: ~12ms warm; job-members on this session ~94ms.
- Windows workflow: run 45092198798 (.windows. filter + suites).
