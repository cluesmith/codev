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
