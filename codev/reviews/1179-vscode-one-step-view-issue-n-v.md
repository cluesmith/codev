# PIR Review: One-step "view issue N" / "view pr N" QuickPick type-ahead + Cmd+K Shift+P Open-PR-by-ID

Fixes #1179

## Summary

Two additive VS Code navigation improvements sharing one code path. The backlog search
QuickPick now recognizes numeric input (`1350`, `#1350`, `issue 1350`, `view pr 1350`) and
prepends dynamic `View Issue #N` / `View PR #N` rows that fetch live and open in the
browser, reaching issues outside the loaded backlog (closed, claimed) and PRs in one
gesture. A new `codev.openPRById` command on `Cmd+K Shift+P` mirrors `codev.openIssueById`,
backed by a new forge-agnostic PR-fetch slice: the `pr-view` concept now emits the PR's
browser `url` on all three forges, surfaced through Tower's new `GET /api/pr`, a `PRView`
wire type, and `TowerClient.getPR`.

## Files Changed

- `apps/vscode/package.json` (+9 / -0) — command declaration + `ctrl+k shift+p` / `cmd+k shift+p`
- `apps/vscode/src/__tests__/backlog-search.test.ts` (+78 / -1) — grammar table
- `apps/vscode/src/__tests__/open-pr-by-id.test.ts` (+95 / -0) — new
- `apps/vscode/src/__tests__/search-backlog-quickpick.test.ts` (+148 / -0) — new
- `apps/vscode/src/commands/open-issue-by-id.ts` (+30 / -13) — extract `openIssueInBrowser`
- `apps/vscode/src/commands/open-pr-by-id.ts` (+67 / -0) — new
- `apps/vscode/src/commands/search-backlog.ts` (+64 / -11) — `createQuickPick` + dynamic rows
- `apps/vscode/src/extension.ts` (+3 / -1) — register `codev.openPRById`
- `apps/vscode/src/views/backlog-search.ts` (+67 / -0) — type-ahead grammar helpers
- `packages/codev/scripts/forge/github/pr-view.sh` (+1 / -1) — add `url` to `--json`
- `packages/codev/scripts/forge/gitlab/pr-view.sh` (+4 / -1) — map `web_url` → `url`
- `packages/codev/scripts/forge/gitea/pr-view.sh` (+4 / -1) — map `html_url` → `url`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+30 / -0) — `GET /api/pr`
- `packages/codev/src/lib/forge-contracts.ts` (+9 / -0) — `PrViewResult.url?`
- `packages/codev/src/lib/github.ts` (+23 / -2) — `fetchPR`
- `packages/sdk/src/tower-client.ts` (+14 / -1) — `getPR`
- `packages/sdk/src/__tests__/tower-client.test.ts` (+13 / -0) — `getPR` tests
- `packages/types/src/api.ts` (+27 / -0) — `PRView` wire type
- `packages/types/src/index.ts` (+1 / -0) — export
- `codev/plans/1179-vscode-one-step-view-issue-n-v.md` (+201 / -0), thread log, porch state

## Commits

