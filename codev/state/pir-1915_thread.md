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
- Full local suite (one run, main Tower 53132 before/after): 8170 passed, 6 failed — all skill parity: the afx skill
  also lives in .codex/ trees and has a hash history. Fixed in e3546f923; the 4 files then pass.
- Windows run 45092198798 (before that fix): targeted .windows. tests all green on the runner; unit jobs failed only on
  those 6 parity tests. Fresh run on e3546f923: 45093824937.
- Real-session dev check (isolated Tower via CIM from inside this session, throwaway workspace outside %TEMP%, real
  Claude architect + builder, haiku): 18/18. claude.exe and the timed-out find.exe ran inside the builder's job; the find
  kept burning CPU (3m59s in 3m); afx status and afx orphans listed it (no command line); --apply ended it; builder and
  architect kept running; closing the builder ended its whole tree; Tower restart kept the architect's shellper.
  Gotcha: Tower reconcile drops sessions whose workspace is under %TEMP% (pre-existing, deliberate).
- Not run here: agy (not installed), Codex as a full agent session.

## 2026-11-23 — dev-approval feedback: drop the manual ending path
- Human: with no breakaway, afx cleanup / closing the session ends everything, so no command should be needed to end
  orphans by hand. Removed afx orphans, POST /api/orphans/end, the helper's end-process (148092136). Kept the read-only
  list in afx status / codev doctor; hint says they end with their session.
- Real-session check rerun, 18/18: both afx cleanup paths (Tower kills the terminal; Tower down, shellper kill by
  worktree) end the builder, its orphaned find and its whole tree; architect and Tower survive; Tower restart keeps the
  architect. Main Tower 53132 throughout.
- Full local suite rerun: 8162 passed, 1 failed: launch-loop-exit-code "still auto-restarts after a crash" — passes 3/3
  alone and passed in the first full run; load flake, untouched code.
- Windows run 45093824937 (e3546f923): Node 22 + targeted green; Node 24 failed tower-lifecycle.windows scenario 5
  (afx tower stop exit 0xC0000142, DLL init failed) and pir-1233-session-launch-loop (Git Bash launch failed) — both
  pass on Node 22, in the targeted job and in the earlier run: runner load flakes. Fresh run on 148092136: 45098207402.

## 2026-11-23 — CI rounds on the teardown guard
- Run 45099192117: (a) guard failed open when the job listing failed -> fixed: failed listing or no census never
  terminates the job; (b) process-tree.windows scenario 6 (never failed in 102 logs): two cold one-shot helpers per
  teardown -> one helper per teardown; no-job teardown skips terminate and re-check. Commit 4f4a5fca2.
- Run 45100689541: (a) guarded teardown killed other job members one by one and killed an inner shellper the census
  check missed -> guarded teardown now ends only the root's live tree; (b) tower-lifecycle Phase 4(b): launcher's job
  vanished (jobOpened=False, never seen elsewhere) -> my tests' afterAll SIGKILLed every recorded pid incl. long-exited
  ones; now helpers/tracked-pids.ts kills only a pid whose process predates the recording.
- Audit (architect): every new/touched test file checked for unchecked pid kills. Only session-orphans.windows and
  windows-job.windows had it (both fixed); the rest use fakes/mocks or identity-checked kills. Pre-existing, untouched:
  process-tree.windows and tower-lifecycle.windows still use the unchecked leftovers pattern — named in the PR.
- Stop rule (architect): if the next two CI runs on this fix are not both green, no more patches: send a design note
  (guard vs. preventing the case: Tower refusing to run inside any session job, harness starts Towers the supported way).

## 2026-11-23 — prevent design (aad9c00a1)
- Human: drop the listing entirely; prevent instead of guard. Tower refuses at boot to run in ANY session job (jobs of
  every live shellper from the census + the marker's); teardown back to main's; helper gains only in-job (fits a
  command line again). Harnesses keep the marker for `tower start` only so afx uses CIM inside a session.
- 15 files / ~456 lines vs main (+ plan, thread, status.yaml). macOS/Linux: no runtime change.
- Local: all .windows. green; full suite 8135 passed, 0 failed. Real-session check 17/17 (both afx cleanup paths end
  the builder and its orphaned find; architect/Tower survive; restart OK). Main Tower 53132 throughout.
- CI 45132497859: fully green. Run 2: 45133587326.
- Boot cost of the refusal check, measured: ~0.6s with 9 live shellpers (warm PowerShell); a few seconds cold.
- Plan file still describes the earlier design; the review will record the course change.

## 2026-11-23 — worker death / lost runner evidence (for the review and PR)
- Run 45133587326 (aad9c00a1), Node 22 unit: all 8135 tests that ran passed; 1 unhandled "Worker exited unexpectedly".
  JSON report: the dead worker was in windows-job.windows.test.ts, during "a stopped helper (Tower restart) does not
  kill a job member" (unchanged from main; it terminates a job holding only its own idle child). Precedent:
  spir-1658 run 39927082964 (2026-10-23, Node 22), dead worker in agy-lane-model.test.ts; #1923 lists the symptom.
- Architect check: terminateChecked (3b4066839, kept permanently) asks in-job for the worker and its parent before
  every terminate in that file, logs JOB-WORKER-CHECK, throws if a member. Code review: no assign targets the worker
  or its parent; the Git Bash test assigns only its own detached root; tracked-pids only kills.
- Local loop, that file alone, Node 22.23.4: 32/32 runs green, 0 worker deaths, 384 checks all member=false.
- Run 45135042446 (3b4066839): Node 24 unit + targeted green, 24 checks all member=false. Node 22 unit: "The hosted
  runner lost communication with the server", 07:59 -> 08:47 (48 min); log lost. Same signature on spir-1658 Node 22
  unit, runs 42547114468 (22:52 -> 23:39) and 42715696142 (01:44 -> 02:31), 47 min each, vs a normal 5-7 min job.
  Architect: pre-existing Node 22 runner pattern; worker-in-job theory ruled out.
- Next: two consecutive greens on 3b4066839 (first: 45142055516).
- Two consecutive fully green runs on 3b4066839: 45142055516 and 45143011938. Each: Node 22 unit, Node 24 unit and
  targeted jobs logged 12 JOB-WORKER-CHECK lines, 0 member=true, 0 worker deaths.

## 2026-11-24 - merged origin/main

Owner asked for a merge (not rebase) of origin/main, which includes PR #1949 (#1910). Clean merge, no conflicts; only codev/resources/arch.md changed on both sides and auto-merged with the #1915 section intact. New head 72e0e2f42. Build green; branch tests + merged tests (air-1893, bugfix-1910, bugfix-1952) 109 passed / 7 skipped; main Tower 53132 before and after. Fresh Windows run: https://github.com/cluesmith/codev/actions/runs/45276143657. Still at dev-approval.

## 2026-11-24 - review + PR
- dev-approval approved by the owner (relayed). Review written; PR #1959 opened, no attribution.
- Consultation: gemini COMMENT (skipped, no agy), codex COMMENT (LOW, sandbox blocked reads), claude COMMENT (HIGH). Acted on: exact flag assertion, openBrowser documented in DEPENDENCIES.md, full untested list, nits. Left to the architect: moving process-tree.windows afterAll to tracked-pids (suspected Phase 4(b) killer).
- At the pr gate.
