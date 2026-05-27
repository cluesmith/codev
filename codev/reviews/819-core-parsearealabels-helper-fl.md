# PIR Review: `parseArea` helper + `area` field on `BacklogItem` and `BuilderOverview`

Fixes #819

## Summary

Adds the `parseArea` helper (in `packages/codev/src/lib/github.ts`) that extracts a single `area/*` value from an issue's labels, and threads that value as a required `area: string` field through `BacklogItem` / `BuilderOverview` (server-internal) and `OverviewBacklogItem` / `OverviewBuilder` (wire contracts). This is pure scaffolding for two follow-up consumers — #811 (backlog grouping by area) and #818 (builders-tree grouping by area). No user-visible behavior change; the new field appears on every `/api/overview` payload but no UI surface reads it yet.

## Files Changed

Computed via `git diff --stat origin/main...HEAD` (branch-only — excludes commits picked up from main during a mid-PIR merge):

- `codev/plans/819-core-parsearealabels-helper-fl.md` (+279 / -0)
- `codev/projects/819-core-parsearealabels-helper-fl/status.yaml` (+27 / -0) — porch-managed, not hand-edited
- `codev/reviews/819-core-parsearealabels-helper-fl.md` (+90 / -0) — this file
- `codev/state/pir-819_thread.md` (+79 / -0)
- `packages/codev/src/__tests__/github.test.ts` (+66 / -0)
- `packages/codev/src/agent-farm/servers/overview.ts` (+38 / -5)
- `packages/codev/src/lib/github.ts` (+29 / -0)
- `packages/core/src/constants.ts` (+9 / -0)
- `packages/types/src/api.ts` (+15 / -0)
- `packages/vscode/src/test/builders.test.ts` (+1 / -0)

Total: 10 files, +628 / -5.

## Commits

Implementation:

