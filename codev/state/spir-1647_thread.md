# spir-1647: builder thread

Issue #1647: collapse the four per-workspace overview forge calls (pr-list, issue-list,
recently-closed, recently-merged) into one GraphQL-backed `overview-bundle` concept.
SPIR, soft mode. Spawned by architect `porchless`.

## 2026-11-25: specify

### Surprises
- **The issue names code that is not on main.** `servers/overview-budget.ts` and
  `projectHourlyForgeCalls` exist only on `archive/bugfix-1645-attempt1`, the abandoned first
  attempt at #1645. The merged fix (PR #1652, the "rebuild lane") put the doctor check out of
  scope. Asked the architect; the answer was to build them here (D1).
- **`gh api graphql -f` does not expand `{owner}/{repo}` inside a value; `-F` does.** With `-f`
  the search silently returns 0 results and exits 0. Captured as a spec constraint.
- `gh api graphql` exits 1 on *any* GraphQL error and prints partial data to stdout, so a naive
  bundle would let a GitHub search outage take down PRs and backlog too. The spec requires
  search-section isolation (per-section `null`).
- This repo has 424 open issues; `issue-list --limit 200` already truncates, and the bundle
  needs a second issue page to keep parity.

### Measurements (2026-11-25, this repo, `GH_DEBUG=api` + `rateLimit(dryRun:true)`)
- Today, per full refresh of the four: pr-list 1 pt/1 req, issue-list 2 pages × 2 pt,
  each search 1 pt/1 req (plus a free cached feature-detection request). That is 7 points,
  5 requests and 4 spawns.
- Candidate bundle: 3 pts for the full first page (PRs 30, issues 100, both searches 100);
  2 pts per extra issue page. Lists-only 2, searches-only 1.
- Per watched workspace-hour at TTLs 180/600 s: spawns 52 → 20, requests 72 → 40,
  points 112 → 100 (large repo); 72 → 60 points (≤100 open issues).

### Decisions (architect, 2026-11-26; the owner can overrule at spec-approval)
- D1 build the TTL/projection module plus the doctor mode line here.
- D2 one bundle at the 180 s list TTL, searches folded in (not a sections input).
- D3 static eligibility (bundle overridden, or no constituent overridden or disabled;
  non-GitHub presets disable it); never fall back to four calls at runtime.
- #1995 is a deliberate copy of #1647. I work #1647 only and leave both issues to the architect.

### Spec review (2-way: codex, claude): three rounds, then force-advanced to the gate
- iter 1: both REQUEST_CHANGES. Exact contract, search-local error classification (resolving
  a contradiction with "preserve gh's exit status"), per-constituent projection, 60 s / 40 MB
  limits, security constraints, named doc surfaces. All accepted.
- iter 2: codex APPROVE; claude REQUEST_CHANGES because "spawns" conflated concept invocations
  with `gh` processes. On this repo (424 open issues) the bundle is 2 `gh` processes per
  invocation, so processes go 52 → 40 (−23%), not 52 → 20. Tables now split invocations,
  processes, requests and points. Also: search qualifiers, nested caps, `forgeStatus` flip on
  issues-disabled repos.
- iter 3: both REQUEST_CHANGES on the same contradiction: "stale-within-TTL served" vs.
  `dispatch()` nulling the failed entry. Made explicit: blank on failure (the per-entry
  mechanism is unchanged; one entry now holds four sections). Named the regression (today the
  searches survive a list failure on their 600 s entries) and the alternatives (stale-if-error,
  Approach 3). Also: the 60 s limit recast as a sizing rationale, and the `gh` 200+errors
  behaviour recorded as verified.
- Porch force-advanced at the 3-iteration ceiling. The iter-3 fixes (18b1d18fa) are **not
  re-reviewed**.

## 2026-11-26: spec approved
- The owner approved spec-approval as written (82d206702), ruled at 22:12 UTC and relayed by
  the architect. I ran `porch approve` (ffd94d2ce). On to Plan; porch requested a context
  refresh at `enter:plan`.

## 2026-11-26: plan drafted (5d6aa4891)
- Four phases, bottom up along the forge layer's seams:
  1. the concept and the GitHub script;
  2. mode resolution, the projection and doctor;
  3. the cache's bundle path;
  4. docs.
