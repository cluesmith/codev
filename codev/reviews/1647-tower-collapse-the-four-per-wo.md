# Review: Collapse the four per-workspace overview forge calls into one bundled call

## Summary

A new forge concept, `overview-bundle`, returns all four forge-backed overview sections (open PRs,
open issues, 24 h closed issues, 24 h merged PRs) from one invocation. Its GitHub script sends one
`gh api graphql` request and pages inside the same invocation up to today's caps. `OverviewCache`
uses it per workspace when configuration allows, and otherwise makes the four calls exactly as
before. A new `overview-budget.ts` owns the overview TTLs and `projectHourlyForgeCalls`, and
`codev doctor` prints the resolved mode, its reason and the projected calls per hour.

The work was four phases, each committed and consulted: the concept and script, mode resolution
with the projection and doctor, the cache's bundle path, and adopter docs. Per watched workspace
per idle hour on GitHub, concept invocations fall from 52 to 20. `gh` processes fall from 52 to 40
on a repository with more than 100 open issues, and to 20 on a smaller one. HTTP requests fall from
72 to 40 and points from 112 to 100. The live check on this repository measured 5 points per
refresh against 7 for the four calls.

## Spec Compliance

- [x] One forge invocation per refresh window on default GitHub config, plus the unchanged hourly
      `user-identity`, with one more after the TTL. One `gh` process per invocation with 100 or
      fewer open issues, two with more. (Phase 1 script tests; Phase 3 cache process-count tests;
      Phase 3 live check: 1 invocation = 2 `gh` processes on this repository)
- [x] `projectHourlyForgeCalls`: bundled 20/60, four-call 52/132, 46/126 with `recently-merged`
      disabled, 32/72 with `issue-list` disabled. It reads the same constants the cache uses, and
      tests pin the cache refetching at exactly those constants. (Phase 2, plus bundled
      counterparts in Phase 3)
- [x] `codev doctor` lists `overview-bundle` with its source and executable (`gh`). It prints the
      mode, the reason (including the bundle-override bypass disclosure) and the projection, e.g.
      `- overview  bundled — 20 forge calls/h idle, 60 under constant invalidation`. (Phases 1–2)
- [x] `OverviewBundleResult` is a named contract type in `forge-contracts.ts`, documented with its
      input and four keys. Malformed output (not JSON, not an object, missing key, wrong section
      type) is a whole-bundle failure. It is negatively cached, and its reason is named on every
      poll of the failure window. (Phase 1 type; Phase 3 enforcement)
- [x] Section parity with the four sibling concepts on a recorded state: bot author (`app/…`), no
      review decision, team reviewers dropped, labels, multiple assignees, plus an end-to-end
      identical `OverviewData` in both modes. Search qualifiers are covered by the exact-string
      argument test, by a recording made by real GitHub, and by the live check; a fake `gh`
      cannot filter. (Phase 1, recorded from grafana/grafana; Phase 3 end to end and live)
- [x] Pagination: with more than 100 open issues, 200 newest first and never a third page. A
      search pages up to 1,000, with a hard stop at page 10. (Phase 1)
- [x] Failure classification: search-path-only errors null that section and exit 0. A path-less
      error, a list-path error, mixed errors or a rate limit fails the whole bundle. A failed
      search page 2 nulls that section, and a failed issue page fails the bundle. A bundle with a
      `null` section is positively cached for the full TTL, with `forgeStatus: 'unavailable'`.
      (Phase 1 script; Phase 3 cache)
- [x] Rate limit: negative entry and blank sections for the failing workspace. The budget is
      suspended, `forgeResetAt` is set, the `errors.prs`/`errors.issues` texts match, and no
      constituent runs. A second workspace's within-TTL bundle is served without a fetch. The
      #1645 harness, re-pinned, gives 40 polls at 2.5 s = one bundle + one identity call. (Phase 3)
- [x] Timeout, tested in two parts as the plan set out. The 60 s / 40 MiB limits are asserted on
      the dispatcher call. Under a short limit the script settles promptly, kills the in-flight
      `gh` and leaves no temp files. A timed-out bundle is a whole failure, negatively cached,
      with no constituent spawned. The suite never waits 60 s. (Phases 1 and 3)
