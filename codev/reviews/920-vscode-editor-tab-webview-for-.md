# PIR Review: VSCode editor-tab webview for rich backlog search

Fixes #920

## Summary

Adds a **"Search Backlog" editor-tab webview** to the VSCode extension for exploratory backlog triage — opened from a 🔍 icon in the Backlog view's title bar. The panel filters open issues by Area / Assignee / Author, substring-searches title **+ body**, sorts by column, and shows a match-count footer; rows open the issue or reference it in the architect chat. Data comes from a **dedicated `issue-search` forge concept** surfaced as `GET /api/issue-search` (kept separate from `issue-list` so the always-on `/api/overview` payload stays body-free). It complements the always-on sidebar tree and the #918 Quick Pick rather than replacing either (and supersedes the closed #906).

## Files Changed

(`git diff --stat` against the merge-base — this PR's changes only)

- `packages/types/src/api.ts` (+35) — `IssueSearchItem` / `IssueSearchResponse` wire types
- `packages/types/src/index.ts` (+2) — re-exports
- `packages/core/src/tower-client.ts` (+23/−2) — `searchIssues(workspace, state)` client method
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+92) — `GET /api/issue-search` → `handleIssueSearch`
- `packages/codev/src/lib/github.ts` (+26) — `searchIssues()` routing through the `issue-search` concept
- `packages/codev/src/lib/forge-contracts.ts` (+7) — optional `IssueListItem.body`
- `packages/codev/src/lib/forge.ts` (+1/−1) — register `issue-search` in `KNOWN_CONCEPTS`
- `packages/codev/scripts/forge/github/issue-search.sh` (+13) — **verified-here**
- `packages/codev/scripts/forge/{gitlab,gitea,linear}/issue-search.sh` (+19/+28/+49) — mirrored, **⚠️ UNVERIFIED** (see below)
- `packages/codev/src/__tests__/forge.test.ts` (+9/−... ) — concept-count assertions 16→17
- `packages/vscode/src/webviews/backlog-search-panel.ts` (+204, new) — panel lifecycle, messaging, host-side filtering
- `packages/vscode/src/webviews/backlog-search.template.ts` (+266, new) — HTML/CSS/client-JS template
- `packages/vscode/src/views/backlog-filter.ts` (+137) — pure `searchBacklog` / `formatAge` helpers
- `packages/vscode/src/extension.ts` (+29/−...) — `codev.openBacklogSearch` command + widened `IssueCommandArg`
- `packages/vscode/package.json` (+10) — command + title-bar menu entry
- `packages/vscode/src/__tests__/backlog-filter.test.ts` (+139) — search/sort/age unit tests
- `codev/plans/920-*.md`, `codev/state/pir-920_thread.md` — plan + builder thread

## Commits

(substantive `[PIR #920]` commits; porch `chore` + the `origin/main` merge omitted)

- `443c7a67` Add GET /api/backlog-search endpoint + body-bearing data path
- `c9a5a973` Add Search Backlog editor-tab webview panel + command
- `4ab9806a` Test searchBacklog filter/sort + formatAge helpers
- `4fdb6194` Extract webview markup/script to backlog-search.template.ts
- `1ce709ee` Add inline 'reference in architect' action to search rows
- `65ec47cb` Replace parameterized issue-list with dedicated issue-search concept
- `b5da1395` Rename backlog-search API to issue-search for resource-naming consistency
- (+ `origin/main` merged in to keep the branch current with v3.1.6)

## Test Results