- Two choices the spec left to the plan:
  - The cache asks a new `overviewPlan(cwd)` helper in `github.ts`. Existing overview tests
    already mock that module, so they pin four-call mode in one line and remain the kept
    "four-call variant". The bundled default gets its own tests.
  - A bundle splits back into the four per-section outcomes that `getOverview` already
    consumes, so `forgeStatus`, `errors` and all derivation stay untouched. The payload is
    unchanged by construction.
- The 60 s limit is tested in two parts: the value is asserted on the dispatcher call, and the
  existing Spec 1951 dispatcher test already proves that `timeoutMs` kills a hanging tool.
  There is no 60 s wait in the suite.
- Running the plan review: 2-way, codex and claude.

### Plan review (2-way: codex, claude): both COMMENT, every finding folded in (8934609f3)
- The one design change: the 60 s timeout. Node's `exec` sends SIGTERM to the shell only, and
  POSIX `sh` defers a trapped signal until the foreground `gh` returns. So every `gh` now runs
  in the background with `wait`, which returns at once on a trapped signal. The trap then kills
  `gh` and cleans up. A test asserts a prompt settle, a dead `gh` and an empty `TMPDIR`.
- The malformed-output reason now travels through `FetchOutcome` on every cache path.
- The plan states plainly that a fake `gh` cannot test search qualifiers. Coverage is the
  exact-string argument test, a recording made by real GitHub, and the live check.
- The issues-disabled divergence is tested and documented.
- The budget module moved to `src/lib/overview-budget.ts` so that it owns `OverviewPlan` once
  (a `lib` → `servers` import would run backwards).
- Dispositions: `codev/projects/1647-…/1647-plan-iter1-rebuttals.md`.

## 2026-11-26: plan-approval gate reached
- The owner approved plan-approval as written (ruled 2026-11-27 04:41 UTC; relayed by the
  architect from main). I ran `porch approve` (35a845a28). On to Implement Phase 1; porch
  requested a context refresh at `enter:implement`.

## 2026-11-27: Implement Phase 1 (overview-bundle concept + GitHub script)
- Before writing the mapping I captured what gh 2.102 actually sends (`GH_DEBUG=api`) and read
  its JSON export code. Three facts shaped the script:
  - gh queries `reviewRequests` with a `Bot` fragment but exports only `User` and `Team`
    reviewers, so bot reviewers are dropped as well as teams.
  - An author without a user id is exported as `app/<login>` (and a null author as `app/`).
    The recording confirms the spelling: `app/renovate-sh-app`.
  - gh's searches use `type: ISSUE_ADVANCED` (and `last:` for the issue search), not the plain
    `ISSUE` the plan pinned. I compared both types on this repo over 7-day windows: identical
    sets in identical order. So the plan's `ISSUE` stands; it also works on GHES without
    advanced search.
- Windows: the forge layer turns MSYS path conversion off, and jq there is usually a native
  exe, so jq never receives a `/tmp/…` path argument. Every jq reads through shell
  redirection, and the assembly reads one concatenated stream whose page counts the shell
  tracks. This replaces the `--slurpfile` design I first wrote.
- Verified the signal design on bash-as-sh and dash: TERM during `wait` kills the in-flight
  gh, exits 143 and leaves no temp; `sh -c <path>` execs the script on both, so the
  dispatcher's SIGTERM reaches the trap.
- Fixture: this repo has no bot PR, no null review decision, no multi-assignee issue and no
  closed-unmerged PR in its window, so the recording is grafana/grafana (36 h window, which
  also gives a real second page of the merged search). Bundle and siblings were recorded
  back to back through a tee'ing gh shim and checked equal before trimming. Live check on
  this repo: all four sections byte-identical to the sibling scripts.
- Tests: 41 in the new file. Three mutations of the script (trap without kill, rate-limit
  check removed, bot prefix removed) each turn exactly the expected tests red.
- Small adjacent change: `forge-windows-launcher.test.ts` lists every concept, so it gains
  `overview-bundle`.

## 2026-11-27: Implement Phase 2 (mode resolution, spend projection, doctor line)
- `src/lib/overview-budget.ts` owns the four TTL/debounce constants, `OVERVIEW_CONSTITUENTS`,
  `OverviewPlan` and `projectHourlyForgeCalls`. `OverviewCache` imports the constants; the
  failure-window constants stay in overview.ts. No behaviour change: a test pins `pr-list`
  refetching at exactly `LIST_TTL_MS` (not 1 ms before) and `recently-closed` at exactly
  `SEARCH_TTL_MS`.
