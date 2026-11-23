# PIR Review: Windows session jobs keep everything a session starts; Tower refuses to run inside one

Fixes #1915

## Summary

On Windows, a program left behind by an agent command that timed out (typically a root-wide `find` burning a CPU) kept running after its session ended. The cause: session Job Objects allowed breakaway, and the MSYS runtime behind Git Bash asks for breakaway on every native program it starts. As a result, the agent and all its tool-call processes were never in their session's job. This PR removes breakaway from session jobs, so closing a session or running `afx cleanup` ends everything it started. Because nothing can now leave a session job, Tower refuses at boot to run inside any session's job.

The issue asked for orphans to be listed in `afx status` and `codev doctor`, with a command to end them. By human decision at `dev-approval`, neither shipped: with no breakaway there are no orphans to list or end by hand.

### Course change from the plan

The plan (rev 2) had three parts: drop breakaway, guard teardown so it never ends Tower or another session, and list and end orphans per session. Over `dev-approval` the human made two changes:

1. They dropped the manual ending path (`afx orphans`, `POST /api/orphans/end`), because `afx cleanup` and closing the session already end everything.
2. They dropped the listing and replaced the teardown guard with prevention. Instead of a guard deciding at teardown what may be killed, Tower refuses to run inside any session job, so a session's job never holds Tower or another session's shellper.

The guard went through three CI rounds and each found a real defect (fails open on a failed listing, two cold helpers per teardown, killing job members one by one). Prevention removed that whole class of problem. The plan file still describes rev 2; this section records the change.

### Behaviour change (Windows only)

- Anything started from a Codev terminal on Windows now ends with its session. That includes a GUI program (`code .` when VS Code is not already running) and a background server started with `&`. To keep such a program running after the session ends, start it from outside Codev (a Windows Terminal or PowerShell window). This is documented in `DEPENDENCIES.md`.
- This applies to sessions created after Tower restarts on the new version. A session created before keeps its old job, which still allows breakaway, until it ends.
- Tower started by hand inside a session (not through `afx tower start`) exits with code 1 and a message naming the supported launch paths.
- Tower start-up cost of the refusal check: about **0.6s** with 9 live shellpers on a warm machine; a few seconds cold, while PowerShell starts.
- macOS/Linux: no runtime change (documentation text only).

## Files Changed

- `codev-skeleton/DEPENDENCIES.md` (+11 / -0)
- `codev/DEPENDENCIES.md` (+11 / -0)
- `codev/plans/1915-windows-show-and-end-orphaned-.md` (+326 / -0)
- `codev/projects/1915-windows-show-and-end-orphaned-/status.yaml` (+22 / -0)
- `codev/resources/arch.md` (+8 / -3)
- `codev/resources/lessons-learned.md` (+3 / -1)
- `codev/reviews/1915-windows-show-and-end-orphaned-.md` (new)
- `codev/state/pir-1915_thread.md` (+119 / -0)
- `packages/codev/src/__tests__/helpers/tracked-pids.ts` (+52 / -0)
- `packages/codev/src/__tests__/launchers.windows.test.ts` (+12 / -1)
- `packages/codev/src/__tests__/session-job-containment.windows.test.ts` (+153 / -0)
- `packages/codev/src/__tests__/tower-lifecycle.windows.test.ts` (+13 / -1)
- `packages/codev/src/__tests__/windows-job.test.ts` (+17 / -1)
- `packages/codev/src/__tests__/windows-job.windows.test.ts` (+59 / -15)
- `packages/codev/src/agent-farm/__tests__/tower-stop-windows.test.ts` (+32 / -1)
- `packages/codev/src/agent-farm/commands/windows/tower-lifecycle.ts` (+50 / -4)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+17 / -2)
- `packages/codev/src/lib/platform/windows/job-objects.ts` (+47 / -10)
- `packages/codev/src/lib/platform/windows/process-tree.ts` (+4 / -4, comments only)

What each change does:

