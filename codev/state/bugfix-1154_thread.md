# Builder thread — bugfix-1154

## Investigate

Issue #1154: `vscode:prepublish` in `packages/vscode/package.json` builds only
`@cluesmith/codev-core` and `@cluesmith/codev-types`, missing
`@cluesmith/codev-artifact-canvas` (a third `workspace:*` dep genuinely imported
by the markdown-preview webview at `src/markdown-preview/webview/main.ts:34-35`).

Reproduction in this worktree (fresh, no dists built):
- `pnpm --filter codev-vscode run check-types` fails with TS2307 on
  `@cluesmith/codev-core/*` subpath imports (no .d.ts emitted yet) — confirms
  the fresh-clone failure class.
- Next step: build core+types only (what the current prepublish filter does),
  re-run check-types, expect the surviving error to be the artifact-canvas
  TS2307 — that isolates the exact bug.

Planned fix (per issue, future-proof flavor): switch the prepublish filter to
pnpm's topological form `pnpm --filter 'codev-vscode^...' build`, which builds
all workspace deps of codev-vscode transitively.

Investigation results:
- Reproduced: with no dists built, check-types fails on codev-core subpath
  imports; after building core+types only (the old prepublish set), the
  surviving error is exactly `TS2307: Cannot find module
  '@cluesmith/codev-artifact-canvas'` at main.ts:34. Bug isolated.
- Confirmed `pnpm --filter 'codev-vscode^...'` selects exactly
  {artifact-canvas, types, core} and artifact-canvas has a tsup build script.

## Fix

- `packages/vscode/package.json`: `vscode:prepublish` now uses
  `pnpm --filter 'codev-vscode^...' build && pnpm package`.
- Verified from fresh-clone state (all three dists removed): the new dep
  build emits all dists and `check-types` passes both tsc passes.
- Regression test `src/__tests__/prepublish-workspace-deps.test.ts`:
  accepts the topological filter form; if the script reverts to an explicit
  `--filter` list, asserts the list covers every `workspace:*` dep.
  Verified red without the fix, green with it.

## PR

- Porch fix-phase checks passed (build 5.9s, tests 20.6s).
- PR #1155 opened with Summary / Root Cause / Fix / Test Plan, `Fixes #1154`.
- CMAP (3-way, `--issue 1154`): gemini=APPROVE, codex=APPROVE, claude=APPROVE,
  all HIGH confidence, no key issues raised.
- Requested `pr` gate via `porch done`; waiting on human approval.