- `resolveOverviewPlan` (forge.ts) is built on `resolveAllConcepts` sources, with no I/O. Two calls
  the plan left open:
  - When `overview-bundle` is disabled, a project `null` wins as the reason
    (`bundle-disabled`) even on a preset that also disables it.
  - `bypassed` lists overridden constituents first, then disabled ones.
- Doctor line separator: ` — ` between reason and projection, not the plan example's `:`. A
  colon gave "four calls: issue-list overridden: 52 forge calls/h …". Real output on this repo:
  `- overview  bundled — 20 forge calls/h idle, 60 under constant invalidation`.
- doctor.test.ts's forge mock now hands doctor the real `resolveOverviewPlan`, so each doctor
  case is driven by a forge config, not a canned plan. The concept list gains `overview-bundle`
  and its comment is count-free. The two "18 concepts" comments in doctor.ts are count-free too.

## 2026-11-27: Implement Phase 3 (the cache's bundle path)
- `github.ts`: `overviewPlan(cwd)` (a config that fails to load counts as none, so the bundle's
  own dispatch reports the load error); `fetchForOverview('overview-bundle')` passes the 60 s /
  40 MiB limits and `CODEV_SINCE_DATE`, holds the output to the contract (`malformed` names
  what is wrong), drops extra top-level keys, and 24 h-filters both searches.
- `overview.ts`: one `bundleCache` entry through the unchanged `cachedFetch` (`LIST_TTL_MS`,
  list-invalidated), so every #1645 mechanism is reused as is. `getOverview` resolves the plan
  per poll and `splitBundle` turns the bundle outcome into the four section outcomes the rest
  of `getOverview` already reads. `forgeStatus`, `errors` and the derivations are untouched.
- One choice the plan left open: `CacheEntry`/`FetchOutcome.reason` hold the whole phrase
  (`overview-bundle output malformed (<what>)`), built in `dispatch` from the concept name, so
  `describeMissing` stays concept-agnostic. A flagged `null` section is a separate boolean
  (`nullSection`), because its text has no "could not fetch" tail.
- Existing tests: overview.test.ts and overview-rate-limit.test.ts mock `overviewPlan` to
  four-call (one block each, no other change). The #1645 harness is re-pinned: bundled 2, then 3;
  the four-call twin keeps 5, then 9. Its fake `gh` now logs only `$1 $2`, because the bundle's
  query text spans many lines. Phase 2's TTL-coupling tests now pin four-call through a real
  `.codev/config.json`, and gained a bundled counterpart (bundle refetch at exactly
  `LIST_TTL_MS`, and invalidated at exactly `INVALIDATE_DEBOUNCE_MS`).
