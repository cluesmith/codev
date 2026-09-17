# Builder thread — bugfix-1686

## Issue
tower reconcile Phase 2 deletes a session row + SIGTERMs the pid for any shellper whose
reconnect merely FAILED, without confirming the process is dead. In the #1629 incident this
destroyed 53/56 live rows. Split from #1629; the #1629 owner-lock guard blocks the
second-Tower amplifier, this issue removes the destructive mechanism.

## INVESTIGATE (phase 1) — root cause found, no code written

Files:
- `packages/codev/src/agent-farm/servers/tower-terminals.ts`
  - Phase 1 reconnect loop: lines ~800-805 (`if (!client) … "is stale (PID/socket dead)"`).
  - Phase 2 sweep: lines ~919-937 (`processExists(session.pid)` → SIGTERM + DELETE).
- `packages/codev/src/terminal/session-manager.ts` `reconnectSession()` lines 535-577.

Root cause: `reconnectSession()` returns `null` for FIVE reasons:
1. process dead (545-548)
2. PID reused / start-time mismatch (551-556)
3. socket not a socket file (559-564)
4. socket missing / lstat error (565-568)
5. **`client.connect()` throws (570-577)** ← the incident case: process ALIVE, socket file
   PRESENT, connect refused because the real Tower already owns the socket
   (one-client-per-shellper). Also fires on any transient boot hiccup (#1685 fd pressure).

Phase 1 treats ALL five `null`s identically as "stale (PID/socket dead)" and lets the row fall
to Phase 2. Phase 2 then, for any unmatched row, kills `session.pid` when it is alive and
deletes the row — so it signals exactly the LIVE processes it should preserve.

## Fix shape (for IMPLEMENT phase)
Phase 2 must require POSITIVE evidence of death before delete/SIGTERM of a shellper-backed row:
- pidAlive = shellper_pid present && processExists(shellper_pid)
- socketPresent = fs.existsSync(shellper_socket)
- If pidAlive && socketPresent → could-not-confirm-death → leave row untouched, log WARN,
  never signal, `continue` (retried next reconcile/adoption pass).
- Otherwise → genuine death evidence → existing cleanup (kill orphan if any + DELETE).
Non-shellper rows (shellper_socket === null): unchanged.

Regression test (tower-terminals.test.ts): shellper row, reconnect returns null, shellper_pid
alive (use process.pid), socket existsSync=true → assert row NOT deleted AND
process.kill(pid,'SIGTERM') never called. Fails without fix, passes with it.

## Scope
~15-25 LOC in one file + one test. Single file, clear root cause. Fits BUGFIX (<300 LOC).
3.3.4 rider per architect; anything adjacent gets FILED not fixed.

## FIX (phase 2) — implemented + CMAP + architect scope ruling

Phase 2 guard (reconcile sweep, tower-terminals.ts ~926-943): shellper-backed row that failed
reconnect with live pid + present socket → WARN + continue (kept), never SIGTERM/DELETE.

CMAP (3-way, HIGH all): core fix APPROVED. But all three flagged a SIBLING delete site —
getTerminalsForWorkspace() on-the-fly reconnect (~1132) did `deleteTerminalSession` on any null
reconnect with NO liveness check, so a row Phase 2 preserved would die on the first /api/state
read. codex REQUEST_CHANGES, claude COMMENT (fix-or-file), gemini non-blocking.

Architect ruling: FOLD IT IN. "Same defect behind a second door = same fix = in scope; the
no-growth rule guards DIFFERENT defects, not the same one's siblings." Requirements met:
1. Identical shellperAlive+socketPresent guard at the on-the-fly site (~1137-1155).
2. Second regression test: row preserved by reconcile survives a getTerminalsForWorkspace pass
   with still-failing reconnect (undeleted, unsignaled). Verified non-vacuous (disabled guard →
   DELETE fires).
3. Polish: `unconfirmed` counter in reconcile summary (so preserve-only run doesn't log "No
   terminal sessions to reconcile"); onTestFinished(restoreAllMocks) hardening on both tests
   (mocked process.kill must not leak).

Boundary held: further delete sites → FILE; shellper_pid===null legacy edge → PR-body note.
Both tests green (63/63 in file).

Re-CMAP (r2) after fold: codex APPROVE HIGH (its r1 REQUEST_CHANGES answered), claude APPROVE
HIGH (nits only), gemini skipped (agy flaky, non-blocking). One extra coherence fix taken from
r2/r1 feedback (flagged by 2/3 reviewers): Phase 1 null-reconnect log no longer asserts "is
stale (PID/socket dead)" — reworded to "reconnect failed — deferring to Phase 2 sweep for death
confirmation", since that log now precedes rows Phase 2 PRESERVES (same reconcile path my change
touches; a log my own change rendered false). All other nits → PR-body residuals (see below).

PR-body residuals to document (claude r2, all accepted-as-is, not changed):
- PID-reuse: processExists(shellper_pid) can't detect a recycled pid; conservative by design
  (tightening via getProcessStartTime would re-open the false-death path). Known residual.
- Asymmetric evidence: pid-alive + socket-ABSENT still SIGTERMs (socketless shellper is
  unreachable). Chosen reading of the issue's "AND/OR".
- Unbounded retention: a permanently-unreconnectable-but-alive shellper keeps its row until
  stop (deleteWorkspaceTerminalSessions). Accepted (leak a row, not a session).
- shellper_pid===null legacy edge → falls through to SIGTERM of session.pid; ~unreachable given
  saveTerminalSession call sites.

Commit: 35a3bd92b → amended → 8707ea008 (Fix #1686 ...).

## PR (phase 3) — PR #1693 open, CMAP done, BLOCKED on architect ruling

PR #1693 (https://github.com/cluesmith/codev/pull/1693), Fixes #1686. Branch pushed.
CMAP --type pr: gemini=APPROVE(HIGH), claude=APPROVE(HIGH), codex=REQUEST_CHANGES(HIGH).

codex RC (issue-grounded): guard preserves only when `shellperAlive && socketPresent`, so a
LIVE pid with a TRANSIENTLY-absent socket still gets SIGTERMed — violates #1686's explicit
"a row whose pid is alive is left in place ... never signaled." The issue is internally in
tension (also says "positive evidence of death: pid dead AND/OR socket absent"); the (live-pid,
socket-absent) edge is where they disagree. My code took the AND/OR reading; codex wants
pid-alive→never-signal unconditionally.

Sent architect a ruling request (recommend ADOPTing codex: drop `&& socketPresent`, guard =
`if (shellperAlive)`, add regression coverage for live-pid+socket-absent at both sites; the
"asymmetric evidence" residual goes away, "unbounded retention" grows slightly = accepted).
This changes the guard shape the architect named, so not flipping unilaterally. WAITING.

pr gate is already surfaced (my `porch done --help` fired it — harmless, human-approval-only).
Will NOT send the gate-ready notification until the RC is resolved.

## PR (cont.) — architect RULING: adopt codex, implemented

Ruling: shellperAlive ALONE gates destruction at both sites; socket-file state contributes
NOTHING to the kill decision; pid-down is the sole proof of death (pid-dead rows delete as
before regardless of socket). Implemented: both guards now `if (shellperAlive)` (dropped
`&& socketPresent`). Added 2 regression cases (live-pid + socket-ABSENT) at both sites,
verified non-vacuous (fail under the old socketPresent guard). 65/65 in file, tsc clean.

For the REVIEW artifact (architect-directed):
1. The issue text's internal conflict ("AND/OR socket absent" vs "a live pid is never
   signaled") was MAIN's loose drafting. This ruling resolves it to the invariant: DESTROY
   ONLY WHAT IS PROVEN DEAD; proof = pid down.
2. Accepted residual GROWS: a live socketless orphan now persists until husk-sweep (#1227) or
   stop reaps it — deliberate "leak a row, not a session". The earlier "asymmetric evidence"
   residual is GONE (superseded by the ruling).
Remaining residuals unchanged: PID-reuse (conservative by design), legacy shellper_pid===null
edge (PR-body note), pre-existing 5 env-class test failures (PR-body note).

Next: amend commit, update PR #1693 body, push, re-run --type pr CMAP for codex's answered-in-
code record, then gate notification with fresh verdicts.

PR body must reference: the 5 pre-existing env-class failures (consolidate.test.ts +
spawn-retirement.test.ts — getRolesDir "Roles directory not found" in worktree test env,
confirmed identical on clean base), and the shellper_pid===null legacy edge.

## Coordination
Based on origin/main tip (30e264031) which includes #1687 + #1689 merges (same file
territory: reconcile boot order claim->reconnect->sweep). Building on current main.