- [x] gitlab, gitea, linear and jira presets disable `overview-bundle` and make the four calls.
      (Phases 1–2)
- [x] Overriding or disabling any constituent on GitHub: four calls, and the override runs.
      (Phases 2–3)
- [x] `overview-bundle: null`: four calls. (Phase 3, including the #1645 four-call twin)
- [x] An `overview-bundle` override, even on gitlab, runs once per window and feeds all four
      sections. (Phase 3)
- [x] Security: fixed query texts. `CODEV_SINCE_DATE`, owner/repo and cursors travel only as
      GraphQL variables, with cursors through `-f`. Hostile strings round-trip byte-identical,
      and a malformed `CODEV_SINCE_DATE` is rejected before any `gh` runs. (Phase 1)
- [x] `/api/overview` shape unchanged, key set included. The existing overview, rate-limit and
      #1645 tests pass. They are re-pinned only where the call count is under test, with the
      four-call variant kept. (Phase 3)
- [x] All four concept-enumerating docs describe `overview-bundle`, and the stale "18 concepts"
      counts are corrected to 21. (Phases 2 and 4)
- [x] Windows (Git Bash), corrected in PR round 2. The first two runs (45952952774, 45954554101)
      were green but ran none of the script tests: both files were gated off win32. With the
      gates on `jq` alone, `windows.yml -f filter=spec-1647` ran them under Git Bash. Its first run
      found a CRLF bug in the search classification, fixed in ea435efc3. The re-run
      [45956770907](https://github.com/cluesmith/codev/actions/runs/45956770907) passed: all 5
      cache end-to-end tests and 36 script tests, with 14 POSIX-only or shim tests skipped by
      design. Not pinned on Windows: the timeout kill and temp cleanup (a Windows kill delivers
      no catchable signal, as the script documents) and the hostile-string round trip.
      (Review)
- [ ] Verify-phase item, still open by design: a browser check of the Work view on the
      architect's install.

## Deviations from Plan

- **Phase 1.**
  - Every `jq` reads through shell redirection rather than a path argument, because the forge
    layer turns MSYS path conversion off and a native Windows `jq` cannot open `/tmp/…`. This
    replaces the `--slurpfile` assembly first written.
  - Two review fixes add guards the plan did not have: search paging stops at page 10, and a
    `hasNextPage` with no cursor fails the bundle.
  - The search type stays `ISSUE` as planned, although `gh` itself sends `ISSUE_ADVANCED`. Both
    return identical sets here, and `ISSUE` also works on GHES without advanced search.
  - Adjacent: `forge-windows-launcher.test.ts` gains the new concept.
- **Phase 2.** Doctor separates the reason from the projection with ` — `, not the plan's `:`,
  which read badly next to the reason's own colon. Two cases the plan left open were decided:
  a project `null` wins as the reason over a preset that also disables the bundle, and
  `bypassed` lists overrides before disables.
- **Phase 3.**
  - The suspension arm of `cachedFetch` does not copy `entry.reason`, contrary to the plan: that
    value can only be `undefined` there (review finding).
  - Adjacent typing fix: `mergedPRCache` held `ForgePR[]` although `recently-merged` returns
    `MergedPrItem[]`. With the type corrected, a merged PR without a `url` links nothing in
    either mode.
  - The end-to-end parity test freezes `Date` at the recording instant instead of shifting
    fixture timestamps.
  - The fake `gh` moved to a shared helper, with a lock on its call counter: parallel processes
    raced the counter.
- **Phase 4.** Adjacent fix: `forge.md`'s `codev doctor` sample was stale (a format doctor no
  longer prints) and is replaced with real current output.
- **Live check.** The points comparison uses `rateLimit(dryRun: true)` inside the script's own
  queries. Rate-limit deltas were unusable here, because `X-Ratelimit-Used` alternated between
  two counters.
- **Review.** `main` had moved 35 commits. Its #1844 change added an import on the line next to
  this branch's import in `overview.ts`, so the merge needed one conflict resolved (both lines
  kept). The build and full suite were re-run on the merge commit. The PR review then added two
  script hardenings, a body-only rate limit named on stderr and no cursor check on the last
  page, plus a lock trap in the fake `gh` (see Consultation Feedback). Round 2 moved the script
  tests onto native Windows. That found and fixed a CRLF bug, and it also added the source-only
  plan resolution and the pattern-equality test.

