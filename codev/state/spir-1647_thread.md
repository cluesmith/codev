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
