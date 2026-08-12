# PIR Review: Clickable `#N` / `PR #N` terminal references (VS Code)

Fixes #1412

## Summary

Architect and builder terminal output constantly cites issues and PRs by number, but Cmd+click on those spans fell through to VS Code's workspace word-search (which matches nothing). This PR registers a `TerminalLinkProvider` that claims `#N` and `PR #N` spans and opens them: `PR #N` → the PR's forge page in the browser; a bare `#N` → the in-editor issue viewer by default (or the browser, per a new `codev.terminalLinks.issueTarget` setting), falling through to the PR page when the number turns out to be a PR. Claiming the span also suppresses VS Code's useless fallback search.

## Files Changed

- `apps/vscode/src/commands/open-terminal-ref.ts` (+97 / -0) — new; click resolution (issue-vs-PR discriminator, setting, progress spinner)
- `apps/vscode/src/terminal-link-provider.ts` (+44 / -0) — new `IssueRefTerminalLinkProvider` (span detection)
- `apps/vscode/src/extension.ts` (+9 / -1) — register the provider beside the two existing ones
- `apps/vscode/package.json` (+10 / -0) — `codev.terminalLinks.issueTarget` setting
- `apps/vscode/src/__tests__/terminal-ref-link-provider.test.ts` (+168 / -0) — new; detection + resolution routing tests
- `codev/resources/lessons-learned.md` (+1) — the `gh issue view` PR-discriminator lesson

## Commits

- `9017f4d58` [PIR #1412] Clickable #N / PR #N terminal references
- `a561c0001` [PIR #1412] Tests: terminal ref detection and resolution routing
- `cb12cab64` [PIR #1412] Add click feedback + drop redundant fetch on terminal ref open
- `ee6dea3f1` [PIR #1412] Reword issueTarget setting: drop internal 'bare #N' jargon

## Test Results

- `pnpm compile` (check-types + lint + esbuild): ✓ pass (0 type errors; 1 pre-existing `tunnel.ts` lint warning, not from this change)
- `pnpm test:unit`: ✓ pass (807 tests, 13 new in this file)
- Porch verify block (`build`, `tests`): ✓ pass
- Manual verification (human, at the `dev-approval` gate): Cmd+click `#N` opens the in-editor issue viewer; `PR #N` opens the browser PR page; a bare number that is a PR falls through to the browser; the `issueTarget: browser` setting flips bare `#N` to the browser. A first pass felt unresponsive (~2s, no feedback); fixed with a progress spinner + single forge round-trip, then re-verified. Wording of the setting description was tightened at the human's request.

## Architecture Updates

No arch changes. This adds a self-contained terminal link provider plus a resolution module inside the existing `apps/vscode/` structure — no module boundaries, invariants, ports, or state paths are affected, and it reuses the existing forge-fetch/open paths (`getIssue`, `openPRInBrowser`, `codev.viewBacklogIssue`) rather than introducing a new one. Not a HOT arch-critical fact; nothing durable to route to COLD `arch.md`.

## Lessons Learned Updates

Routed one COLD lesson to `codev/resources/lessons-learned.md` (near the `[From 787]` multi-forge contract lesson): `gh issue view <PR#>` **resolves** a PR number (exit 0, `.../pull/N` url) rather than failing — so issue-vs-PR must be discriminated on the resolved url path (`/pull/` vs `/issues/`), not on fetch-failure, and the single `getIssue` call should do double duty (discriminator + url-to-open) rather than triggering a second round-trip. Not HOT: it's a GitHub-forge-narrow recipe, not a behavior-changing cross-cutting rule (it reinforces the existing HOT "verify API behavior empirically" lesson rather than replacing it).

## Things to Look At During PR Review

- **The issue-vs-PR discriminator** (`open-terminal-ref.ts`, `/\/pull\/\d/` test on `issue.url`). This is the crux: `gh issue view` resolves PR numbers too, so fetch-failure is *not* the discriminator — the resolved url path is. Verified empirically (`gh issue view 1405` on a merged PR returns exit 0 with a `/pull/` url). If the forge supplies no `url` (non-GitHub), the code degrades to the issue path; v1 targets GitHub.
- **Reuse vs latency tradeoff** (`resolveRef`). The first cut funneled every open through `openPRInBrowser` / `openIssueInBrowser` for a single owner per destination, which meant bare `#N` did two forge round-trips (discriminator + helper re-fetch) and felt unresponsive. The current code opens the url the discriminator already resolved (`openExternal`) for the PR-fallthrough and browser-issue paths — no new fetch code, but a PR can now be browser-opened by two code paths (explicit `PR #N` via `openPRInBrowser`, and the bare-`#N`-is-a-PR fallthrough via `openExternal`). The in-editor issue preview still fetches once to render its content.
- **Regex reentrancy** (`terminal-link-provider.ts`). The `/(?<pr>\bPR\s+)?#(?<num>\d+)/gi` is built *inside* `provideTerminalLinks`, not shared at module scope — the VS Code d.ts warns the method may be re-entered before a prior call resolves, and a shared `/g` regex's `lastIndex` would race. (The sibling `BuilderTerminalLinkProvider` uses the module-scope pattern; this one deliberately does not.)
- **Module-load coupling avoided**: the editor path uses `executeCommand('codev.viewBacklogIssue', N)` rather than importing `viewBacklogIssue` directly, because `view-issue.ts` instantiates a `vscode.EventEmitter` singleton at module load, which broke a sibling test that loads the provider with a bare `vscode` mock. Same indirection `open-issue-by-id.ts` already uses.

## How to Test Locally

- **View diff**: VS Code sidebar → right-click builder `pir-1412` → **Review Diff**
- **Run dev**: VS Code sidebar → **Run Dev**, or `afx dev pir-1412`
- **What to verify** (in an architect/builder terminal on this workspace):
  - Cmd+click `#1412` → in-editor issue preview (default `editor`)
  - Cmd+click `PR #1405` → browser opens `.../pull/1405`
  - Cmd+click a bare number that is actually a PR (e.g. `#1405`) → browser opens the PR page (fallthrough)
  - Set `codev.terminalLinks.issueTarget: browser`, Cmd+click `#1412` → browser opens the issue
  - Cmd+click a nonexistent number → warning toast (no silent fallthrough to workspace search)
  - A line with two refs (e.g. `see #12 and PR #34`) → both are individually clickable
  - Each click shows a "Codev: Opening #N…" status-bar spinner immediately
