# Phase 9 (arrange_cockpit), iteration 1 — responses

Reviews: codex REQUEST_CHANGES, claude APPROVE. The changes are in the commit that follows
`92846a4d5`.

## Codex: the architect's tab is identified by its name, which is not unique — accepted, fixed

Codex is right that a second terminal named `Codev: Architect` breaks arrange. A renamed
terminal, or a shell that sets its title, can carry that name. Arrange would then take the
namesake's tab for the architect's: if the namesake sat in the left group, arrange would think the
architect was already in place, skip moving the real one, and report success.

The suggested fix (activate the known terminal and track which tab becomes active) does not work
in every case arrange handles:
- `Terminal.show()` on a terminal in the **panel** leaves the editor area's active tab as it was, so
  there is nothing to track until `terminal.moveToEditor` has already run;
- the tab model gives a terminal tab no identity (`TabInputTerminal` has no fields), so even an
  activated tab cannot be matched to a `vscode.Terminal` except by label.

What *is* reliable is `vscode.window.terminals`. Its `Terminal.name` follows renames and title
changes: in the 1.147.0 extension host, `$acceptTerminalTitleChange(id, name)` sets
`terminal.name = name`. So the label is unambiguous exactly when no other terminal has the
architect's name, and arrange can check that.

- **Fix (`cockpit/arrange.ts`, `placeArchitect`).** After resolving `main`'s terminal and before
  moving any editor, arrange checks whether another terminal has its name. If one does, it stops
  with *"another terminal is also named "Codev: Architect", so the architect's tab cannot be told
  apart from it; rename or close that terminal and arrange again."* Failing loudly follows the
  project's fail-fast rule; guessing which tab is the architect's would move a terminal arrange
  cannot tell apart. The module comment explains why the tab is found by label.
- **Test (`cockpit-arrange.test.ts`).** A namesake terminal in the left group and the real
  architect in the panel, the exact case where label matching would succeed falsely. Arrange
  resolves `false` with that message, the editor area is unchanged, and no command ran. The fake's
  `vscode.window.terminals` lists every terminal in the editor area and the panel.
- **Docs.** The README's *Arrange Cockpit* section and the arch.md entry both cover it.

## Claude (approved) — notes

1. **An unsolicited error toast when the automatic arrange runs with Tower down — taken.**
   `readArchitectRoster` was written for the user-invoked *Open Architect Terminal*. Its error
   toasts are right there but wrong for an arrange nobody asked for. It now takes `quiet`: the
   automatic arrange (`CockpitArranger.arrange('auto')`) reads quietly and logs
   *"Codev: Not connected to Tower (the architect was not placed)"* to the output channel. The
   command and *Open Architect Terminal* keep the toast. The right side is still arranged, as with
   a non-live `main`. Tests:
   - in `cockpit-arrange.test.ts`, the auto trigger reads the roster with `quiet` true and the
     command with false;
   - in `contributes-cockpit.test.ts`, the automatic wiring uses `'auto'`, and the quiet branch
     logs.

2. **The `keepLeftColumn` branch is tested on the fake only — noted in the PR.** That branch runs
   only when no architect is placed *and* group 1 holds nothing but the Cockpit's own panels. The
   rendered `main`-not-live check had other editors in group 1. If VS Code closed the new empty
   group, the result would be the bounded timeout error, not a wrong layout. I took the
   reviewer's second option: the PR says this branch is unit-tested only. A rendered check would
   need a new verify scenario plus a fresh harness start and seed. I'll add one if the architect
   wants it.

3. **The tab matched by label — covered by the codex fix above.** Documented in the module
   comment, and now also guarded.

4. **`settle` polls at 25 ms — kept.** There are at most about eight waits per arrange, each
   bounded at 5 s, and most finish in one or two polls. An event-driven wait would need a
   subscription per condition, and some conditions (a panel's `viewColumn`, the active terminal)
   do not change with a single event. Polling keeps every wait the same shape. No change.
