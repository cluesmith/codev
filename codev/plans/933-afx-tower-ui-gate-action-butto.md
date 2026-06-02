# PIR Plan: Neutral inline gate-action icon (icon-only)

> Issue [#933](https://github.com/cluesmith/codev/issues/933). Scope: **VSCode extension**, **icon-only**. An earlier iteration of this work (per-gate action dispatch) was reverted at the architect's direction as scope creep; the branch was reset to the pristine init commit. This plan covers only the icon swap.

## Understanding

In the VSCode **Builders** tree, each *blocked* builder row shows an inline action button bound to `codev.approveGate`. That command declares a static checkmark icon in `packages/vscode/package.json`:

```json
{ "command": "codev.approveGate", "title": "Codev: Approve Gate", "icon": "$(check)" }
```

The inline button's icon comes from this static command declaration (VSCode renders a menu action's icon from the command, not from the tree item — there is no per-row override). So every blocked builder shows the same ✓, which reads as the specific promise "approve" rather than a neutral "this row wants your attention."

The row's **leading** icon is already gate-specific (`gateIconFor`/`GATE_ICONS` in `builder-row.ts`), so per-gate triage already exists and is **not** touched here.

## Proposed Change

Change the `codev.approveGate` command's `icon` from `$(check)` to `$(arrow-right)` (→) — a neutral "act on this row" glyph (architect-confirmed). The button's **command and behavior are unchanged**: clicking it still opens the existing approve confirmation flow.

This is a one-line, declarative change. Because `codev.approveGate`'s icon only renders in the inline menu (context-menu entries render the command *title*, and the gate-pending toast uses its own button labels — neither uses the command icon), the swap affects only the inline button. No code, no `contextValue`, no `when`-clauses, no new commands.

## Files to Change

- `packages/vscode/package.json` — in `contributes.commands`, change the `codev.approveGate` entry's `"icon": "$(check)"` to `"icon": "$(arrow-right)"`. (One line.)

## Risks & Alternatives Considered

- **Risk — the icon also renders somewhere unexpected.** *Mitigation:* `codev.approveGate` is used in (a) the inline `blocked-builder` menu (icon shown), (b) the `1_primary@2` context-menu entry (title shown, not icon), and (c) the gate-pending toast's `Approve` button (its own label, not the command icon). Only (a) renders the icon, so this is the sole visible effect. Verified by grepping the menu/command/toast wiring.
- **Risk — a neutral arrow under an "approve" action is itself slightly ambiguous.** Accepted: the issue's goal is specifically to stop the ✓ from over-promising "approve"; the leading per-gate row icon carries the state meaning. (The architect chose icon-only over varying the action.)
- **Alternative — per-gate inline icons / per-gate actions.** Rejected (explicitly de-scoped): both require encoding the gate in `contextValue` plus multiple commands or a dispatcher — behavior/machinery beyond an icon change.
- **No new automated test.** This is a single declarative icon string; the existing `contributes-commands` test already loads and validates `package.json`. Adding a test that pins one icon literal would be low-value churn against the "minimal" intent. (Open to adding a one-line assertion if the reviewer prefers.)

## Test Plan

**Build:** `pnpm --filter codev-vscode check-types` and `lint` pass (no code changed; package.json must remain valid JSON). Porch's `build`/`tests` checks pass.

**Manual (at the `dev-approval` gate — load the extension via the Extension Development Host):**
- A blocked builder's inline action button shows **→**, not **✓**.
- Clicking it still opens the approve confirmation (behavior unchanged).
- The right-click "Approve Gate" entry and **Cmd+K G** still work.
- The gate-pending toast's buttons are unchanged.

**Cross-platform:** codicons render identically across OSes; no platform-specific concerns.