- `pnpm build` (types / core / codev): ✓ pass
- vscode: `check-types` ✓, `lint` ✓, `esbuild` bundle ✓, `test:unit` ✓ — **192 tests** (incl. ~20 new `searchBacklog`/`formatAge` cases)
- codev full suite: ✓ **3210 passed / 13 skipped** (the 13 skips + the `nonexistent_check` warnings are pre-existing on `main`, unrelated to this change)
- github `issue-search.sh` exercised live here: `state=open` → 93 issues with `body` present; `closed`/`all` → 200-capped, `body` present
- **Manual verification**: the human approved the `dev-approval` gate after reviewing the running worktree (the gate exists precisely for the theme/result-size/filter-combination checks a PR diff can't catch).

## Architecture Updates

Updated `codev/resources/arch.md` → **VS Code Extension › Key Design Decisions**: added an "Editor-tab webviews (#920)" entry documenting the reusable pattern (editor-area `WebviewPanel`, host-side filtering in vscode-free pure helpers so logic stays testable and issue bodies never reach the webview, `*.template.ts` markup with CSS-variables-only theming + nonce'd CSP, fed by the dedicated `issue-search` concept). Did **not** add `/api/issue-search` to the API table — that table covers Tower lifecycle/management endpoints and doesn't enumerate the overview/issue *data* reads (`/api/overview`, `/api/issue` aren't listed either), so adding it would be inconsistent.

## Lessons Learned Updates

Added two entries to `codev/resources/lessons-learned.md` → **Architecture**:
1. Prefer a **dedicated forge concept** over parameterizing a shared one when a feature needs extra data/queries — parameterizing couples the shared primitive and (here) would have silently returned wrong results on non-GitHub forges; a dedicated concept degrades honestly to "unavailable". Extends the #909 forge-agnostic-layer lesson.
2. **Name by layer**: route/concept/lib = resource (`issue-search`), UI = feature ("Search Backlog"); don't mix vocabularies across the same data path.

## 3-Way Consultation Outcome (PIR single advisory pass)

- **Gemini: APPROVE** · **Claude: APPROVE** · **Codex: REQUEST_CHANGES** (2 findings).
- PIR's consultation is single-pass — these dispositions were **not** independently re-reviewed, so the `pr`-gate human is the final check on them:

1. **Codex #1 — stale-criteria desync (real bug): FIXED + regression test.** On a refresh / Status change that drops a previously-selected facet value, the webview's dropdown silently reset to "All" while the host kept filtering by the now-hidden value — table and dropdown could disagree. Fixed host-side with a pure, tested `clampCriteriaToDataset()` (`views/backlog-filter.ts`) called in `fetchAndRender()` before re-render; 5 regression cases added. Neither Gemini nor Claude caught this — worth a careful look.
2. **Codex #2 — Open omits active-builder exclusion: REBUTTED (human decision flagged).** The plan's explicit Open definition is *"open issues with no active PR"* — exactly what's implemented; the builder-exclusion only appears in the plan's parenthetical about the "available work" concept. **Gemini explicitly judged this an acceptable deviation for an exploratory search surface**, and issue #920 frames the use case as *"every open `area/vscode` issue, assigned to anyone"* — i.e. builder-attached issues should be findable (the sidebar hides them only to prevent double-spawn, which doesn't apply to search; "All" shows everything regardless). I left Open as PR-exclusion-only. **If you'd prefer Open to mirror the sidebar's displayed set exactly (also hide active-builder issues), that's a small follow-up** — say so at the gate.
- Also applied Claude's note: removed `void` prefixes on fire-and-forget calls in `backlog-search-panel.ts` (project preference = bare call).
- Full verdict text: `codev/projects/920-*/920-review-iter1-{gemini,codex,claude}.txt`.

## Things to Look At During PR Review

- **The three unverified forge scripts** (`gitlab`/`gitea`/`linear` `issue-search.sh`). Only `github` was empirically exercised (this repo's forge). The others are faithful mirrors of their `issue-list.sh` siblings + `body` + a state mapping, each with a `⚠️ UNVERIFIED` header naming exactly what to smoke-test (glab's `--closed`/`--all`, tea's `--state`/`body` field, Linear's `state.type` filter). They degrade safely — a forge whose concept errors returns null → "search unavailable" — so they can't silently misbehave, but they need a smoke-test by someone with those CLIs before being trusted.
- **Status semantics**: `open` reproduces the sidebar's PR-excluded backlog; `closed`/`all` deliberately *lift* the PR-exclusion (a closed issue usually has a merged PR, so excluding would empty the list). Confirm that's the intended behavior.
- **Coexistence with #918**: both `codev.openBacklogSearch` (this panel) and `codev.searchBacklog` (Quick Pick) live in the tree now — verified only the panel is in the title bar (one 🔍); the Quick Pick is palette-only. Both appear in the command palette with near-adjacent titles ("Search Backlog" vs "Search Backlog…") — acceptable, but a candidate for a future title tweak.
- **`extension.ts` is tab-indented** (the file's pre-existing style, repo-wide outlier); edits matched it deliberately — not a conversion. No formatter exists in the repo.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-920` → **View Diff**
- **Run it** (spans Tower + extension, so both must carry the branch):
  1. `cd .builders/pir-920 && pnpm -w run local-install` — rebuilds + restarts Tower so it serves `/api/issue-search` and resolves the `issue-search` concept.
  2. Open the worktree in VSCode → **F5** ("Run Codev Extension") → Extension Development Host.
  3. Codev sidebar → Backlog → **🔍** → "Search Backlog" tab.
- **What to verify** (from the plan's Test Plan): live debounced text search over title+body; Area/Assignee/Author scopes AND together; Status Open→Closed→All re-fetches; column-header sort with arrow indicator (default Age ▼ = oldest first); row click opens the issue; row `↪` references it in the architect chat; footer `N matches found · by-area breakdown`; re-invoking focuses the single instance; **theme sweep across dark / light / high-contrast** (CSS variables only).

## Flaky Tests

None skipped. (The 13 pre-existing skips in the codev suite are unrelated to this change and were not touched.)