## Consultation Feedback

Consultation ran two lanes, codex and claude, as `.codev/config.json` configures (Gemini is not a
configured lane). No `CONSULT_ERROR` occurred. Per-round dispositions are committed in
`codev/projects/1647-tower-collapse-the-four-per-wo/*-rebuttals.md`.

### Specify Phase (Round 1): both REQUEST_CHANGES

#### Codex
- **Concern**: exact contract undefined → **Addressed**: input, four required keys, `null` meaning, malformed rule.
- **Concern**: search isolation contradicts "preserve gh's exit status" → **Addressed**: an explicit classification rule, named as the one sanctioned exception.
- **Concern**: the projection is not always 52 → **Addressed**: it takes the resolved plan, with per-constituent figures.
- **Concern**: partial-success caching and status undefined → **Addressed**: a `null` section is positively cached, `forgeStatus: unavailable`.
- **Concern**: no security test → **Addressed**: a constraint plus hostile-string and variables-only criteria.

#### Claude
- **Concern**: bundle time limit unspecified → **Addressed**: 60 s / 40 MB, with the residual risk recorded.
- **Concern**: constraints contradict the failure semantics → **Addressed**: same fix as codex 2.
- **Concern**: parity vs. issues-disabled repositories → **Addressed**: verified and recorded as a named divergence.
- **Concern**: `errors.*` in bundle mode → **Addressed**: both are populated from the bundle outcome.
- **Concern**: doc surfaces not named → **Addressed**: four files, stale counts corrected.
- **Concern**: churn-mode points missing → **Addressed**: churn rows added.
- **Concern**: doctor should disclose a bundle override hiding a constituent override → **Addressed**.
- **Concern**: a "still open" item was a decision → **Addressed**: moved to design choices.

### Specify Phase (Round 2): codex APPROVE, claude REQUEST_CHANGES

#### Claude
- **Concern**: "spawns" conflated invocations with `gh` processes; 40/h, not 20/h, on large repos → **Addressed**: separate columns for invocations, processes, requests and points.
- **Concern**: implicit search qualifiers → **Addressed**: qualifiers named, exclusion cases added.
- **Concern**: nested connection caps → **Addressed**: verified at 100 each.
- **Concern**: search overflow assumption → **Addressed**: stated, with the 20-process worst case.
- **Concern**: issues-disabled also flips `forgeStatus` → **Addressed**.

### Specify Phase (Round 3): both REQUEST_CHANGES

#### Codex
- **Concern**: "stale within TTL" contradicts `dispatch()` nulling the failed entry → **Addressed**: blank on failure made explicit and the regression named.
- **Concern**: 60 s stated as a guarantee → **Addressed**: recast as a sizing rationale.

#### Claude
- **Concern**: same contradiction as codex 1 → **Addressed**: same fix.
- **Concern**: same 60 s point → **Addressed**: same fix.
- **Concern**: isolation relies on unverified `gh` behaviour → **Addressed**: the verification (2026-11-25) was recorded as a constraint.
- **Concern**: "CLI unavailable" text for a `null` list; temp files; churn makes searches invalidation-driven → **Addressed**: all three folded in.

Porch force-advanced at the three-iteration ceiling, so the round-3 fixes (18b1d18fa) were not
re-reviewed. The owner approved the spec as written.

### Plan Phase (Round 1): both COMMENT

#### Codex
- **Concern**: test the search-fidelity exclusions directly → **Addressed**: same as claude 3.
- **Concern**: the malformed reason must flow through types and cached reads → **Addressed**: same as claude 2.

