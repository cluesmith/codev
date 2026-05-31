# pir-925 thread — vscode builder Quick Pick: show issue # + title

## Plan phase

Investigated the two outlier pickers. **Key finding: the issue's literal fix does not compile.**

- The issue claims both outliers read `getWorkspaceState`, "the same endpoint the seven correct pickers use." Wrong on two counts:
  - The **seven correct pickers all use `client.getOverview`** → `OverviewBuilder` (has `issueId`/`issueTitle`/`phase`).
  - The **two outliers use `client.getWorkspaceState`** → `Builder` (`api.ts:25-46`), which has **no `issueId`/`issueTitle`**. `b.issueId` there is a TS error.
- The outliers also depend on `Builder.terminalId` + `Builder.id` (not on `OverviewBuilder`), so they can't just swap wholesale to `getOverview`.
- Precedent for "picker needs both": `run-worktree-dev.ts:29,53` — `getOverview` primary + `resolveAgentName(overviewId, workspaceBuilders)` join (ids differ in shape; tail-match, not `===`).

**Approach**: extract a pure `buildBuilderPickRows(overviewBuilders, workspaceBuilders)` helper (mirrors the `prune-builder-terminals.ts` pure-helper precedent), used by both call sites. `getOverview` for the label, joined to `getWorkspaceState` for `terminalId`/canonical `id`/`name`. Action path fed from the workspace `Builder` exactly as today (zero downstream change). Terminal tab title preserved as `Codev: <name>`.

Plan written to `codev/plans/925-vscode-open-builder-terminal-a.md`. Awaiting `plan-approval`.

## Implement phase

plan-approval approved. Implemented:
- `builder-pick-rows.ts` (new) — pure `buildBuilderPickRows(overviewBuilders, workspaceBuilders)` joining overview→workspace via `resolveAgentName`, filtering to live-terminal builders, formatting `#<id> <title>` + phase.
- `extension.ts` openBuilderTerminal + `send.ts` — both now `Promise.all([getOverview, getWorkspaceState])`, build rows via the helper. Action path unchanged (workspace `Builder.id`/`terminalId`); terminal tab title preserved as `Codev: <name>`.
- `builder-pick-rows.test.ts` (new) — 6 unit tests (happy path, tail-match join, issueId fallback, no-terminal exclude, no-match exclude, mixed list).

Env note: worktree shipped without `node_modules` and without `codev-core`/`codev-types` `dist/`. Ran `pnpm install`, built core + types — needed for vitest subpath resolution and esbuild. (Not a code change; flag for Lessons.)

Checks: tsc ✓, eslint ✓, esbuild ✓, vitest 119/119 ✓. Awaiting `dev-approval`.

## Review phase

dev-approval approved. Wrote `codev/reviews/925-…md`, opened PR #951, recorded with porch. 3-way consult (single pass): gemini=APPROVE, claude=APPROVE, codex=REQUEST_CHANGES. Codex's only finding: plan lacked approved-plan YAML frontmatter (impl itself confirmed sound). Fixed by adding `approved:/validated:` frontmatter (matches #927 precedent); wrote rebuttal doc; escalated to architect. `pr` gate fired.

## Complete

Architect approved pr gate + explicitly cleared `--admin` merge (branch protection: REVIEW_REQUIRED + CI pending). PR #951 merged 2026-05-31. `porch done --merged 951` recorded. Issue #925 auto-closes via `Fixes #925`. Architect handling vscode CHANGELOG + UNRELEASED.md post-merge. Ready for cleanup.