- Phase 1's fake `gh` moved to `src/__tests__/helpers/spec-1647-fake-gh.ts`, so the end-to-end
  test reuses it. It gained a `user-identity` route and a mkdir lock around its call counter,
  since the cache runs `gh` processes in parallel (the counter's read-increment-write raced).
- Deviation: the end-to-end parity test freezes `Date` at the recording instant
  (`vi.useFakeTimers({ toFake: ['Date'] })`) instead of shifting fixture timestamps. The
  effect is the same, the fixtures are not rewritten, and both modes see one clock, so an
  item at the 24 h edge cannot flip between the two runs.
- Mutation checks, each turning only the expected tests red: drop `reason` on the within-TTL
  path; drop the null-section text; drop the shared suspension in the split; drop the bundle's
  24 h filter; force four-call mode.
- Live check (2026-11-27 ~06:00 UTC): the built `OverviewCache` against real gh on this repo,
  through a logging gh shim, with `GH_REPO` (verified first: it drives `{owner}/{repo}`
  expansion in `gh api graphql` outside a git checkout, so no git remote was needed).
  - Bundle mode: 1 invocation = 2 gh processes, 2 requests (`OverviewBundle`,
    `OverviewIssuesPage`), plus `api user`; 3.2 s. Four-call mode: 5 processes, 8 requests; 1.7 s
    (parallel).
  - Both modes: 7 PRs, 198 backlog, 2 recently closed (both with a merged-PR link),
    `forgeStatus: ok`. `pendingPRs`, `backlog` and `recentlyClosed` are equal between modes, and
    so are the key sets.
  - Qualifiers, on unfiltered output: the window held 2 merged and 0 closed-unmerged PRs. No
    window PR is in `recentlyClosed`, every merged item has `mergedAt`, and both search
    sections equal their sibling concepts' number sets.
  - Points: the rate_limit delta and `X-Ratelimit-Used` headers are unusable here; the header
    alternates between two counters (~281 and ~423) from one request to the next. Measured
    instead with `rateLimit(dryRun: true)` inserted into the script's own query texts:
    `OverviewBundle` 3, `OverviewIssuesPage` 2, `OverviewSearchPage` 1, the spec's measured
    figures. So 5 points per refresh here, against 7 for the four calls.

## Phase 4: adopter docs (2026-11-27)

- `codev/resources/commands/forge.md`: a new "Tower Overview (`overview-bundle`)" section (input,
  the four-key contract and what `null` means, failure semantics, 60 s / 40 MiB limits, cadence,
  the eligibility rule with the override bypass, the presets that disable it, the issues-disabled
  divergence, doctor's reason texts), and an override sketch for GitLab. The hybrid-preset
  sentence and the GitLab/Gitea worked examples now list `overview-bundle` among the disabled
  concepts.
- Adjacent fix: forge.md's `codev doctor` sample was stale (an old "Concept 'x' overridden" format
  doctor no longer prints). It is replaced with real output, captured from the built doctor in a
  scratch gitlab repo with a `pr-merge` override, including the `overview` line.
- The GitLab override sketch was run against a fake `glab`: all sections present → exit 0; the
  closed search failing → `recentlyClosed: null`, exit 0, reason on stderr; `glab` missing →
  exit 127. The doc says plainly that the sketch is still four `glab` processes and refreshes the
  searches more often, so it shows the contract, not a saving.
- `codev/resources/arch.md`: "18 concepts" → the 21 in `KNOWN_CONCEPTS`, plus one paragraph on
  how the overview fetches and on `overview-budget.ts` owning the TTLs and the projection.
- Both forge `SKILL.md` files: a concept row, an eligibility subsection, a preset note and a code
  pointer. Still byte-identical (`cmp`). `codev-skeleton/` carries no forge docs, so there is
  nothing to mirror.

## 2026-11-27: Review
- `main` had moved 35 commits; its #1844 change added an import on the line next to mine in
  `overview.ts`. Merged `origin/main` (eeb4b6393), keeping both imports, then rebuilt and re-ran
  the full suite on the merge commit.
- Review doc: `codev/reviews/1647-tower-collapse-the-four-per-wo.md`. Three cold lessons added to
  `lessons-learned.md` (forge scripts under a time limit; `gh api graphql` `-F`/`-f`; measuring
  points with `rateLimit(dryRun: true)`). No hot-tier change; both hot files are at their caps.
- Still open for verify: the Windows workflow run on this branch, and the Work view browser check
  on the architect's install.
- PR #2004 opened. Windows run 45952952774 green on 42231b9aa.
- PR consultation: codex REQUEST_CHANGES only because the Windows run was still in flight;
  claude APPROVE with six nits. Fixed four in place:
  - a body-only `RATE_LIMITED` is now named on stderr, so the limiter suspends;
  - the `invalidate()` docstring;
  - the fake `gh` lock trap, held-only (the suggested whole-script EXIT trap would race);
  - no cursor check on the last issue page or search page 10.
  The "future-dated" fixture note is rebutted: the dates are UTC. Both script fixes were
  mutation-checked.
- PR round 2: codex again waited only on the Windows run. Claude found the real gap: both
  script test files were gated `process.platform !== 'win32'`, so the two green Windows runs had
  never executed the script, and my `[x] Windows` claim was wrong.
  - Re-gated both files on `jq` alone, with four POSIX-only pieces skipped by name.
  - Ran them with `windows.yml -f filter=spec-1647`. The first run (45955987403) found a real
    bug: `jq.exe` writes CRLF, so with both searches failed `closed\r` matched no section, and
    a search-local failure became a whole-bundle failure.
  - Fixed it (ea435efc3): `jq -e` exit status for the classification, `-j` for cursors. A CRLF
    `jq` shim test pins it on POSIX.
  - Also from claude: source-only plan resolution (no per-poll script reads), a test holding
    the script's rate-limit ERE equal to the limiter's, and a bounded lock spin.