#### Claude
- **Concern**: a trapped TERM is deferred until the foreground `gh` returns → **Addressed**: verified, and the script runs every `gh` in the background with `wait`; a timeout test was added.
- **Concern**: the `malformed` reason is dropped on a within-TTL hit → **Addressed**: carried through `CacheEntry`/`FetchOutcome`.
- **Concern**: search qualifiers covered only indirectly → **Addressed**: the plan states its exact coverage.
- **Concern**: the issues-disabled divergence missing → **Addressed**: tested in Phases 1 and 3, documented in Phase 4.
- **Concern**: duplicate plan types kept compatible only structurally → **Addressed**: `overview-budget.ts` moved to `src/lib` and owns `OverviewPlan`.
- **Concern**: assembly field list, the `query=` flag, and Phase 1's size → **Addressed** (field table, `-f query=`); size **Rebutted**: the phase is cohesive, as the reviewer agreed.

### Phase 1 (Round 1): both APPROVE

#### Codex
- No concerns raised.

#### Claude
- **Concern**: search paging has no hard page cap → **Addressed**: it stops at page 10.
- **Concern**: the `pullRequests` connection read looks like paging → **Addressed**: a comment says it only asserts the shape.
- **Concern**: `hasNextPage` with a null cursor truncates silently → **Addressed**: whole-bundle failure.
- **Concern**: parity compares projections, which is not said → **Addressed**: doc comment and test header.
- **Concern** (FYI): POSIX character classes; a stale comment → **N/A**: a host without them fails loudly; the comment was Phase 2's.

### Phase 2 (Round 1): both APPROVE

#### Codex
- No concerns raised.

#### Claude
- **Concern**: the churn half of the projection is not pinned → **Addressed**: an exact-debounce test, mutation-checked.
- **Concern**: uncovered `describeOverviewPlan` branches → **Addressed**: two rows added.
- **Concern**: the doctor row test uses mocked resolution → **Rebutted**: real resolution is pinned in `forge.test.ts`, and the overview-line tests run the real `resolveOverviewPlan`.
- **Concern** (note): an unreachable `provider === undefined` arm → **Addressed**: comment.
- **Concern** (note): the separator differs from the plan → **N/A**: recorded as a deviation.

### Phase 3 (Round 1): both APPROVE

#### Codex
- No concerns raised.

#### Claude
- **Concern**: `reason: entry.reason` in the suspension arm is always `undefined` → **Addressed**: removed.
- **Concern**: unsound `ForgePR[]` cast in `splitBundle` → **Addressed**: the merged section is typed `MergedPrItem[]` in both modes, with a url guard and a test.
- **Concern** (note): a `null` section during a suspension caused elsewhere shows the rate-limit text → **N/A**: same precedence as four-call mode, by design.
- **Concern** (note): `codev status` also uses `OverviewCache` → **N/A**: that is the overview cache, the intended consumer.

### Phase 4 (Round 1): both APPROVE

#### Codex
- No concerns raised.

#### Claude
- **Concern**: the GitLab sketch ignores `CODEV_SINCE_DATE` → **Addressed**: the sketch says so and says how to use it.
- **Concern**: `grep "18 concepts"` matches `.builder-state.md` → **N/A**: untracked builder scratch, never committed.
- **Concern**: combined doctor reasons not documented → **Addressed**.

### Review Phase, PR #2004 (Round 1): codex REQUEST_CHANGES, claude APPROVE

#### Codex
- **Concern**: the Windows workflow run had not finished → **Addressed**: it passed, and the result is recorded here and in the PR.

#### Claude
- **Concern**: a rate limit reported only in the GraphQL body never reaches stderr, so the budget is not suspended → **Addressed**: `fail_with_gh` names it on stderr in a line the limiter matches; three tests, mutation-checked.
- **Concern**: `invalidate()`'s docstring is stale for bundled mode → **Addressed**.
- **Concern**: the fake `gh`'s lock can leak and hang a test → **Addressed**: a trap set only while the lock is held. The suggested whole-script `EXIT` trap would race with other processes' locks.
- **Concern**: the last issue page's cursor check can fail a healthy bundle → **Addressed**: issue page 2 and search page 10 skip `pageInfo`; one test, mutation-checked.
- **Concern**: the Windows run was in flight → **Addressed**: same as codex.
- **Concern**: a "future-dated" fixture note → **Rebutted**: all dates are UTC, and it was 2026-11-27 UTC.

