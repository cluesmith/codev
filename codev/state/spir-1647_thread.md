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
