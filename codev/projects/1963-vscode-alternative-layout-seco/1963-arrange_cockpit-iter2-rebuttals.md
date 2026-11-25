# Phase 9 (arrange_cockpit), iteration 2 — responses

Reviews: codex APPROVE (no issues), claude APPROVE with two non-blocking findings and a note.
Both findings were real, and are fixed in place in the commit after `3c5289f5f`. That fix landed
after these approvals, so the PR-level review is the first to see it. Each new test was run against
the previous `arrange.ts` and fails there.

## Claude 1: the namesake check can fire on a terminal VS Code is still closing — fixed

Correct. When the architect's session id is stale, `TerminalManager.openArchitect` disposes the old
terminal and opens a fresh one under the same name. In the 1.147.0 extension host,
`window.terminals` is `this._terminals.map(e => e.value)`, and a terminal leaves `_terminals` only
in `$acceptTerminalClosed`, a round trip to the renderer. In that window arrange would have refused
and told the user to rename or close a terminal that was already gone.

- **Fix (`placeArchitect`).** A namesake gets the same 5 s settle bound as every other wait to
  leave the list. Arrange refuses only if it is still there. `settle` is now built on a
  non-throwing `until(condition)`.
- **Tests.** A namesake that leaves after 200 ms is waited out: the arrange succeeds, places the
  architect, and shows no error. The genuine-namesake test now advances fake timers past the bound,
  and still asserts the unchanged area and that no command ran. Against the previous file, the new
  test fails with the false refusal.

## Claude 2: `keepLeftColumn` counts live panels, not panel tabs — fixed

Correct. Suppose no architect is placed and group 1 holds only a restored Work tab that VS Code has
not revived. That tab was counted as a user editor, so the left column was not kept. Then
`placePanel` opened Work in group 2 and closed the restored tab, which emptied and closed group 1.
Work was renumbered to group 1, and the arrange timed out.

- **Fix.** `CockpitPanel` gains `tabs`: every tab of the panel's kind, live or restored.
  `SinglePanel`'s former private `kindTabs()` becomes the public `tabs` getter. `keepLeftColumn`
  compares group 1's tab count with the Cockpit's tabs in it.
- **Test.** The fake can now hold a restored tab (`restoreIn`), and its `show()` mirrors
  `SinglePanel.show()`: it opens the new panel in the restored tab's group or at the placement, then
  closes the restored tab. With a restored Work tab alone in group 1 and no architect, arrange keeps
  the left column, creates Work once, and ends with empty | Work | Decisions. Against the previous
  file it fails with the 5 s timeout claude predicted.

## Disputed: "the fake opens every intermediate group, while VS Code falls back to `SIDE_GROUP`"

Not in the version this targets. In the VS Code 1.147.0 workbench bundle, the column-to-group
mapping is:

```js
function EA(s,o,e=Gr){ if(e===Gr||e===Qn||e===hS||e===lR)return e;
  let t=s.getGroups(2)[e];
  if(!t&&e<9){ for(let i=0;i<=e;i++){ let n=s.getGroups(2); n[i]||s.addGroup(n[i-1],Lw(o)) } t=s.getGroups(2)[e] }
  return t?.id??Qn }
```

For a column beyond the last group (below 9), it adds every missing group up to that column. Only
past that does it fall back to the side group. The fake's `groupAt()` models exactly this, and the
rendered harness runs (`verify arrange`, 15/15) exercised it in real VS Code.

## Claude 3: the catch toasts on the automatic trigger too — kept, deliberately

The quiet read covers an arrange that changed nothing (Tower down). An arrange that stops part-way
has moved editors, and the user needs to know why the layout is half done, whoever triggered it.
