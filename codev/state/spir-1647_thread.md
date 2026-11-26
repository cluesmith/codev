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