- `55451226f` [PIR #1179] PR-fetch plumbing: pr-view url, fetchPR, GET /api/pr, PRView, TowerClient.getPR
- `0689c8248` [PIR #1179] codev.openPRById command + Cmd+K P keybinding
- `5608aa1cd` [PIR #1179] Backlog QuickPick type-ahead: dynamic View Issue/PR #N rows
- `3d50408d0` [PIR #1179] Thread log: implement phase notes
- `2a747cb52` [PIR #1179] dev-approval feedback: rename dynamic-row discriminator kind -> target (QuickPickItem reserves kind)
- (plus `9c5ced324` plan draft and porch `chore(porch)` bookkeeping commits)

## Test Results

- Build: extension `pnpm compile` (tsc + eslint + esbuild) ✓; `tsc --noEmit` verified
  directly after the `kind`→`target` fix; porch `build` check ✓
- Tests: vscode vitest 777/777 (26 new across three files); codev 4786 passed / 48
  pre-existing skips / 0 failed; sdk 75/75 (2 new `getPR` tests); porch `tests` check ✓
- Manual verification (human, dev-approval gate): ran the Extension Development Host,
  exercised the Command Palette and QuickPick flows; caught a real `tsc` error my piped
  compile run had masked (see Lessons)
- Real-forge check: `CODEV_PR_NUMBER=1398 sh packages/codev/scripts/forge/github/pr-view.sh`
  returns title/url/state from GitHub

## Architecture Updates

No arch changes — `GET /api/pr` / `TowerClient.getPR` / `fetchPR` deliberately mirror the
already-documented `GET /api/issue` / `getIssue` / `fetchIssue` pattern (arch.md's forge
section documents the concept mechanism generically and already lists `pr-view` among the
15 concepts; it doesn't enumerate per-concept output fields or individual Tower routes).

## Lessons Learned Updates

- **COLD `lessons-learned.md` (UI/UX)**: `vscode.QuickPickItem` reserves `kind`
  (`QuickPickItemKind` separators) — a custom discriminator named `kind` on a QuickPick
  item type fails the `createQuickPick<T extends QuickPickItem>` constraint; use a
  domain name like `target`. Plus: dynamic rows injected via `onDidChangeValue` need
  `alwaysShow: true` to survive the fuzzy filter.
- **Re-confirmed, not re-added**: existing lesson [From #1150] (piping a build through
  `tail` reports the filter's exit code) bit again in this project — my background
  `pnpm compile 2>&1 | tail -6` reported success while `tsc` was failing on the `kind`
  collision; the human reviewer caught it at the gate. The lesson already exists; noting
  the recurrence here rather than duplicating it.

## Things to Look At During PR Review

- **Consultation finding (Claude, REQUEST_CHANGES — confirmed, RESOLVED by rebind):** the
  originally planned `Ctrl+K P` / `Cmd+K P` shadowed a VS Code built-in. The issue said
  "verified P slot is free," but that verification (plan's included) only covered the
  extension's own keybindings map; VS Code registers
  `workbench.action.files.copyPathOfActiveFile` on exactly that chord (weight 200, no
  `when` clause — confirmed in the bundled `workbench.desktop.main.js`), and
  extension-contributed keybindings outrank workbench ones. **Resolution (human decision
  at the pr gate): rebound to `Ctrl+K Shift+P` / `Cmd+K Shift+P`** — verified free across
  the core workbench chord table (no shift-modified KeyP chord exists), built-in
  extensions, and our own map, and it keeps the P-for-PR mnemonic the issue intended.
  (PIR consultation is single-pass; the rebind itself was verified by the human reviewer,
  not re-reviewed by the models.)
- Consultation minor (Claude, non-blocking): in `search-backlog.ts` the async browser-open
  helpers are invoked bare inside the sync `onDidAccept` callback, so an `openExternal`
  rejection would be an unhandled rejection. Left as-is per house style (bare
  fire-and-forget calls); both helpers handle their real failure modes (not connected /
  not found) internally with toasts.
- `search-backlog.ts` accept-routing: dynamic rows are discriminated by `'target' in picked`
  — static `BacklogQuickPickItem` rows never carry `target`, so the check is sound, but
  it's the one structural assumption tying the two item shapes together.
- A bare number offers **both** `View Issue #N` and `View PR #N` (ambiguous input);
  explicit `issue N` / `pr N` forms narrow to one. `1350 fix` (trailing text) deliberately
  yields no dynamic rows.
- PR-not-found and PR-without-url both surface the same warning toast — there's no
  in-editor PR preview to degrade to (unlike the issue path's `viewBacklogIssue` fallback).
- The gitlab/gitea `pr-view.sh` scripts gained a `jq` dependency (mirroring their
  `issue-view.sh` siblings, which already use it). GitHub's script (the default) does not.
- Per plan, the empty-backlog early-return is unchanged: type-ahead requires at least one
  loaded backlog row. Flagged in the plan as a deliberate scope cut.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1179 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1179`
- **What to verify** (maps to the plan's Test Plan / issue acceptance):
  - Q1a: backlog search picker, type `1350` → `View Issue #1350` + `View PR #1350` on top;
    Enter on the first opens the issue in the browser
  - Q1b: type `view pr 1350` → `View PR #1350` on top; Enter opens the PR in the browser
  - Q1c: type `tower` → normal filtering, no dynamic rows
  - Q2a: `Cmd+K Shift+P` → InputBox; `1398` + Enter opens PR #1398 in the browser
  - Regression: `Cmd+K P` (unshifted) still runs the built-in Copy Path of Active File
  - Q2b: non-numeric input → validation message
  - Q2c: `999999` → warning toast, no crash
  - Regression: `Cmd+K I` unchanged; backlog row Enter still opens the in-editor preview
