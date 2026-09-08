# bugfix-1645 — builder thread (rebuild lane)

Issue #1645: Tower's OverviewCache burns the whole GitHub GraphQL quota.
Spec = architect's rebuild prescription on the issue (comment 5581422713) + the
46-item pitfall list (comment 5581455959). PR #1646 is superseded; not building on it.

## 2026-09-08 — investigate

### Reproduced (read-only against the production Tower, pid 21829)
- Sampled `gh` descendants of the Tower pid at ~1 Hz: 30 distinct spawns in ~14 s
  (≈ 2/s ≈ 7,000/h). Every spawn is one of the four overview concepts
  (`gh issue list --limit 200`, `gh issue list --state closed --search closed:>…`,
  `gh pr list --state merged --search merged:>…`, `gh pr list --json …`).
- Real GraphQL budget, from `gh api graphql -i` headers: `X-Ratelimit-Used: 1420,
  Remaining: 3580` five minutes into the window (reset 1788858149). `gh api rate_limit
  --jq .resources.graphql` reported `used: 0, remaining: 5000` at the same instant —
  confirms the "misleading REST probe" note; a healthy reading from it is worthless.
- The dashboard polls `/api/overview` every 2.5 s (`apps/web/src/hooks/useOverview.ts`),
  the VS Code sidebar every 60 s; the 30 s TTL governs spend, the poll governs the
  failure-amplifier.

### Root cause (packages/codev)
1. `src/agent-farm/servers/overview.ts` `OverviewCache.fetch*Cached`: `if (data !== null) cache.set(...)`
   — failures are never cached, so while gh fails every poll re-spawns all four commands.
2. `src/lib/forge.ts` `executeForgeCommand`: every failure collapses to `null`; stderr/exit
   code never reach the caller, so nothing can tell "rate limited" from "gh missing".
3. No single-flight: concurrent polls (2.5 s dashboard + VS Code + cloud) each start their
   own batch while a previous one is in flight.
4. `invalidate()` (called by porch after every mutating command, by VS Code, by cleanup)
   clears every cache for every workspace, so churn bypasses the TTL entirely.
5. TTL 30 s × 4 concepts × 13 workspaces ≈ 6,240 calls/h even with everything healthy.

### Measured GraphQL cost (for the record; collapse is #1647, out of scope)
A single combined GraphQL query (open PRs + open issues + closed-24h search + merged-24h
search, first:100 each) costs **4 points** per `rateLimit.cost`. `{owner}`/`{repo}`
placeholders work in `gh api graphql -F` and inside REST `search/issues?q=`.

### Scope decision
Frozen to the architect's six items (negative cache+backoff, per-backend suspension,
single-flight w/ generation tag, TTLs 180/600/3600 + list-only debounced invalidate,
forgeStatus/forgeResetAt payload, `# forge-executable:` on the 8 builtin-resolving
scripts). Doctor check, #1647, #1648, #1650 are out. Estimated production diff ≈ 300 lines.
