# Spec 1647, plan iteration 1: disposition of review findings

Both lanes returned COMMENT with HIGH confidence. Every finding was accepted, and none is
rebutted. Claude's timeout finding changed the script design; I verified it against the code
before acting on it.

## codex

| # | Finding | Disposition |
|---|---|---|
| 1 | Test the search-fidelity exclusions directly: a closed PR not in `recentlyClosed`, a closed-unmerged PR not in `recentlyMerged` | **Accepted.** Same as claude 3. |
| 2 | Malformed-reason flow through types and cached reads | **Accepted.** Same as claude 2. |

## claude

| # | Finding | Disposition |
|---|---|---|
| 1 | Timeout exit path: a trapped TERM is deferred until the foreground `gh` returns | **Accepted, verified, and the design is changed.** On POSIX, `execShellString` is Node's promisified `exec` (`platform/posix/command-launch.ts`), whose timeout sends SIGTERM to the shell alone. POSIX `sh` runs a trap only after the foreground command completes. Every `gh` now runs in the background and the script `wait`s for it. `wait` returns at once on a trapped signal, so the HUP, INT and TERM traps kill the in-flight `gh` and exit through the `EXIT` cleanup. A new timeout test (fake `gh` sleeps 10 s, `timeoutMs: 500`) asserts a prompt settle, a dead `gh` pid and an empty `TMPDIR`. The script gets a comment on why it stages to files, and the native-Windows kill (no catchable signal, so the temp directory is left in `TMPDIR`) is documented as accepted. Risk-table row added. |
| 2 | The `malformed` reason must reach `FetchOutcome`; the within-TTL cache hit drops it | **Accepted.** `OverviewFetchResult` (`ForgeCommandResult` plus `malformed?`) is named. `CacheEntry` and `FetchOutcome` both carry `reason`. `dispatch` stores it and returns it; `cachedFetch` copies it on the within-TTL and suspension paths. The cache test now asserts the text on later polls inside the failure window, not only the first. |
| 3 | The search-qualifier criterion is covered only indirectly | **Accepted.** The plan now says plainly that a fake `gh` cannot test qualifier filtering, and states the whole coverage: (1) an exact-string argument test; (2) a recording made by real GitHub that contains the excluded cases (merged PRs, which are closed PRs, absent from `closed`; a closed-unmerged PR absent from `merged`); (3) the same checks in the live run. Risk row added. |
| 4 | The issues-disabled divergence (Desired State item 5) is missing | **Accepted.** Phase 1 states the mapping (an empty connection gives `issues: []` and `recentlyClosed: []`) and tests it. Phase 3 adds a cache row: empty backlog, no `errors.issues`, `forgeStatus: 'ok'`. Phase 4's `forge.md` documents the change for adopters. |
| 5 | `OverviewFetchShape` and `OverviewPlan` are kept compatible only structurally | **Accepted.** The budget module moves to `packages/codev/src/lib/overview-budget.ts` and owns `OverviewPlan` and `OVERVIEW_CONSTITUENTS`, declared once; `forge.ts` imports them. The plan says why it departs from the issue's `servers/` path: a `lib` → `servers` import would run backwards. `OverviewFetchShape` is gone. |
| 6a | Assembly field list incomplete | **Accepted.** There is now a per-section field table matching each sibling script's `--json` list. |
| 6b | Which flag carries `query=` | **Accepted.** `-f query=`, never type-converted, asserted in the argument-guard test. |
| 6c | Phase 1 is the heaviest phase | **Noted.** It stays one phase. The reviewer agrees it is cohesive and independently committable. |
