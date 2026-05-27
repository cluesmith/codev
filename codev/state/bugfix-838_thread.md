# bugfix-838 — duplicate / debug-looking command titles

## Investigation

Issue #838: three `contributes.commands` in `packages/vscode/package.json`
render badly on the Feature Contributions tab:

- `codev.openBuilderTerminal` (visible) and `codev.openBuilderById`
  (palette-hidden via `when:false`) both had title
  `"Codev: Open Builder Terminal"` — two indistinguishable lines.
- `codev.openBuilderRow` (palette-hidden) had
  `"Codev: Open Builder Terminal (and expand row)"` — reads like a debug
  note.

Feature Contributions tab lists every declared command regardless of
`commandPalette` `when:false`, so palette-hidden commands surface there too.

## Fix

Adopted the issue's suggested `Codev (internal): …` prefix for the two
palette-hidden commands so anyone reading the contributions list can
distinguish user-callable from internal at a glance:

- `codev.openBuilderById` → `Codev (internal): Open Builder Terminal by ID`
- `codev.openBuilderRow`  → `Codev (internal): Open Builder Terminal and Expand Row`

`codev.openBuilderTerminal` (the user-callable one) keeps its existing title.

## Regression test

Added `packages/vscode/src/__tests__/contributes-commands.test.ts`:

1. No two `contributes.commands` share a title.
2. No title contains the `(and ...)` debug-note pattern.

Both fail against pre-fix package.json (verified via `git stash`); both
pass after the fix.

## Scope

Single-file behavioral change + one new test file. ~6 lines net in
package.json, ~30 lines test. Well under BUGFIX's 300 LOC ceiling.
