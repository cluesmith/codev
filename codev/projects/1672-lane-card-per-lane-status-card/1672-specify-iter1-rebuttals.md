# Rebuttal — Specify iteration 1 (Lane Card, #1672)

All three reviewers returned REQUEST_CHANGES (HIGH confidence) with strong consensus on real defects. I verified the three load-bearing, code-grounded claims against the tree before acting (route rule, forge mechanism, helper consumers); all three held. The spec was revised to fold in every consensus point. Below, each point with what changed.

## Accepted and fixed

### 1. Endpoint public-by-default (Gemini, echoed by all)
**Confirmed** against `server-utils.ts:169-190`: a `/workspace/:ws/...` subpath that does not start with `api/`, `ws/`, or `file` returns `true` from `isPublicRoute` (public static-asset rule). So `GET /workspace/:ws/lane/:id/card` would have been unauthenticated.
**Changed**: endpoint is now `GET /workspace/:ws/api/lane/:id/card` (under the `api/` namespace, keyed by default). Constraints and the Risks table call the `api/` prefix load-bearing, and a success criterion + test assert unauthenticated rejection.

### 2. `AGENT WORKING` vs `STALLED?` contradiction (Gemini, Codex)
**Accepted**: "recent output" in `AGENT WORKING` contradicted the produced-artifact `STALLED?` rule (first-match-wins meant a busy composer never reached `STALLED?`).
**Changed**: the new precedence table defines `AGENT WORKING` as "active phase **and** a produced-artifact write within the threshold"; terminal `lastDataAt` explicitly does not qualify. A dedicated boundary test asserts fresh `lastDataAt` + stale artifacts resolves to `STALLED?`.

### 3. Incomplete #1595 lifecycle: completed/dead lanes (Gemini, Codex)
**Accepted**: completed/verified lanes would fall through to `STALLED?`, and `dead` was left as an open question.
**Changed**: the precedence table is now exhaustive, adding terminal/liveness states `DONE` (completion states exit here) and `OFFLINE` (the #1595 `dead` state, a liveness fact distinct from `STALLED?`). Success criteria and tests cover both. Open Question 6 now asks only how offline lanes are *discovered* for the fleet view, not what state they take.

### 4. Forge data plane mischaracterized as a GraphQL selection (Claude — the sharpest)
**Confirmed**: forge PR data comes from per-forge shell scripts (`scripts/forge/{github,gitlab,gitea}/pr-list.sh`, GitHub via `gh pr list --json ...`) behind `PrListItem` (`forge-contracts.ts:104`), with the #1645 capture-then-pipe shape; `pr-list` is open-only; merged PRs come from `MergedPrItem` (`forge-contracts.ts:135`, cached ~`overview.ts:969`).
**Changed**: Current State, Constraints, and Approach 1 are rewritten in those terms. Approach 1's cost is restated (touches the cross-forge contract + GitHub script, needs a GitLab/Gitea ruling, and the real hazard is payload/node-limit growth on a large PR list, not an extra request). **Open Question 1 is restated** as "may `PrListItem` gain a CI rollup field, with a GitHub-first / non-GitHub-reports-unknown carve-out?" so main rules on the real mechanism. The disagreement scenario now names `MergedPrItem` as its data source.

### 5. Single-SSOT criterion unsatisfiable as written (Claude)
**Confirmed**: `isIdleWaiting`/`deriveAttention` have live consumers (extension.ts:423/484, views/builders.ts:59/60/628, builder-row.ts:63, contextual-panel:185, streamdeck note).
**Changed**: added a "One computation, many renderers" subsection stating the disposition: the precedence chain lives in one SDK-side module; the existing helpers become **projections over it**, not deleted and not rewritten by this lane. The criterion is narrowed to "one module owns the precedence chain; the buckets derive from it."

### 6. Missing `LaneCard` wire schema (Gemini)
**Accepted**: prose alone gave main and downstream nothing concrete to review.
**Changed**: added a draft `LaneCard` interface (field inventory, ball-owner state union, artifact/CI shape, freshness with per-source ages, reserved optional `lastAsk` (#1674) and `park` (#1729) fields), marked as contract surface for main to ratify.

### 7. Age/freshness provenance not derivable (Gemini, Codex)
**Confirmed**: `OverviewCache.fetchedAt` is private and absent from `OverviewData`; `forgeStatus`/`forgeResetAt` cannot produce "gh 40s"; thread headings are date-level with one file `mtime`.
**Changed**: (a) added a thread-entry grammar requiring a machine-readable timestamp per heading (so beat/`Now:` ages parse without `git log`/`blame`), with graceful `mtime` fallback when absent; (b) Open Question 2 (now Critical) asks main whether the OverviewCache/`OverviewData` may expose a per-source `fetchedAt`; absent that, freshness degrades to `forgeStatus` only.

### 8. Path traversal on `:id`/`:ws` (Codex, Claude)
**Accepted**.
**Changed**: added a constraint and criterion that `:id` is validated against the registered lane set and never interpolated into a filesystem path; a test rejects `../` in `:id`/`:ws`.

### 9. Authored prose into the webview / ANSI (Claude, Codex)
**Accepted**: the `Now:` line and beat headings are arbitrary builder text rendered in the VS Code webview and in ANSI.
**Changed**: added a criterion + test that authored text is HTML-escaped before the webview and stripped of terminal control sequences before ANSI rendering.

### 10. Lane → PR resolution unspecified (Claude)
**Changed**: the endpoint spec now states `:id` resolves to the lane's linked PR via the workspace open-PR set (linked issue), with defined behavior on no-match (no PR zone) and on the merged case (`MergedPrItem`).

### 11. `EXTERNAL` fallback + `STALLED?` default (Claude, Gemini)
**Changed**: added explicit defaults so the criteria are testable now: `EXTERNAL` = CI-pending-only if no consult-lane signal exists (Open Question 5); `STALLED?` default threshold = `IDLE_WAITING_THRESHOLD_MS` (5 min) on produced-artifact movement, protocol-aware tuning deferred (Open Question 3).

### 12. Smaller gaps (Claude, Codex)
**Changed**: `afx card` with `id` omitted now has a resolution rule (focused/cwd lane, else error with candidates); the fleet sort defines timestamp/direction/tie-break (your-court, then held, then descending condition age, lane-id tie-break); a watcher-scale risk row (fd/watch ceilings across all lanes, with a bounded-watchers + on-demand fallback mitigation) was added.

## Disagreements

None. Every point was a genuine improvement or a correct code-grounded correction. Two items were intentionally left as Open Questions rather than decided unilaterally, because they are main's contract surface: whether `PrListItem` gains a CI field (OQ1) and whether `OverviewData` exposes a per-source `fetchedAt` (OQ2). The spec ships a working fallback for each (Approach 2 for CI; `forgeStatus`-only freshness), so planning is not blocked while main rules.

## Contract-surface sections to route to main (per the lane brief)

Flagging for the spec-gate message: the `LaneCard` draft type (`packages/types`); the ball-owner module placement and the helper-projection disposition (`packages/sdk`); the Tower endpoint `GET /workspace/:ws/api/lane/:id/card` and the file-watch assembly (`packages/core`/Tower); and the two contract extensions behind OQ1 (`PrListItem` CI rollup) and OQ2 (`OverviewData` per-source `fetchedAt`).