- `da040105` [PIR #819] Add parseAreaLabels helper + unit tests
- `fc8b3001` [PIR #819] Add resolvePrimaryArea helper + tests
- `763d8170` [PIR #819] Wire areas[] through BacklogItem and BuilderOverview
- `6e90f5c6` [PIR #819] Add areas[] to OverviewBuilder and OverviewBacklogItem wire types
- `65739680` [PIR #819] Thread: log implement-phase progress

Design revisions at dev-approval (two rounds — see *Things to Look At*):

- `114aee99` [PIR #819] Revise: parseArea returns single string (drop array shape)
- `df442ca8` [PIR #819] Revise: drop resolvePrimaryArea (parser projects to single area now)
- `5c8800f8` [PIR #819] Revise: BacklogItem.area + BuilderOverview.area (single string)
- `7cf2d8cb` [PIR #819] Revise: OverviewBuilder.area + OverviewBacklogItem.area wire fields
- `2aa42101` [PIR #819] Document design revision in plan + thread
- `f638e84c` [PIR #819] Revise: drop cross-cutting privilege (parser is policy-free about label names)
- `62df91f7` [PIR #819] Extract 'Uncategorized' to UNCATEGORIZED_AREA constant in @cluesmith/codev-core

## Test Results

- `pnpm -w build`: ✓ pass (full workspace incl. types, core, codev, dashboard)
- `pnpm --filter @cluesmith/codev test src/__tests__/github.test.ts`: ✓ pass (66 tests, 10 new for `parseArea`)
- `pnpm --filter @cluesmith/codev test` (full suite): ✓ pass (3149 tests, 13 pre-existing skips, no regressions introduced)
- `pnpm --filter codev-vscode run check-types`: ✓ pass (verifies the wire-type addition propagates through vscode without compile errors)
- Manual verification (at `dev-approval` gate): the human inspected the running implementation and approved.

## Architecture Updates

No changes to `codev/resources/arch.md`. The PR adds a parser + a required field on existing wire-contract shapes; it doesn't introduce new module boundaries, new caching layers, new endpoints, or new architectural patterns. The cache discipline question raised in the issue body (defensive `??= []` at serve-out) was investigated and found to be structurally satisfied — `OverviewCache` already holds only raw forge responses, never derived `BacklogItem` / `BuilderOverview` shapes, so the "stale cache entry missing `area`" failure mode isn't reachable. This is a *finding about existing architecture*, not a *change to it*, so it lives in this review and the implement-phase thread rather than in `arch.md`.

## Lessons Learned Updates

No additions to `codev/resources/lessons-learned.md`, but two durable principles emerged that landed in the project's memory system instead (which is the appropriate home for AI-collaboration-shape lessons):

1. **Framework code must be policy-free about specific label values.** The initial parser implementation privileged `area/cross-cutting` (returning it preferentially when present). The user pushed back — Codev framework code shouldn't bake in semantic conventions about specific label names; teams using Codev decide their own labeling conventions. Stripped the privilege; added a no-privilege regression-guard test. Captured as [`feedback_framework_neutral_on_label_semantics.md`](/.claude/projects/-Users-amrmohamed-repos-cluesmith-codev/memory/feedback_framework_neutral_on_label_semantics.md).

2. **Wire-shape "permissiveness then projection" is a smell.** The initial design returned `string[]` from `parseAreaLabels` and then collapsed it to a single bucket via a separate `resolvePrimaryArea` helper at the UI boundary — two operations cancelling each other out. The cleaner shape is for the parser to do the projection once at the boundary and return `string` directly, symmetric with `parseLabelDefaults`'s single-string `type` / `priority` returns. This isn't a generalizable arch principle (it's specific to this case), so it's documented in the plan revision notes and this review rather than `lessons-learned.md`.

`codev/resources/arch.md` and `codev/resources/lessons-learned.md` would be updated as a follow-up by the MAINTAIN protocol's quarterly sweep if either principle generalizes further; nothing about this PR warrants forcing them into the docs now.

## Things to Look At During PR Review

1. **Two rounds of design revision during the implement phase** — visible in the commit history. The original implementation followed the issue body verbatim (`areas: string[]` + `resolvePrimaryArea` helper, with `cross-cutting` privilege). The human at dev-approval flagged two issues and the design collapsed to single-string at the parser with no special-cased label names. The final shape is meaningfully smaller and cleaner than what the issue body proposed — see the plan file's revision note for the full reasoning.

2. **The `discoverBuilders` defaulting pattern.** Three `builders.push({...})` sites in `discoverBuilders` each set `area: UNCATEGORIZED_AREA`. The `getOverview` enrichment loop then overrides this with `parseArea(issue.labels)` for builders whose issue is in the cached issue list. Builders with `issueId: null` (soft-mode / task-mode) keep the default. Worth a glance to confirm the defaulting + enrichment flow is what you'd expect; one alternative would be to make the field `area: string | null` and let the UI render its own fallback, but `'Uncategorized'` as a server-side default keeps consumers free of null-handling.

3. **`OverviewCache` does not cache derived shapes** — verified at `overview.ts:763-769`. Only raw `ForgePR[]` / `ForgeIssueListItem[]` are cached. `BacklogItem` and `BuilderOverview` are rebuilt fresh on every `getOverview` call, so `parseArea` runs against current labels every time. The "stale cache entry missing `area`" concern from the issue body §B isn't reachable in the current architecture. If a future change ever adds a derived-shape cache, that discipline would need to be re-applied at that point.

4. **Two follow-up issues filed during this PIR:**
   - **#869** — "Label namespace separator: resolve mixed colon-vs-slash convention" (the mixed-separator state across `type:` / `priority:` / `area/` is a real engineering concern worth resolving globally; this PIR ships the slash convention as-spec'd; #869 lays out options A/B/C for the wider question).
   - **#875** — "Collapse duplicate `Overview*` / `*Overview` types" (five paired interfaces across `packages/codev/src/agent-farm/servers/overview.ts` and `packages/types/src/api.ts` are structurally identical; this PIR's `area` addition had to land in both halves of the pair, demonstrating the drift cost; proposed fix is to make `@cluesmith/codev-types` the single source of truth).

5. **`parseArea` projection rule**: first-alphabetical wins, no label name is privileged, `'Uncategorized'` fallback. The no-privilege test explicitly uses `area/cross-cutting` as fixture data to prove the parser doesn't treat it specially — that's intentional and is the regression guard against re-introducing the privilege.

## 3-Way Consultation Dispositions

Single advisory pass (PIR's `max_iterations: 1`). Verdicts:

- **Claude**: APPROVE.
- **Codex**: COMMENT. Two accuracy findings on this review file: (1) the Files Changed list underreported (was 9, actually 10 — review file itself was missing); (2) the local-test instruction recommended `import { parseArea } from '@cluesmith/codev'` but `parseArea` isn't exported from the package root. **Both addressed** in this same review file revision — see the corrected Files Changed list and the updated "How to Test Locally" section.
- **Gemini**: failed to produce a verdict (`consult` exited code 1 with opaque `[object Object]` error on three attempts; no output file written). Surfaced to the architect; no model verdict obtained for this PR.

No `REQUEST_CHANGES` findings. Codex's COMMENT findings were minor accuracy issues on the review file (not on the code) and were corrected in place.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-819` → **Review Diff** (auto-detects the repo's default branch). Or `git diff main...HEAD`.
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-819` from a shell.
- **What to verify**:
  - `pnpm -w build` is green.
  - `pnpm --filter @cluesmith/codev test src/__tests__/github.test.ts` — 66 tests pass, including the new `parseArea` block.
  - Hit `/api/overview` on the running dev server: `curl http://localhost:<port>/api/overview | jq '.backlog[0] | {id, area}'`. Every backlog entry should have a populated `area` string. This issue (#819) is labeled `area/core`, so its entry should show `"area": "core"`.
  - Same for builders: `curl http://localhost:<port>/api/overview | jq '.builders[] | {id, issueId, area}'`. Builders with an `issueId` matching a labeled issue inherit that issue's area; builders without an issue (soft-mode / task-mode) show `"area": "Uncategorized"`.
  - `parseArea` is currently internal to the codev server (no public re-export from the package root). To exercise edge cases directly, the cleanest path is the unit test file at `packages/codev/src/__tests__/github.test.ts` — run `pnpm --filter @cluesmith/codev test src/__tests__/github.test.ts`, or add a temporary case there. The 10 included cases already cover `null`, `''`, `[{name: 'area/auth'}, {name: 'area/cross-cutting'}]` (returns `'auth'` — first alphabetical, cross-cutting not privileged), and the other defensive paths.
