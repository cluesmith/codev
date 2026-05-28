# pir-891 thread

## 2026-05-28 — plan drafted

Plan committed at `codev/plans/891-vscode-shared-search-webview-a.md`. Sitting at the `plan-approval` gate.

Key design positions worth flagging to anyone who looks in:

- Accepted issue's recommendations on all 7 design questions, with one substantive deviation: **match scope adjustment**. The issue body said "title + areas + labels + assignees" but `OverviewBacklogItem` only exposes a single resolved `area` (no `labels[]`) and `OverviewBuilder` has no `assignees` at all. Plan filters on the fields that actually exist (backlog: id/title/area/assignees/author; builders: issueId/issueTitle/area/spawnedByArchitect). Adding a real `labels[]` to the overview types is offered as an in-PR addendum if the reviewer wants it.
- "Hide empty groups" branch only fires when filter is active — empty-filter render is byte-identical to today.
- Webview HTML is split into a pure renderer in `search-view-html.ts` so it's unit-testable without `vscode` mocking.
- First webview in the extension — establishes CSP/nonce/theme-var scaffold that #807 (Reader View), #861, #862, #863 can copy.
- Known risk flagged for dev-approval: VSCode has no public `WebviewView.hide()` API, so the 🔍-toggle-collapse half is a slightly awkward focus-shift workaround. The dev-approval gate is the right place to feel out whether it's acceptable.

Estimated scope: ~290 production LOC + ~210 test LOC (issue's 150+50 estimate was light — gap is the webview HTML scaffold + per-provider hide-empty-groups handling).

## 2026-05-28 — plan revised; mode toggles dropped

After plan-approval discussion, four decisions baked in:
1. Include `labels[]` in filter scope → adds `labels: string[]` to OverviewBacklogItem/OverviewBuilder, threads through `packages/types` + `packages/codev`
2. Mode toggles (Aa/ab/.*) dropped for v1 → plain case-insensitive substring only; SearchState is just `{query}`
3. Toggle via conditional view rendering — `when: "codev.searchVisible"` context key + workspaceState persistence (mirrors the existing `codev.team` view pattern)
4. `retainContextWhenHidden: true` (preserve query across pane clicks)

Net scope drops to ~180 production LOC + ~140 test LOC + ~25 LOC wire-format. Closer to the issue's original estimate.

## 2026-05-28 — implement phase complete, awaiting dev-approval

All checks green:
- `pnpm --filter codev-vscode package` clean (type check + lint + esbuild bundle)
- `pnpm test:unit` 91 tests pass (4 new test files: search-state, search-view-html, backlog-search, builders-search)
- `pnpm --filter @cluesmith/codev test` 3188 tests pass — confirms the wire-format change to overview.ts doesn't break server-side tests

Two commits:
- `5538edfa` — wire-format only (types + overview server)
- `1ec09c76` — VSCode extension implementation (search-state, webview, provider wiring, package.json contributions, tests)

**Known dev-approval risk:** the `codev.search` view is placed as the FIRST entry in `contributes.views.codev` (pushing Workspace below it). The issue mockup didn't show Workspace at all so it was ambiguous. If the reviewer prefers Search ABOVE Backlog specifically (rather than at the very top), it's a one-line config change to reorder. Calling this out so it doesn't get missed during the running-worktree check.

## 2026-05-28 — dev-approval regression fix (commit 527c8f59)

Architect reported `e.labels is not iterable` crash blocking Backlog and Builders tree render. Confirmed and fixed: unguarded `...item.labels` / `...b.labels` in `backlog.ts:itemMatches` / `builders.ts:builderMatches` crashed when wire payload omitted the new field (stale Tower not rebuilt with the matching overview.ts).

Coerced both sites with `Array.isArray(x) ? x : []` per the canonical pattern in `packages/codev/src/lib/github.ts:480,529` (`parseLabelDefaults` / `parseArea`). Also tightened `assignees` from `?? []` to `Array.isArray(...) ? ... : []` for consistency — previously guarded against undefined but not against non-array shapes.

Added two regression tests in each of `backlog-search.test.ts` and `builders-search.test.ts` (4 total) that delete/null the `labels` field on a fixture and assert `getChildren()` doesn't throw. Confirmed the tests FAIL without the guard (reproduced the exact "is not iterable" error via `git stash` of the fix) and PASS with it. 95 tests total now (was 91).

**Lesson worth recording in review:** type contracts are not runtime guarantees across upgrade boundaries. The new `labels: string[]` is required in the type, but a VSCode extension built with the new type can be loaded against a Tower serving the old wire shape — the type system doesn't catch this. Defensive coercion at the consumer is the right call, matching the existing `Array.isArray(...) ? ...` pattern the project already uses for forge-variant label payloads.
