# PIR #933 — VSCode Builders tree: inline gate-action icon

## Restart (2026-06-02) — icon-only

**History reset.** An earlier iteration implemented a per-gate *action* dispatcher
(inline button opened the plan / ran dev / approved depending on gate). The
architect judged the action-change to be scope creep — the issue only calls for
an icon change — and directed a clean restart.

Done:
- `git reset --hard fcea5028` (pristine porch-init commit) → porch back in the
  **plan** phase; all prior plan/implement commits removed.
- `git push --force-with-lease` → remote branch cleaned to fcea5028.
- GitHub issue #933 realigned to **icon-only** scope (per-gate action behavior
  moved to explicit Out-of-scope; acceptance simplified).

**Scope now:** one-line change — swap `codev.approveGate`'s declared icon from
`$(check)` to `$(arrow-right)` in `packages/vscode/package.json`. Action/behavior
unchanged; only the inline button glyph. The row's leading icon is already
gate-specific (gateIconFor) and untouched.

Plan rewritten → `codev/plans/933-afx-tower-ui-gate-action-butto.md`. Awaiting
`plan-approval`.
