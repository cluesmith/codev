# Review (PR #2004), iteration 2: dispositions

codex: REQUEST_CHANGES (HIGH), again only because Windows run 45954554101 had not finished.
claude: REQUEST_CHANGES (HIGH), on one finding that was new and correct: the Windows runs never
executed `overview-bundle.sh`. All five of claude's items were acted on, and none is rebutted.

## codex

| # | Finding | Disposition |
|---|---|---|
| 1 | Windows run 45954554101 for 43573c098 still in progress | **Addressed.** Superseded by claude 1: that run, like 45952952774, could not have exercised the script. See claude 1 for the targeted run that does. |

## claude

| # | Finding | Disposition |
|---|---|---|
| 1 | The Windows evidence does not exercise `overview-bundle.sh`: both script test files were gated on `posixWithJq` (`process.platform !== 'win32' && …`), the launcher test mocks `child_process`, and the probe job runs no forge script | **Verified and fixed.** The finding is correct; my `[x] Windows (Git Bash)` claim was wrong. Both files are now gated on `jq` alone (`withJq`), with a 120 s budget on win32 (Git Bash emulates fork, as #1137 measured). Native Windows therefore runs the user path: the real `OverviewCache`, the dispatcher, Git Bash and the script. That covers parity on the recorded state, process counts and paging, the argument guards, classification, rate-limit forwarding, and the cache end to end. Four POSIX-only pieces skip on win32, each with its reason in the file: the direct `/bin/sh` runs (Node cannot spawn `/bin/sh` there), the hostile cursor (its `"` is in a route file name, which NTFS forbids), and the signal-based timeout test (the script documents that a Windows kill delivers no catchable signal). The targeted run is `windows.yml -f filter=spec-1647`. Its first run, [45955987403](https://github.com/cluesmith/codev/actions/runs/45955987403) on 7864b9ab8, failed one test, `errors on both searches: both null`, and so found a real bug. A native `jq.exe` ends lines with CRLF, and Git Bash strips only the last one from a capture, so the two failed search names came back as `closed\r` and `merged`. `closed\r` matched no section, `closed_ok` stayed true, and the script then read the null search and failed the whole bundle. Fixed in ea435efc3: the classification is decided by `jq -e` exit status, and `read_connection` prints with `-j`. A CRLF `jq` shim pins the fix on POSIX; both shim tests fail against the old script. The re-run, [45956770907](https://github.com/cluesmith/codev/actions/runs/45956770907) on ea435efc3, passed. All 5 cache end-to-end tests passed under Git Bash, 36 of the script tests passed, and 14 skipped by design (the POSIX-only pieces, plus the shim tests, which Windows covers with the real `jq.exe`). The review doc and PR body now state what each Windows run did and did not cover. |
| 2 | `overviewPlan()` on every poll reads all ~21 concept scripts through `resolveAllConcepts` → `extractExecutable`, then discards the executables | **Fixed.** A private `resolveConceptSources()` resolves each command and its source with no file I/O. `resolveAllConcepts()` adds the executables on top, with the same semantics as before, and `resolveOverviewPlan()` uses the source-only half. The doctor, forge and plan tests pass unchanged. No test pins the absence of the reads. |
| 3 | `RATE_LIMIT_PATTERN` is duplicated between the script and `forge-rate-limit.ts` with nothing holding them equal | **Fixed.** `RATE_LIMIT_PATTERN` is exported, and a new test reads the script's assignment, turns its capturing groups into non-capturing ones, and asserts the same source and the `i` flag. Dropping one alternative from the script's copy turns exactly that test red. The test runs on every platform. |
| 4 | If GitHub retires `search(type: ISSUE)`, the enum error has no `path` and fails the whole bundle | **Addressed as a follow-up.** Recorded under Follow-up Items in the review, for the architect to file or not. No code change: a path-less error must stay a whole-bundle failure, which is the spec's classification rule. |
| 5a | Nit: the fake `gh`'s lock spin is unbounded | **Fixed.** After 2,000 attempts it records a violation and exits 97, so the test fails on the violation rather than timing out. |
| 5b | Nit: the PR body's "suite green on 43573c098" is behind the head | **Fixed.** The PR body names the commit the suite ran on. |