### Review Phase, PR #2004 (Round 2): both REQUEST_CHANGES

#### Codex
- **Concern**: the re-dispatched Windows run had not finished → **Addressed**: superseded by claude's finding below.

#### Claude
- **Concern**: the Windows runs never executed `overview-bundle.sh`, because both script test files skipped on win32 → **Addressed**: correct. The tests are now gated on `jq` alone and run under Git Bash, except four POSIX-only pieces that skip by name; a targeted Windows run executes them. The earlier `[x]` claim was wrong and has been corrected. The first real Windows run then found a bug. With both searches failed, `jq.exe`'s CRLF left `closed\r`, which matched no section, so a search-local failure became a whole-bundle failure. The script now decides by `jq -e` exit status and reads cursors with `-j`. A CRLF `jq` shim pins this on POSIX; both shim tests fail against the old script.
- **Concern**: `overviewPlan()` reads every concept script on every poll → **Addressed**: a source-only resolver with no file I/O.
- **Concern**: the rate-limit pattern is duplicated with nothing pinning it → **Addressed**: a test holds the script's ERE equal to the limiter's regex; mutation-checked.
- **Concern**: a retired `search(type: ISSUE)` would fail the whole bundle → **Addressed** as a follow-up item (no code change; a path-less error stays a whole failure by the spec's rule).
- **Concern**: unbounded lock spin; stale commit in the PR body → **Addressed**.

### Review Phase, PR #2004 (Round 3): codex REQUEST_CHANGES, claude APPROVE

#### Codex
- **Concern**: the branch was 10 commits behind `main`, and the suite evidence predated them → **Addressed**: merged cleanly (963ba5d97, AIR #1977; no forge or overview file touched), then the root build and the full suite were re-run on the merge.

#### Claude
- Re-verified both round-2 blockers against the files and approved.
- **Concern**: `fail_with_gh` greps stderr twice → **N/A**: cosmetic.
- **Concern**: the named rate-limit line is added only when stderr is silent → **N/A**: the intended contract, pinned by three tests.
- **Concern**: could not verify that the later commits are docs-only → **Addressed**: checked with `git diff --stat`.
- **Concern**: the Work view browser check is still open → **N/A**: scheduled for verify.

## Lessons Learned

### What Went Well

- **Measuring before writing.** Capturing what `gh` actually sends (`GH_DEBUG=api`) and reading
  its JSON export code turned up the three facts the mapping depends on: bot reviewers dropped,
  `app/<login>` authors, `ISSUE_ADVANCED`. Checking those against fixtures afterwards would not
  have found them.
- **Real recordings on both sides of every parity test.** The bundle and the four sibling
  commands were recorded back to back through a tee'ing shim and checked equal before trimming,
  so parity is against GitHub, not against a guess.
- **Mutation checks on every new guard.** Each phase broke its own guards on purpose: the trap
  without kill, the rate-limit check, the bot prefix, the 24 h filter, the null-section text,
  the debounce constant. Each break turned exactly the expected tests red, so none of the new
  tests passes vacuously.
- **Building bottom up.** Phase 3, the only change a running Tower sees, was about 100 lines of
  `overview.ts`, because the script, the plan resolution and the projection were already in
  place and tested.

### Challenges Encountered

- **The issue named code that is not on `main`.** `servers/overview-budget.ts` and
  `projectHourlyForgeCalls` existed only on an abandoned #1645 branch. The architect ruled to
  build them here (D1).
- **Cost units.** The first spec drafts used "spawns" for both concept invocations and `gh`
  processes. On this repository that overstated the process saving (52 → 20 claimed, 52 → 40
  real). Splitting the tables into four units fixed it.
- **Timeouts and POSIX signals.** Node's `exec` timeout signals the shell only, and `sh` defers a
  trapped signal until a foreground child returns. Running each `gh` in the background with
  `wait`, staging output to files, was the fix, verified on bash-as-sh and dash.
- **Windows `jq` paths.** With MSYS path conversion off, a native `jq` cannot open `/tmp/…`. Every
  read therefore goes through shell redirection.
- **Measuring points.** Rate-limit headers were unreliable, so costs were measured with
  `rateLimit(dryRun: true)` inside the real queries.
- **Windows evidence that was not evidence.** The first two Windows runs were green, but every
  script test had skipped there. Once the tests ran under Git Bash, they found a CRLF bug in the
  search classification on the first try (see Consultation Feedback, PR round 2).

### What Would Be Done Differently

- Read the test gates before citing a platform run. The first two Windows runs were green but
  skipped every Spec 1647 script test, and the PR claimed Git Bash coverage on their strength
  until the second PR review caught it.
- Grep `main` for every symbol and path an issue names before drafting the spec, and raise the
  missing ones in the first message to the architect, not after a draft.
- Define the cost units (invocations, processes, requests, points) in the spec's first draft.
  The second spec round was largely spent separating them.

### Methodology Improvements

- When porch force-advances specify at the iteration ceiling, the last round's fixes go to the
  gate unreviewed. A single-lane check of just that diff before the gate would close the gap
  cheaply.
- The Review phase prompt could ask the builder to check mergeability with `main` before opening
  the PR. Here a 35-commit drift with a conflict surfaced only because it was checked by hand.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md` Forge section: the concept list corrected from "18" to
  the 21 in `KNOWN_CONCEPTS`, plus a paragraph on how the overview fetches. It covers the bundled
  and four-call modes, `resolveOverviewPlan()`'s configuration-only rule, the presets that disable
  the bundle, blank-on-failure, and `overview-budget.ts` as the owner of the TTLs and the
  projection. (Phase 4, 208b6d116)
- Hot tier: no change. The bundle is forge-subsystem detail with no cross-cutting invariant a
  builder must know before any task, and `arch-critical.md` is at its cap.

## Lessons Learned Updates

- Routed: cold — Architecture — a forge script run under a time limit must run its child in the
  background and `wait`, because Node's `exec` timeout signals only the shell and POSIX `sh` defers
  a trapped signal until a foreground command returns.
- Routed: cold — Debugging and Root Cause Analysis — `gh api graphql` expands `{owner}`/`{repo}`
  only in `-F` fields (with `-f` a search returns zero results with exit 0). Cursors go through
  `-f`. It exits 1 on any GraphQL error with partial data on stdout.
- Routed: cold — Debugging and Root Cause Analysis — measure GraphQL point costs with
  `rateLimit(dryRun: true)` in the query, not rate-limit deltas.
- Routed: cold — Testing — a Windows CI run is evidence only for the tests that actually ran
  there. Read the tests' skip gates (and the run's report) before citing a green run for a
  platform claim.
- Routed: cold — Architecture — a POSIX script that runs on native Windows must not parse
  `jq`'s text output: `jq.exe` writes CRLF and Git Bash strips only the last line ending of a
  capture. Decide with `jq -e`, print with `-j`, and pin it with a CRLF `jq` shim.
- Hot tier: no change. `lessons-critical.md` is at its cap of 10, and these three are narrow to
  forge scripts and `gh`. The "issue names code that is not on main" lesson is already covered by
  the hot lessons on checking existing work and verifying claims against the actual file.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- #1650 (scope overview invalidation to forge-visible events). Under constant invalidation the
  bundle refreshes the searches 60 times an hour instead of 6, so the points saving disappears
  until #1650 lands. Invocations, processes and requests still fall.
- If points ever matter more than contract simplicity, Approach 2 (a sections input that keeps
  the searches on 600 s) adds onto the same concept. If blanking all four sections on a
  whole-bundle failure proves too costly, Approach 3 or stale-if-error are the named remedies.
  Neither is needed now.
- If GitHub ever retires `search(type: ISSUE)`, the enum error carries no `path`, so the bundle
  fails whole and all four sections blank, not only the two searches. `gh` itself already sends
  `ISSUE_ADVANCED`. Worth an issue so that day is diagnosable; the fixture README records the
  rationale for `ISSUE`.
- Verify phase: the browser check of the Work view on the architect's install (it needs a Tower
  restart, which needs the owner's permission), and the real-`gh` smoke on the merged build.
