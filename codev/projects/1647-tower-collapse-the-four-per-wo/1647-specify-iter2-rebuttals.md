# Spec 1647, specify iteration 2: disposition of review findings

codex: APPROVE, no issues. claude: REQUEST_CHANGES, with every finding accepted and none
rebutted.

| # | Finding | Disposition |
|---|---|---|
| 1 | "Spawn" conflates concept invocations with `gh` processes; on a repo with more than 100 open issues the bundle runs 2 `gh` processes per invocation (40/h, not 20/h) | **Accepted and correct.** A POSIX `sh` script cannot page inside one `gh` call, so the issue page is a second `gh api graphql` process. Every cost table now has separate columns for invocations, `gh` processes, HTTP requests and points. The Problem Statement, Approach 1 pros and D2 state the honest reductions: invocations −62%, `gh` processes −62% on smaller repos but −23% (52 → 40) on this one. The first success criterion asserts one *invocation*, with explicit process counts for the ≤100 (1) and >100 (2) fixtures. The rate-limit criterion and the test scenarios use the same units. |
| 2 | Implicit search qualifiers are a parity hole | **Accepted.** Desired State item 1 names the qualifiers `gh` adds (`repo:`, `type:issue state:closed`, `type:pr is:merged`), taken from the captured `gh` queries. The parity criterion and a test scenario add a closed PR, a closed-unmerged PR and an open issue that must stay out of the wrong section. |
| 3 | Nested connection caps unstated | **Accepted and verified** from the captured queries: `labels(first:100)`, `assignees(first:100)`, `reviewRequests(first:100)`. Stated in item 1. |
| 4 | Search-overflow assumption implicit | **Accepted.** Item 1 states that the figures assume neither 24 h search exceeds 100 results (true on this repo), and gives the worst case: 20 processes in one invocation inside the 60 s limit. |
| 5 | The issues-disabled divergence also flips `forgeStatus` | **Accepted.** Item 5 now says it explicitly, and frames the owner's overrule as covering the whole behaviour change: empty backlog, no `errors.issues`, and `forgeStatus: ok`. |