- **`job-objects.ts`**
  - Session job limit flags change from `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (`0x800`) to `0`. This is commit `6b7f81940`, kept alone so it can be reverted by itself.
  - The helper gains a read-only `in-job` request (`IsProcessInJob` against a named job).
- **`tower-lifecycle.ts`**
  - `sessionJobNamesToCheck` returns the job named by the session marker, plus the job of every live shellper found in the process census.
  - `towerSessionJobRefusal` checks Tower's pid against each of those jobs.
- **`tower-server.ts`**: runs that check once at Windows boot. If Tower is inside a session job, it logs an ERROR, stops the helper, releases the owner lock and exits with code 1. If the census fails, it logs a WARN and checks only the marker's job.

## Commits

Implementation commits on top of the merge-base (porch bookkeeping and thread-only commits omitted):

- `6b7f81940` [PIR #1915] Session jobs allow no breakaway
- `5c06db9bf` [PIR #1915] Keep Tower and other sessions out of a session's teardown
- `74419b02a` [PIR #1915] Show and end orphaned processes per session (Windows)
- `9f69b1568` [PIR #1915] Never list a console host; real-session Windows tests
- `e3546f923` [PIR #1915] Mirror the afx skill into the Codex trees; regenerate skill hashes
- `148092136` [PIR #1915] Drop the manual ending path: orphans end with their session
- `4f4a5fca2` [PIR #1915] Teardown guard fails closed; one job listing, one helper per teardown
- `67015c575` [PIR #1915] Guarded teardown ends only the root's tree; tests kill only their own pids
- `aad9c00a1` [PIR #1915] Prevent instead of guard: Tower refuses to run inside any session job; drop the listing
- `3b4066839` [PIR #1915] windows-job.windows: never terminate a job holding the test worker or its parent
- `72e0e2f42` Merge remote-tracking branch 'origin/main' into builder/pir-1915 (clean; only `arch.md` changed on both sides and auto-merged)

`aad9c00a1` reverts the listing, the API, `afx orphans` and the teardown guard back to `main`'s code, so the net diff is the file list above.

## Test Results

- Build: ✓ pass (after the merge with `origin/main`)
- Local full suite (Windows 11, Node 22, on `aad9c00a1`): **8135 passed, 0 failed**. The main Tower kept PID 53132 before and after.
- Local after the merge: every test file this branch changed, plus the tests merged in from `main` (air-1893, bugfix-1910, bugfix-1952): 109 passed, 7 skipped, 0 failed.
- Windows CI on the merged code:
  - Full run **https://github.com/cluesmith/codev/actions/runs/45276143657** (suites), green after one re-run of the Node 24 unit job (see Flaky Tests: Phase 4(b)).
  - Targeted `.windows.` run **https://github.com/cluesmith/codev/actions/runs/45279040879**: 9 files passed, 1 skipped; all probes green.
- Windows CI before the merge: two consecutive fully green runs on `3b4066839`, https://github.com/cluesmith/codev/actions/runs/45142055516 and https://github.com/cluesmith/codev/actions/runs/45143011938.
- New tests:
  - `session-job-containment.windows`:
    - Closing a real session ends a leftover whose parent exited, while a process started outside the session survives.
    - Tower started inside a session refuses to run, with the marker set and with it cleared (exit 1 plus the log line).
  - `windows-job.windows`: a native program started by Git Bash stays in the job and ends with it. This test fails with the old flag.
  - Unit tests:
    - Flag values and the `in-job` request.
    - The helper program fits under the 32,767-character command line (it encodes to 21,076).
    - `sessionJobNamesToCheck` and the refusal.
- Real-session check (manual, scripted): an isolated Tower started through CIM from inside a session, in a throwaway workspace, with a real Claude architect and builders (haiku). **17/17**:
  - `claude.exe` and a timed-out `find.exe` whose parent was gone both ran inside the builder's job.
  - Both `afx cleanup` paths ended the builder, its orphaned `find` and its whole tree: Tower killing the terminal, and, with Tower down, killing the shellper by worktree.
  - The architect and Tower survived.
  - A Tower restart kept the architect's shellper, and a new session worked afterwards.
  - The main Tower was untouched.
- Survey of programs started inside a job with no breakaway: git, gh, node→cmd, cmd, powershell, python, codex, code and `claude --version` all ran normally, as did a real `claude -p` tool call. **No program was found that needs to leave the job.**
- **Untested:**
  - agy (not installed on this machine).
  - Codex running as a full agent session (only `codex --version` was run).
  - Browsers launched by Playwright or `start <url>` from a session. This includes the dashboard browser that `afx workspace start`, `afx attach` and `afx tower cloud login` open through `openBrowser` (`agent-farm/utils/shell.ts`).
  - GUI apps launched from a terminal, beyond `code`, which was surveyed.

  These come from the plan's risk list. Any of them failing would be a reason to revert `6b7f81940`.

### CI evidence trail (all judged pre-existing)

1. **Test worker death**
   - Run 45133587326 (`aad9c00a1`), Node 22 unit: every test that ran passed, plus one unhandled "Worker exited unexpectedly".
   - It happened in `windows-job.windows.test.ts`, during "a stopped helper (Tower restart) does not kill a job member". That test is unchanged from `main` and terminates a job holding only its own idle child.
   - Precedent: spir-1658 run 39927082964 (Node 22), a dead worker in `agy-lane-model.test.ts`. #1923 lists the symptom.
   - To rule out the worker being inside a job being ended: `terminateChecked` (`3b4066839`, kept permanently) checks in-job for the worker and its parent before each of the file's 6 terminates, logs `JOB-WORKER-CHECK`, and throws if either is a member.
   - Results of that check:
     - Locally, 32 runs of the file all passed; 384 checks, all `member=false`.
     - In CI, every later run logged 12 checks per job, with 0 `member=true` and 0 worker deaths.
2. **Lost runner**
   - Run 45135042446 (`3b4066839`), Node 22 unit: "The hosted runner lost communication with the server", 07:59→08:47 (48 min).
   - The same signature, about 47 minutes against a normal 5–7, appears on spir-1658 Node 22 unit runs 42547114468 (22:52→23:39) and 42715696142 (01:44→02:31).
   - The architect accepted it as a pre-existing Node 22 runner pattern.
3. **Tower lifecycle Phase 4(b)**: see Flaky Tests.

## Architecture Updates

COLD `codev/resources/arch.md`, Platform Layer section:
- Session jobs allow no breakaway (#1915, reversing Spec 1658 Phase 3b ruling (c)), and why: MSYS requests breakaway for every native program.
- Tower refuses to run inside any session job; `afx tower start` creates it outside through CIM.

Nothing went to the HOT tier. The fact is Windows-only, and the hot file is for cross-cutting facts that change behaviour.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`:
- **Architecture:** a job that allows breakaway loses everything Git Bash starts. Measure the job membership of a real session before trusting "the job holds the session". (Appended to the #1658 `detached`-is-not-`setsid` lesson.)
- **Testing:** a test cleanup that kills every recorded pid can kill an unrelated process, because Windows reuses pids quickly. Kill a recorded pid only if the live process was created no later than the recording (`__tests__/helpers/tracked-pids.ts`). vitest 4 ignores `poolOptions.forks.singleFork`, so test files run in parallel workers, and one file's cleanup can run inside another file's assertions.

## Things to Look At During PR Review

- **The refusal check at boot** (`tower-server.ts`, `towerSessionJobRefusal`):
  - It checks every live shellper's job, not only the marker's, because a Tower launched with the marker cleared would otherwise go undetected. A test covers that case.
  - It degrades rather than blocking boot. If the census fails, only the marker's job is checked. A shellper job that no longer exists (`found: false`) is not a refusal. Neither is a helper error on a job (`ok: false`): the check fails open, so it can never stop Tower from booting by mistake, at the cost of possibly missing a Tower that really is inside a session job.
- **Commit `6b7f81940` stands alone** so it can be reverted if a program turns up that must leave the job. Agy and Codex as full sessions are the untested candidates.
- **Session marker in two test harnesses**: `tower-lifecycle.windows.test.ts` (`towerStartEnv`) and `launchers.windows.test.ts` (`envFor`) keep `CODEV_SHELLPER_SESSION` only for `tower start`. That makes afx use CIM, as it does for a real user inside a session; every other command still runs without the marker.
- **Audit of pid kills in tests** (architect request): I checked every new or touched test file for cleanup that kills recorded pids without checking identity.
  - `windows-job.windows` and the since-removed `session-orphans.windows` had that pattern; both now use `tracked-pids`.
  - The rest use fakes, mocks, or kills that check identity.
  - Untouched by this PR, two files still use the unchecked leftovers pattern: `process-tree.windows.test.ts:75` and `tower-lifecycle.windows.test.ts:64`. A follow-up should move them to `tracked-pids`. Not done here at the architect's direction, because one of them is the flaky Phase 4(b) test's own file.

### Consultation (single pass)

Verdicts:
- **Claude:** COMMENT, high confidence.
- **Codex:** COMMENT, low confidence. Its sandbox rejected every file read, so it reviewed no code.
- **Gemini:** COMMENT, skipped. agy is not installed here.

Disposition of Claude's findings:
1. **The always-on flag test could pass with `0x800`.** Fixed. `windows-job.test.ts` now matches the whole line `$SESSION_JOB_LIMIT_FLAGS = 0` and rejects `= 0x…`. It is the only check of the flag that runs on the Linux PR CI, because `.windows.` tests skip themselves there.
2. **`process-tree.windows.test.ts:75` is the suspected killer in the Phase 4(b) flake.** Not changed in this PR; it is a pre-existing test outside this change. I proposed moving it to `tracked-pids` to the architect, as this PR or a numbered follow-up issue; their call.
3. **`openBrowser` starts a browser inside the session.** Documented: `DEPENDENCIES.md` (both trees) now names the dashboard browser that `afx workspace start`, `afx attach` and `afx tower cloud login` open. It ends with the session if no browser was already running. Launching it through CIM is a possible follow-up.
4. **The untested list was narrower than the plan's risks.** Fixed; see Test Results.
5. **Nits.**
   - The `tracked-pids` comment now states the 1s clock slack.
   - The `arch.md` line wrap is fixed.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1915 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1915`
- **What to verify** (Windows):
  - Run `pnpm exec vitest run .windows.` in `packages/codev`.
  - In a Codev session, start a long-running native program from Git Bash and let its parent exit (e.g. `(find / -name x >/dev/null 2>&1 &)`). Close the session (or `afx cleanup`) and confirm the program is gone.
  - From inside a session, start Tower plainly (`node dist/agent-farm/servers/tower-server.js <port>`). It should exit 1 with the refusal message. `afx tower start` should still work.

## Flaky Tests

All pre-existing; each was left running, not skipped.

- **`packages/codev/src/__tests__/tower-lifecycle.windows.test.ts:510`, Phase 4(b)**, "Tower N died with the session job".
  - Seen on run 45276143657, Node 24; passed on re-run.
  - Before teardown, Tower 2136 was not in the launcher's job (`inJob=False`, created through CIM, parent = WMI). Its log ended normally with no shutdown or refusal line, so it was ended from outside.
  - Likely cause: `process-tree.windows.test.ts:75`'s unchecked `afterAll` SIGKILLs every pid it recorded. Those were all confirmed dead mid-test and so free for reuse. That file finished at 22:09:00.87, after the pre-teardown check (22:08:59.41) and before the assertion (about 22:09:01.5). Unproven, because that file doesn't log its pids.
  - This branch cannot put a CIM-created process into a session job:
    - A process joins a job only through its creator or an explicit assign, and the helper assigns only shellpers it just spawned.
    - The no-breakaway flag only stops members from leaving.
    - The boot check passed, so Tower was in no session job at start-up.
  - History in `windows.yml` (141 runs scanned): spir-1658 39657896647 and 39907783124 (the "once in nine runs" note), bugfix-1922 44237325105 (commit `e034d9b94`, now on `main`, without this branch's code), and this branch 45100689541 (an earlier teardown-guard design) and 45276143657. So it fails without this branch.
- **`packages/codev/src/agent-farm/__tests__/launch-loop-exit-code.test.ts:94`**, "still auto-restarts after a crash": failed once in a full local run under load, passed 3/3 alone (#1923 family).
- **Test worker death** in `windows-job.windows.test.ts` (Node 22, run 45133587326): see the evidence trail above (#1923 family).
- **`tower-lifecycle.windows` scenario 5**: `afx tower stop` exited 0xC0000142 (DLL init failed) once, on Node 24, run 45093824937. **pir-1233-session-launch-loop** (Git Bash launch failed) failed on the same run. Both passed on Node 22 and on later runs.
